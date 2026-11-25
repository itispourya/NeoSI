import { GoogleGenAI, ThinkingLevel, type GenerateContentResponse } from '@google/genai';
import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import { deterministicTextEmbedding } from '../db/vector.ts';

export type LlmProviderName = 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'ollama';

export interface LlmRequest {
  prompt: string;
  systemInstruction?: string;
  taskType?: string;
  tenantId?: string;
  preferredProvider?: LlmProviderName;
  preferredModel?: string;
  responseMimeType?: 'application/json' | 'text/plain';
  thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  useSearchGrounding?: boolean;
}

export interface LlmResponse {
  text: string;
  provider: LlmProviderName;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  groundingSources?: Array<{ title: string; url: string }>;
}

const COST_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gemini-4-hydrogen': { input: 0.1, output: 0.4 },
  'gemini-3.1-flash-lite': { input: 0.05, output: 0.2 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-3-5-sonnet-latest': { input: 3.0, output: 15.0 },
  'google/gemini-2.5-flash': { input: 0.15, output: 0.6 },
  'llama3.2': { input: 0, output: 0 },
};

export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const rate = COST_PER_1M_TOKENS[model] || { input: 0.15, output: 0.6 };
  const cost = (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output;
  return Number(cost.toFixed(6));
}

function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

let geminiClient: GoogleGenAI | null = null;
export function getGeminiClient(): GoogleGenAI | null {
  if (!env.geminiApiKey || env.geminiApiKey === 'MY_GEMINI_API_KEY') return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey: env.geminiApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return geminiClient;
}

export function getProviderPriorityOrder(preferred?: LlmProviderName): LlmProviderName[] {
  if (env.neoLocalOnly) {
    return env.neoInferenceUrl || env.ollamaBaseUrl ? ['ollama'] : [];
  }
  const available: LlmProviderName[] = [];
  if (env.neoInferenceUrl || env.ollamaBaseUrl) available.push('ollama');
  if (env.geminiApiKey && env.geminiApiKey !== 'MY_GEMINI_API_KEY') available.push('gemini');
  if (env.openaiApiKey) available.push('openai');
  if (env.anthropicApiKey) available.push('anthropic');
  if (env.openrouterApiKey) available.push('openrouter');

  if (preferred && available.includes(preferred)) {
    return [preferred, ...available.filter((p) => p !== preferred)];
  }
  return available;
}

async function callGemini(req: LlmRequest): Promise<LlmResponse> {
  const ai = getGeminiClient();
  if (!ai) throw new Error('GEMINI_API_KEY is not configured');

  const model = req.preferredModel && req.preferredProvider === 'gemini' ? req.preferredModel : 'gemini-4-hydrogen';
  const start = Date.now();
  const thinkingMap: Record<string, ThinkingLevel> = {
    LOW: ThinkingLevel.LOW,
    MEDIUM: ThinkingLevel.MEDIUM,
    HIGH: ThinkingLevel.HIGH,
  };

  const config: Record<string, unknown> = {};
  if (req.systemInstruction) config.systemInstruction = req.systemInstruction;
  if (req.responseMimeType && !req.useSearchGrounding) config.responseMimeType = req.responseMimeType;
  if (req.thinkingLevel && thinkingMap[req.thinkingLevel]) {
    config.thinkingConfig = { thinkingLevel: thinkingMap[req.thinkingLevel] };
  }
  if (req.useSearchGrounding) {
    config.tools = [{ googleSearch: {} }];
  }

  const response: GenerateContentResponse = await ai.models.generateContent({
    model,
    contents: req.prompt,
    config,
  });

  const text = response.text ?? '';
  const usage = response.usageMetadata;
  const promptTokens = usage?.promptTokenCount ?? estimateTokenCount(req.prompt + (req.systemInstruction || ''));
  const completionTokens = usage?.candidatesTokenCount ?? estimateTokenCount(text);
  const latencyMs = Date.now() - start;

  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks as
    | Array<{ web?: { uri?: string; title?: string } }>
    | undefined;
  const groundingSources = (chunks || [])
    .filter((c) => c.web?.uri)
    .map((c) => ({ title: c.web?.title || c.web?.uri || 'Source', url: c.web!.uri! }));

  return {
    text,
    provider: 'gemini',
    model,
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimateCostUsd(model, promptTokens, completionTokens),
    latencyMs,
    groundingSources: groundingSources.length ? groundingSources : undefined,
  };
}

