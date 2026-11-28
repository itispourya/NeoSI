import type { ModelRecord } from '../db/schema.ts';
import type { CircuitBreakerState, CircuitBreakerStatus, RuntimeKind } from './types.ts';

export class RetryableHttpError extends Error {
  public readonly statusCode: number;
  public readonly retryAfterMs?: number;
  constructor(message: string, statusCode: number, retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableHttpError';
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

export function parseRetryAfterMs(headerVal: string | null): number | undefined {
  if (!headerVal) return undefined;
  const trimmed = headerVal.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.round(seconds * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.min(60_000, Math.max(0, dateMs - Date.now()));
  }
  return undefined;
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof RetryableHttpError) {
    return err.statusCode === 429 || err.statusCode >= 500 || err.statusCode === 408;
  }
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (/\b(HTTP 400|HTTP 401|HTTP 403|HTTP 404|HTTP 422)\b/i.test(msg)) return false;
  if (/\b(aborted|cancelled|canceled)\b/i.test(msg) && !/timeout/i.test(msg)) return false;
  return /\b(429|500|502|503|504|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|network|fetch failed|timeout|socket)\b/i.test(msg);
}

export async function withRetryAndBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 150;
  const maxDelayMs = opts.maxDelayMs ?? 5000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw new DOMException('Inference aborted by caller', 'AbortError');
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !isTransientError(err)) {
        throw err;
      }
      const retryAfter = err instanceof RetryableHttpError ? err.retryAfterMs : undefined;
      const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
      const jitterDelay = Math.round(expDelay * (0.5 + Math.random() * 0.5));
      const waitMs = Math.min(maxDelayMs, Math.max(jitterDelay, retryAfter ?? 0));
      await sleepWithAbort(waitMs, opts.signal);
    }
  }
  throw lastError;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface BreakerInternal {
  state: CircuitBreakerState;
  failures: number;
  successes: number;
  lastFailureAt: string | null;
  openedAtMs: number | null;
  lastError: string | null;
}

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, BreakerInternal>();
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(failureThreshold = 3, resetTimeoutMs = 20_000) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
  }

  private getOrCreate(key: RuntimeKind | string): BreakerInternal {
    let entry = this.breakers.get(key);
    if (!entry) {
      entry = {
        state: 'closed',
        failures: 0,
        successes: 0,
        lastFailureAt: null,
        openedAtMs: null,
        lastError: null,
      };
      this.breakers.set(key, entry);
    }
    return entry;
  }

  canExecute(key: RuntimeKind | string): boolean {
    if (key === 'embedded') return true;
    const entry = this.getOrCreate(key);
    if (entry.state === 'closed') return true;
    if (entry.state === 'open' && entry.openedAtMs !== null) {
      if (Date.now() - entry.openedAtMs >= this.resetTimeoutMs) {
        entry.state = 'half_open';
        return true;
      }
      return false;
    }
    return entry.state === 'half_open';
  }

  recordSuccess(key: RuntimeKind | string): void {
    const entry = this.getOrCreate(key);
    entry.state = 'closed';
    entry.failures = 0;
    entry.successes += 1;
    entry.openedAtMs = null;
    entry.lastError = null;
  }

  recordFailure(key: RuntimeKind | string, errorMessage: string): void {
    if (key === 'embedded') return;
    const entry = this.getOrCreate(key);
    entry.failures += 1;
    entry.lastFailureAt = new Date().toISOString();
    entry.lastError = errorMessage.slice(0, 240);
    if (entry.state === 'half_open' || entry.failures >= this.failureThreshold) {
      entry.state = 'open';
      entry.openedAtMs = Date.now();
    }
  }

  reset(key?: RuntimeKind | string): void {
    if (key) {
      this.breakers.delete(key);
    } else {
      this.breakers.clear();
    }
  }

  snapshot(): CircuitBreakerStatus[] {
    const out: CircuitBreakerStatus[] = [];
    for (const [runtime, entry] of this.breakers.entries()) {
      // Refresh open -> half_open transition lazily for display accuracy
      if (entry.state === 'open' && entry.openedAtMs !== null && Date.now() - entry.openedAtMs >= this.resetTimeoutMs) {
        entry.state = 'half_open';
      }
      out.push({
        runtime: runtime as RuntimeKind,
        state: entry.state,
        failures: entry.failures,
        successes: entry.successes,
        lastFailureAt: entry.lastFailureAt,
        nextRetryAt: entry.openedAtMs ? new Date(entry.openedAtMs + this.resetTimeoutMs).toISOString() : null,
        lastError: entry.lastError,
      });
    }
    return out;
  }
}

export function estimateTokensRough(text: string): number {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

export function estimateInferenceCostUsd(
  model: ModelRecord | null | undefined,
  promptTokens: number,
  completionTokens: number
): number {
  if (!model || model.runtime === 'embedded') return 0;
  const inRate = Number(model.performance_metrics?.costPer1kInputUsd || 0);
  const outRate = Number(model.performance_metrics?.costPer1kOutputUsd || 0);
  if (inRate <= 0 && outRate <= 0) return 0;
  return Number((((promptTokens / 1000) * inRate) + ((completionTokens / 1000) * outRate)).toFixed(6));
}

export function trimPromptToContextWindow(
  systemInstruction: string | undefined,
  prompt: string,
  maxContextTokens = 8192,
  reserveOutputTokens = 1024
): { systemInstruction?: string; prompt: string; trimmed: boolean } {
  const safeBudgetTokens = Math.max(512, maxContextTokens - reserveOutputTokens);
  const sysTokens = systemInstruction ? estimateTokensRough(systemInstruction) : 0;
  const remainingTokens = Math.max(384, safeBudgetTokens - sysTokens);
  const maxPromptChars = remainingTokens * 4;

  if (prompt.length <= maxPromptChars) {
    return { systemInstruction, prompt, trimmed: false };
  }

  // Preserve the leading instruction/context header and the trailing User Request
  const headChars = Math.floor(maxPromptChars * 0.35);
  const tailChars = Math.floor(maxPromptChars * 0.6);
  const compressed = `${prompt.slice(0, headChars)}\n\n[... middle context compressed to fit ${maxContextTokens}-token window ...]\n\n${prompt.slice(-tailChars)}`;
  return {
    systemInstruction: systemInstruction?.slice(0, Math.max(512, Math.floor(safeBudgetTokens * 0.3) * 4)),
    prompt: compressed,
    trimmed: true,
  };
}
