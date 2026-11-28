import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyFailure } from '../agent/runtime.ts';
import { taskPlanner } from '../cognitive/planner.ts';
import { env } from '../config/env.ts';
import { getDb, resetDbForTests } from '../db/adapter.ts';
import { circuitBreakers } from '../inference/registry.ts';
import {
  CircuitBreakerRegistry,
  RetryableHttpError,
  estimateInferenceCostUsd,
  isTransientError,
  parseRetryAfterMs,
  trimPromptToContextWindow,
  withRetryAndBackoff,
} from '../inference/resilience.ts';
import { openaiCompatRouter } from '../routes/openaiCompat.ts';
import { generateScopedApiKey } from '../security/crypto.ts';
import { securityHeadersAndTracingMiddleware, structuredErrorHandler } from '../security/headers.ts';

test('CircuitBreakerRegistry transitions closed -> open -> half_open -> closed and exempts embedded', async () => {
  const cb = new CircuitBreakerRegistry(2, 30);
  assert.equal(cb.canExecute('vllm'), true);
  cb.recordFailure('vllm', 'HTTP 503');
  assert.equal(cb.canExecute('vllm'), true);
  cb.recordFailure('vllm', 'HTTP 503');
  assert.equal(cb.canExecute('vllm'), false);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cb.canExecute('vllm'), true);
  let snap = cb.snapshot().find((s) => s.runtime === 'vllm');
  assert.equal(snap?.state, 'half_open');

  cb.recordSuccess('vllm');
  snap = cb.snapshot().find((s) => s.runtime === 'vllm');
  assert.equal(snap?.state, 'closed');
  assert.equal(snap?.failures, 0);

  // Embedded fallback never trips open
  cb.recordFailure('embedded', 'synthetic');
  cb.recordFailure('embedded', 'synthetic');
  assert.equal(cb.canExecute('embedded'), true);
});

test('withRetryAndBackoff honors 429 Retry-After, skips non-transient 400s, and respects AbortSignal', async () => {
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(isTransientError(new RetryableHttpError('rate limit', 429, 25)), true);
  assert.equal(isTransientError(new Error('HTTP 400 Bad Request')), false);

  let attempts = 0;
  const startedAt = Date.now();
  const value = await withRetryAndBackoff(
    async () => {
      attempts++;
      if (attempts < 2) throw new RetryableHttpError('rate limited', 429, 25);
      return 'recovered';
    },
    { maxRetries: 2, baseDelayMs: 5, maxDelayMs: 100 }
  );
  assert.equal(value, 'recovered');
  assert.equal(attempts, 2);
  assert.ok(Date.now() - startedAt >= 20);

  let badAttempts = 0;
  await assert.rejects(
    () =>
      withRetryAndBackoff(async () => {
        badAttempts++;
        throw new Error('HTTP 401 Unauthorized');
      }),
    /HTTP 401/
  );
  assert.equal(badAttempts, 1);

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => withRetryAndBackoff(async () => 'never', { signal: ac.signal }), /abort/i);
});

test('trimPromptToContextWindow preserves head/tail and estimateInferenceCostUsd computes non-embedded cost', () => {
  const longPrompt = `${'HEADER_START '.repeat(20)}${'MIDDLE_NOISE '.repeat(600)}TAIL_USER_QUERY`;
  const trimmed = trimPromptToContextWindow('System Directive', longPrompt, 1024, 256);
  assert.equal(trimmed.trimmed, true);
  assert.ok(trimmed.prompt.includes('HEADER_START'));
  assert.ok(trimmed.prompt.includes('TAIL_USER_QUERY'));
  assert.ok(trimmed.prompt.includes('compressed to fit 1024-token window'));

  const cost = estimateInferenceCostUsd(
    {
      id: 'm1',
      name: 'M1',
      version: '1.0',
      runtime: 'custom-llm',
      architecture: 'qwen',
      source_repo: 'local',
      license: 'Apache-2.0',
      quantization: 'q4',
      context_length: 8192,
      vram_gb: 0,
      ram_gb: 4,
      roles: ['primary'],
      download_status: 'ready',
      deployment_status: 'active',
      health_status: 'healthy',
      weight_location: null,
      checksum_sha256: null,
      modalities: ['text'],
      capabilities: { toolCalling: true, reasoning: 0.9, coding: 0.9, multilingual: 0.9, persian: 0.85 },
      benchmark_results: {},
      performance_metrics: { costPer1kInputUsd: 0.002, costPer1kOutputUsd: 0.006 },
      last_validated_at: null,
      created_at: '',
    },
    1000,
    500
  );
  assert.equal(cost, 0.005);
});

