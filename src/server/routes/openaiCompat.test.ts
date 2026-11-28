import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NeoClient } from '../../../packages/neo-ai-sdk/src/index.ts';
import { NeoAiClient } from '../../../packages/neos-ai-sdk/src/index.ts';
import { env } from '../config/env.ts';
import { getDb, resetDbForTests } from '../db/adapter.ts';
import { generateScopedApiKey } from '../security/crypto.ts';
import { securityHeadersAndTracingMiddleware, structuredErrorHandler } from '../security/headers.ts';
import { modelsRouter } from './models.ts';
import { openaiCompatRouter } from './openaiCompat.ts';

let tempDir = '';
let server: http.Server;
let baseUrl = '';
let writeKey = '';
let readOnlyKey = '';

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-openai-test-'));
  await resetDbForTests(path.join(tempDir, 'neo-openai.sqlite'));

  const db = await getDb();
  const tenant = await db.createTenant({
    name: 'OpenAI Compat Tenant',
    slug: 'openai-compat-tenant',
    workspace_language: 'en',
    webhook_url: null,
    webhook_secret: null,
    pii_redaction: true,
    rate_limit_rpm: 120,
  });

  const fullKeys = generateScopedApiKey();
  const roKeys = generateScopedApiKey();
  writeKey = fullKeys.rawKey;
  readOnlyKey = roKeys.rawKey;

  await db.createApiKey({
    tenant_id: tenant.id,
    name: 'Full Key',
    key_prefix: fullKeys.prefix,
    key_hash: fullKeys.hash,
    scopes: ['read', 'write'],
  });
  await db.createApiKey({
    tenant_id: tenant.id,
    name: 'Read Only Key',
    key_prefix: roKeys.prefix,
    key_hash: roKeys.hash,
    scopes: ['read'],
  });

  const app = express();
  app.use(securityHeadersAndTracingMiddleware);
  app.use(express.json());
  app.use('/v1', openaiCompatRouter);
  app.use('/api/v1', modelsRouter);
  app.use('/api/v1', openaiCompatRouter);
  app.use(structuredErrorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await resetDbForTests();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('GET /v1/models and GET /api/v1/models return OpenAI list shape with active models', async () => {
  const res = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${readOnlyKey}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { object: string; data: Array<{ id: string; object: string; owned_by: string }> };
  assert.equal(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m) => m.id === 'neo-ai-v1' && m.object === 'model'));
  assert.ok(body.data.some((m) => m.id === 'neo-embedded-core-v1'));

  const apiV1Res = await fetch(`${baseUrl}/api/v1/models`, {
    headers: { Authorization: `Bearer ${readOnlyKey}` },
  });
  assert.equal(apiV1Res.status, 200);
  const apiV1Body = (await apiV1Res.json()) as { object: string; data: unknown[]; models: unknown[] };
  assert.equal(apiV1Body.object, 'list');
  assert.ok(Array.isArray(apiV1Body.data));
  assert.ok(Array.isArray(apiV1Body.models));
});

test('OpenAI compatibility auth guards reject missing key (401), insufficient scope (403), and invalid payload (400)', async () => {
  const noAuth = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
  });
  assert.equal(noAuth.status, 401);

  const badScope = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${readOnlyKey}`,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
  });
  assert.equal(badScope.status, 403);

  const badBody = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${writeKey}`,
    },
    body: JSON.stringify({ model: 'neo-ai-v1', messages: [] }),
  });
  assert.equal(badBody.status, 400);
});

test('POST /v1/chat/completions and /api/v1/chat/completions support probes, multi-turn messages, and en/fa/ar/nl responses', async () => {
  const probeRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${writeKey}`,
    },
    body: JSON.stringify({
      model: 'neo-ai-v1',
      messages: [{ role: 'user', content: 'Say "OK"' }],
    }),
  });
  assert.equal(probeRes.status, 200);
  const probeJson = (await probeRes.json()) as {
    id: string;
    object: string;
    choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  assert.ok(probeJson.id.startsWith('chatcmpl-'));
  assert.equal(probeJson.object, 'chat.completion');
  assert.equal(probeJson.choices[0].message.role, 'assistant');
  assert.equal(probeJson.choices[0].message.content, 'OK');
  assert.equal(probeJson.choices[0].finish_reason, 'stop');
  assert.ok(probeJson.usage.total_tokens >= 2);

  // Multi-turn Persian request via /api/v1/chat/completions alias
  const faRes = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${writeKey}`,
    },
    body: JSON.stringify({
      model: 'neo-ai-v1',
      messages: [
        { role: 'system', content: 'You are assisting inside Neos Cloud OS.' },
        { role: 'user', content: 'سلام!' },
        { role: 'assistant', content: 'سلام! چطور می‌توانم کمکتان کنم؟' },
        { role: 'user', content: 'حاصل ۲۵ * ۴ چند می‌شود؟' },
      ],
    }),
  });
  assert.equal(faRes.status, 200);
  const faJson = (await faRes.json()) as { choices: Array<{ message: { content: string } }> };
  assert.ok(faJson.choices[0].message.content.includes('100'));

  // Arabic and Dutch SDK calls via NeoClient & NeoAiClient
  const neoSdk = new NeoClient({ baseUrl, apiKey: writeKey });
  const arCompletion = await neoSdk.chatCompletions({
    model: 'neo-ai-v1',
    messages: [{ role: 'user', content: 'مرحبا من أنت؟' }],
  });
  assert.equal(arCompletion.object, 'chat.completion');
  assert.ok(/[\u0600-\u06FF]/.test(arCompletion.choices[0].message.content));

  const neosSdk = new NeoAiClient({ baseUrl, apiKey: writeKey });
  const nlCompletion = await neosSdk.chatCompletions({
    model: 'neo-ai-v1',
    messages: [{ role: 'user', content: 'Hallo, wie ben je en wat zijn de omzet en kosten?' }],
    workspaceContext: { ledgerBalanced: true, monthlyRevenue: 45000 },
  });
  assert.equal(nlCompletion.object, 'chat.completion');
  assert.ok(nlCompletion.choices[0].message.content.length > 10);
});

test('POST /v1/chat/completions supports OpenAI SSE streaming chunks and [DONE] terminator', async () => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${writeKey}`,
    },
    body: JSON.stringify({
      model: 'neo-ai-v1',
      stream: true,
      messages: [
        { role: 'system', content: 'Answer concisely.' },
        { role: 'user', content: 'What is 15 * 4?' },
      ],
    }),
  });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
  const rawSse = await res.text();
  assert.ok(rawSse.includes('"object":"chat.completion.chunk"'));
  assert.ok(rawSse.includes('60'));
  assert.ok(rawSse.includes('data: [DONE]'));
});

test('CORS policy enforces configured NEO_CORS_ORIGINS on preflight OPTIONS without wildcards', async () => {
  const prevOrigins = [...env.corsAllowedOrigins];
  env.corsAllowedOrigins.splice(0, env.corsAllowedOrigins.length, 'https://neos.example.com');
  try {
    const allowedRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://neos.example.com' },
    });
    assert.equal(allowedRes.status, 204);
    assert.equal(allowedRes.headers.get('access-control-allow-origin'), 'https://neos.example.com');

    const forbiddenRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.net' },
    });
    assert.equal(forbiddenRes.status, 403);
  } finally {
    env.corsAllowedOrigins.splice(0, env.corsAllowedOrigins.length, ...prevOrigins);
  }
});