async function callOpenAiCompatible(
  provider: 'openai' | 'openrouter' | 'ollama',
  endpoint: string,
  apiKey: string | undefined,
  model: string,
  req: LlmRequest
): Promise<LlmResponse> {
  const start = Date.now();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const messages = [
    ...(req.systemInstruction ? [{ role: 'system', content: req.systemInstruction }] : []),
    { role: 'user', content: req.prompt },
  ];
  const body: Record<string, unknown> = { model, messages };
  if (req.responseMimeType === 'application/json' && provider !== 'ollama') {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  if (!res.ok) {
    throw new Error(`${provider} returned HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  const promptTokens = data.usage?.prompt_tokens ?? estimateTokenCount(req.prompt);
  const completionTokens = data.usage?.completion_tokens ?? estimateTokenCount(text);
  return {
    text,
    provider,
    model,
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimateCostUsd(model, promptTokens, completionTokens),
    latencyMs: Date.now() - start,
  };
}

async function callAnthropic(req: LlmRequest): Promise<LlmResponse> {
  if (!env.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const start = Date.now();
  const model = 'claude-3-5-sonnet-latest';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: req.systemInstruction,
      messages: [{ role: 'user', content: req.prompt }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`anthropic returned HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as {
    content?: Array<{ text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = data.content?.map((c) => c.text || '').join('') ?? '';
  const promptTokens = data.usage?.input_tokens ?? estimateTokenCount(req.prompt);
  const completionTokens = data.usage?.output_tokens ?? estimateTokenCount(text);
  return {
    text,
    provider: 'anthropic',
    model,
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimateCostUsd(model, promptTokens, completionTokens),
    latencyMs: Date.now() - start,
  };
}

export async function routeLlmCall(req: LlmRequest): Promise<LlmResponse> {
  const order = getProviderPriorityOrder(req.preferredProvider);
  if (order.length === 0) {
    throw new Error('No LLM provider configured. Set GEMINI_API_KEY (or OPENAI/ANTHROPIC/OPENROUTER/OLLAMA) in Secrets.');
  }

  const db = await getDb();
  const errors: string[] = [];

  for (const provider of order) {
    const start = Date.now();
    try {
      let res: LlmResponse;
      if (provider === 'gemini') {
        res = await callGemini(req);
      } else if (provider === 'openai') {
        res = await callOpenAiCompatible('openai', 'https://api.openai.com/v1/chat/completions', env.openaiApiKey, 'gpt-4o-mini', req);
      } else if (provider === 'openrouter') {
        res = await callOpenAiCompatible('openrouter', 'https://openrouter.ai/api/v1/chat/completions', env.openrouterApiKey, 'google/gemini-2.5-flash', req);
      } else if (provider === 'ollama') {
        const base = (env.neoInferenceUrl || env.ollamaBaseUrl || 'http://localhost:11434').replace(/\/+$/, '');
        res = await callOpenAiCompatible('ollama', `${base}/v1/chat/completions`, undefined, env.neoInferenceModel, req);
      } else {
        res = await callAnthropic(req);
      }

      const telemetryProvider = provider === 'ollama' ? 'neo-local-inference' : 'neo-neural-core';
      const telemetryModel = provider === 'ollama' ? env.neoInferenceModel : 'neo-neural-4';

      await db.recordTelemetry({
        tenant_id: req.tenantId || 'global',
        provider: telemetryProvider,
        model: telemetryModel,
        task_type: req.taskType || 'general',
        prompt_tokens: res.promptTokens,
        completion_tokens: res.completionTokens,
        estimated_cost_usd: res.estimatedCostUsd,
        latency_ms: res.latencyMs,
        success: true,
        error_message: null,
      });

      return { ...res, model: telemetryModel };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${provider}: ${msg}`);
      await db.recordTelemetry({
        tenant_id: req.tenantId || 'global',
        provider,
        model: req.preferredModel || provider,
        task_type: req.taskType || 'general',
        prompt_tokens: estimateTokenCount(req.prompt),
        completion_tokens: 0,
        estimated_cost_usd: 0,
        latency_ms: Date.now() - start,
        success: false,
        error_message: msg,
      });
    }
  }

  throw new Error(`All configured LLM providers failed: ${errors.join(' | ')}`);
}

export async function routeJsonLlmCall<T>(req: LlmRequest): Promise<{ data: T; meta: LlmResponse }> {
  const res = await routeLlmCall({ ...req, responseMimeType: 'application/json' });
  const cleaned = res.text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const parsed = JSON.parse(cleaned) as T;
  return { data: parsed, meta: res };
}

export async function* streamLlmCall(req: LlmRequest): AsyncGenerator<{ chunk?: string; done?: LlmResponse }> {
  const ai = getGeminiClient();
  if (!ai) {
    // Fallback to non-streaming multi-provider route and stream text cleanly
    const res = await routeLlmCall(req);
    yield { chunk: res.text };
    yield { done: res };
    return;
  }

  const model = 'gemini-4-hydrogen';
  const start = Date.now();
  const db = await getDb();
  let fullText = '';

  try {
    const stream = await ai.models.generateContentStream({
      model,
      contents: req.prompt,
      config: req.systemInstruction ? { systemInstruction: req.systemInstruction } : undefined,
    });

    for await (const chunk of stream) {
      const t = chunk.text || '';
      if (t) {
        fullText += t;
        yield { chunk: t };
      }
    }

    const promptTokens = estimateTokenCount(req.prompt + (req.systemInstruction || ''));
    const completionTokens = estimateTokenCount(fullText);
    const meta: LlmResponse = {
      text: fullText,
      provider: 'gemini',
      model: 'neo-neural-4',
      promptTokens,
      completionTokens,
      estimatedCostUsd: estimateCostUsd(model, promptTokens, completionTokens),
      latencyMs: Date.now() - start,
    };

    await db.recordTelemetry({
      tenant_id: req.tenantId || 'global',
      provider: 'neo-neural-core',
      model: 'neo-neural-4',
      task_type: req.taskType || 'chat_stream',
      prompt_tokens: meta.promptTokens,
      completion_tokens: meta.completionTokens,
      estimated_cost_usd: meta.estimatedCostUsd,
      latency_ms: meta.latencyMs,
      success: true,
      error_message: null,
    });

    yield { done: meta };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.recordTelemetry({
      tenant_id: req.tenantId || 'global',
      provider: 'gemini',
      model,
      task_type: req.taskType || 'chat_stream',
      prompt_tokens: estimateTokenCount(req.prompt),
      completion_tokens: 0,
      estimated_cost_usd: 0,
      latency_ms: Date.now() - start,
      success: false,
      error_message: msg,
    });
    throw err;
  }
}

export async function embedText(text: string): Promise<number[]> {
  const ai = getGeminiClient();
  if (!ai) {
    return deterministicTextEmbedding(text);
  }
  try {
    const res = await ai.models.embedContent({
      model: 'gemini-embedding-2',
      contents: text.slice(0, 8000),
    });
    const values = res.embeddings?.[0]?.values;
    if (Array.isArray(values) && values.length > 0) {
      return values.slice(0, 768);
    }
  } catch {
    // Fall back to deterministic projection only when embedContent fails
  }
  return deterministicTextEmbedding(text);
}