test('classifyFailure and taskPlanner.replanOnFailure handle transient/tool errors and permission blocks', () => {
  assert.equal(classifyFailure(new Error('HTTP 429 too many requests')), 'rate_limited');
  assert.equal(classifyFailure(new Error('Request timed out after 5000ms')), 'timeout');
  assert.equal(classifyFailure(new Error('403 Forbidden scope required')), 'permission_denied');
  assert.equal(classifyFailure(new Error('Zod schema validation failed')), 'invalid_input');
  assert.equal(classifyFailure(new Error('ECONNRESET socket hang up')), 'transient');

  const permAbort = taskPlanner.replanOnFailure({
    goal: 'Research',
    failedStep: { stepIndex: 1, title: 'Web Research', actionType: 'research', toolId: 'web_research', input: {} },
    failureClass: 'permission_denied',
    nextStepIndex: 2,
    existingToolsUsed: ['memory_search', 'web_research'],
    scopes: ['read'],
  });
  assert.equal(permAbort.strategy, 'abort');

  const fallbackSub = taskPlanner.replanOnFailure({
    goal: 'Audit inventory',
    failedStep: { stepIndex: 1, title: 'Web Research', actionType: 'research', toolId: 'web_research', input: {} },
    failureClass: 'timeout',
    nextStepIndex: 2,
    existingToolsUsed: ['memory_search', 'web_research'],
    scopes: ['read', 'write'],
  });
  assert.equal(fallbackSub.strategy, 'substitute');
  assert.equal(fallbackSub.replacementStep?.toolId, 'skill_lookup');
});

test('OpenAI /v1/chat/completions supports tools, tool turns, json_schema, SSE tool_calls, and abort', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-resilience-test-'));
  await resetDbForTests(path.join(tempDir, 'neo.sqlite'));
  const db = await getDb();
  const tenant = await db.createTenant({
    name: 'Router Test Tenant',
    slug: 'router-test-tenant',
    workspace_language: 'en',
    webhook_url: null,
    webhook_secret: null,
    pii_redaction: false,
    rate_limit_rpm: 200,
  });
  const key = generateScopedApiKey();
  await db.createApiKey({
    tenant_id: tenant.id,
    name: 'Router Key',
    key_prefix: key.prefix,
    key_hash: key.hash,
    scopes: ['read', 'write'],
  });

  await db.upsertModel({
    id: 'mock-custom-qwen',
    name: 'Mock Custom Qwen',
    version: '1.0',
    runtime: 'custom-llm',
    architecture: 'qwen2.5',
    source_repo: 'mock/local',
    license: 'Apache-2.0',
    quantization: 'q4',
    context_length: 8192,
    vram_gb: 0,
    ram_gb: 4,
    roles: ['primary', 'reasoning'],
    download_status: 'ready',
    deployment_status: 'active',
    weight_location: null,
    checksum_sha256: null,
    modalities: ['text'],
    capabilities: { toolCalling: true, reasoning: 0.9, coding: 0.9, multilingual: 0.9, persian: 0.85 },
    benchmark_results: {},
    health_status: 'healthy',
    last_validated_at: null,
    performance_metrics: { costPer1kInputUsd: 0.001, costPer1kOutputUsd: 0.002 },
  });

  // Mock external OpenAI-compatible runtime server
  let upstreamAborted = false;
  const mockLlmApp = express();
  mockLlmApp.use(express.json());
  mockLlmApp.get('/v1/models', (_req, res) => {
    res.json({ object: 'list', data: [{ id: 'mock-custom-qwen', object: 'model' }] });
  });
  mockLlmApp.post('/v1/chat/completions', async (req, res) => {
    const body = req.body as {
      stream?: boolean;
      tools?: unknown[];
      response_format?: { type?: string };
      messages?: Array<{ role: string; content: string }>;
    };

    if (body.messages?.some((m) => m.content.includes('SLOW_ABORT_TRIGGER'))) {
      req.on('close', () => {
        upstreamAborted = true;
      });
      await new Promise((r) => setTimeout(r, 400));
      if (!res.writableEnded) res.json({ choices: [{ message: { content: 'late' }, finish_reason: 'stop' }] });
      return;
    }

    if (body.stream && body.tools?.length) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_stream_1', function: { name: 'get_ledger', arguments: '{"period":' } }] } }],
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Q1"}' } }] }, finish_reason: 'tool_calls' }],
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (body.tools?.length) {
      res.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_mock_1', type: 'function', function: { name: 'lookup_invoice', arguments: '{"invoiceId":"INV-42"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 18, completion_tokens: 12 },
      });
      return;
    }

    if (body.response_format?.type === 'json_schema') {
      res.json({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ status: 'balanced', total: 420 }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 14, completion_tokens: 9 },
      });
      return;
    }

    res.json({
      choices: [{ message: { role: 'assistant', content: 'Verified invoice INV-42 total $420.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 22, completion_tokens: 10 },
    });
  });

  let mockServer!: http.Server;
  let apiServer!: http.Server;
  const prevInferenceUrl = env.customInferenceUrl;
  const prevInferenceKey = env.customInferenceApiKey;
  circuitBreakers.reset();

  try {
    const mockUrl = await new Promise<string>((resolve) => {
      mockServer = mockLlmApp.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });
    env.customInferenceUrl = mockUrl;
    env.customInferenceApiKey = 'test-internal-secret';

    const apiApp = express();
    apiApp.use(securityHeadersAndTracingMiddleware);
    apiApp.use(express.json());
    apiApp.use('/v1', openaiCompatRouter);
    apiApp.use(structuredErrorHandler);

    const apiUrl = await new Promise<string>((resolve) => {
      apiServer = apiApp.listen(0, '127.0.0.1', () => {
        const addr = apiServer.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    // 1. OpenAI tools request -> tool_calls returned
    const toolRes = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.rawKey}` },
      body: JSON.stringify({
        model: 'mock-custom-qwen',
        messages: [{ role: 'user', content: 'Look up invoice INV-42' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_invoice',
              description: 'Lookup an invoice by ID',
              parameters: { type: 'object', properties: { invoiceId: { type: 'string' } }, required: ['invoiceId'] },
            },
          },
        ],
        tool_choice: 'auto',
      }),
    });
    assert.equal(toolRes.status, 200);
    const toolBody = (await toolRes.json()) as {
      choices: Array<{ finish_reason: string; message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
    };
    assert.equal(toolBody.choices[0].finish_reason, 'tool_calls');
    assert.equal(toolBody.choices[0].message.tool_calls?.[0].function.name, 'lookup_invoice');

    // 2. Tool turn continuation
    const turn2Res = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.rawKey}` },
      body: JSON.stringify({
        model: 'mock-custom-qwen',
        messages: [
          { role: 'user', content: 'Look up invoice INV-42' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: 'lookup_invoice', arguments: '{"invoiceId":"INV-42"}' } }],
          },
          { role: 'tool', tool_call_id: 'call_mock_1', name: 'lookup_invoice', content: '{"total":420}' },
        ],
      }),
    });
    assert.equal(turn2Res.status, 200);
    const turn2Body = (await turn2Res.json()) as { choices: Array<{ message: { content: string } }> };
    assert.ok(turn2Body.choices[0].message.content.includes('420'));

    // 3. Structured json_schema response_format
    const jsonRes = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.rawKey}` },
      body: JSON.stringify({
        model: 'mock-custom-qwen',
        messages: [{ role: 'user', content: 'Return JSON audit status' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'audit_summary',
            strict: true,
            schema: { type: 'object', properties: { status: { type: 'string' }, total: { type: 'number' } } },
          },
        },
      }),
    });
    assert.equal(jsonRes.status, 200);
    const jsonBody = (await jsonRes.json()) as { choices: Array<{ message: { content: string } }> };
    const parsedContent = JSON.parse(jsonBody.choices[0].message.content) as { status: string; total: number };
    assert.equal(parsedContent.status, 'balanced');
    assert.equal(parsedContent.total, 420);

    // 4. SSE streaming tool_calls delta
    const sseRes = await fetch(`${apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.rawKey}` },
      body: JSON.stringify({
        model: 'mock-custom-qwen',
        stream: true,
        messages: [{ role: 'user', content: 'Call get_ledger' }],
        tools: [{ type: 'function', function: { name: 'get_ledger', parameters: { type: 'object', properties: {} } } }],
      }),
    });
    assert.equal(sseRes.status, 200);
    const sseText = await sseRes.text();
    assert.ok(sseText.includes('"tool_calls"'));
    assert.ok(sseText.includes('get_ledger'));
    assert.ok(sseText.includes('data: [DONE]'));

    // 5. Client abort cancellation propagates cleanly
    const abortCtrl = new AbortController();
    setTimeout(() => abortCtrl.abort(), 60);
    await assert.rejects(async () => {
      const r = await fetch(`${apiUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.rawKey}` },
        signal: abortCtrl.signal,
        body: JSON.stringify({
          model: 'mock-custom-qwen',
          stream: true,
          messages: [{ role: 'user', content: 'SLOW_ABORT_TRIGGER' }],
        }),
      });
      await r.text();
    }, /abort/i);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(upstreamAborted, true);
  } finally {
    env.customInferenceUrl = prevInferenceUrl;
    env.customInferenceApiKey = prevInferenceKey;
    circuitBreakers.reset();
    await new Promise<void>((resolve) => apiServer?.close(() => resolve()));
    await new Promise<void>((resolve) => mockServer?.close(() => resolve()));
    await resetDbForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
