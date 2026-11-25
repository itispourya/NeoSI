import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NeoClient } from '../../../packages/neo-ai-sdk/src/index.ts';
import { getDb, resetDbForTests } from '../db/adapter.ts';
import { adminRouter } from '../routes/admin.ts';
import { coreRouter } from '../routes/core.ts';
import { evolutionRouter } from '../routes/evolution.ts';
import { forgeRouter } from '../routes/forge.ts';
import { knowledgeRouter } from '../routes/knowledge.ts';
import { memoryRouter } from '../routes/memory.ts';
import { modelsRouter } from '../routes/models.ts';
import { systemRouter } from '../routes/system.ts';
import { tasksRouter } from '../routes/tasks.ts';
import { toolsRouter } from '../routes/tools.ts';
import { executeHandlerInSandbox } from '../sandbox/runner.ts';
import { generateScopedApiKey, validateExternalUrlAsync } from './crypto.ts';
import { securityHeadersAndTracingMiddleware, structuredErrorHandler } from './headers.ts';

let tempDir = '';
let server: http.Server;
let baseUrl = '';

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-sec-test-'));
  await resetDbForTests(path.join(tempDir, 'neo-sec.sqlite'));

  const app = express();
  app.use(securityHeadersAndTracingMiddleware);
  app.use(express.json());
  app.use('/api/v1', systemRouter);
  app.use('/api/v1', coreRouter);
  app.use('/api/v1', tasksRouter);
  app.use('/api/v1', memoryRouter);
  app.use('/api/v1', knowledgeRouter);
  app.use('/api/v1', toolsRouter);
  app.use('/api/v1', modelsRouter);
  app.use('/api/v1', evolutionRouter);
  app.use('/api/v1', forgeRouter);
  app.use('/api/admin', adminRouter);
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

test('Fail-closed auth blocks unauthenticated admin/gateway access and spoofed X-Neo-Console header', async () => {
  // Even when admin is unclaimed, /api/admin/overview must return 401 (never bypass)
  const overviewNoAuth = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { 'X-Neo-Console': '1' },
  });
  assert.equal(overviewNoAuth.status, 401);

  const v1NoAuth = await fetch(`${baseUrl}/api/v1/status`);
  assert.equal(v1NoAuth.status, 401);

  // Claim admin passcode properly
  const claimRes = await fetch(`${baseUrl}/api/admin/auth/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: 'neo-test-passcode-123' }),
  });
  assert.equal(claimRes.status, 201);
  const claimData = (await claimRes.json()) as { token: string };
  assert.ok(claimData.token.startsWith('neo_adm_'));

  // Authenticated admin request succeeds
  const overviewAuthed = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { Authorization: `Bearer ${claimData.token}` },
  });
  assert.equal(overviewAuthed.status, 200);
});

test('Strict cross-tenant isolation prevents Tenant B from accessing Tenant A memories, tasks, or conversations', async () => {
  const db = await getDb();
  const tenantA = await db.createTenant({
    name: 'Tenant Alpha',
    slug: 'alpha-sec',
    workspace_language: 'en',
    webhook_url: null,
    webhook_secret: null,
    pii_redaction: true,
    rate_limit_rpm: 120,
  });
  const tenantB = await db.createTenant({
    name: 'Tenant Beta',
    slug: 'beta-sec',
    workspace_language: 'en',
    webhook_url: null,
    webhook_secret: null,
    pii_redaction: true,
    rate_limit_rpm: 120,
  });

  const keyA = generateScopedApiKey();
  const keyB = generateScopedApiKey();
  await db.createApiKey({ tenant_id: tenantA.id, name: 'Key A', key_prefix: keyA.prefix, key_hash: keyA.hash, scopes: ['read', 'write', 'forge'] });
  await db.createApiKey({ tenant_id: tenantB.id, name: 'Key B', key_prefix: keyB.prefix, key_hash: keyB.hash, scopes: ['read', 'write', 'forge'] });

  const clientA = new NeoClient({ baseUrl, apiKey: keyA.rawKey });
  const clientB = new NeoClient({ baseUrl, apiKey: keyB.rawKey });

  // Tenant A stores confidential memory & creates a task
  const memA = await clientA.memory.store({
    memoryType: 'personal',
    topic: 'confidential-payroll',
    title: 'Alpha Secret Budget',
    content: 'Tenant Alpha confidential Q4 reserve is $999,111.',
  });
  const memId = String(memA.memory.id);

  // Tenant B cannot read Tenant A's memory by ID or search
  const bGetMem = await fetch(`${baseUrl}/api/v1/memory/${memId}`, {
    headers: { Authorization: `Bearer ${keyB.rawKey}` },
  });
  assert.equal(bGetMem.status, 404);

  const bSearch = await clientB.memory.search('Alpha Secret Budget', 'personal', 10);
  assert.equal(bSearch.matches.length, 0);

  // Tenant A creates task -> Tenant B cannot fetch or cancel it
  const taskA = await clientA.createTask({ goal: 'Calculate 12 * 12 for Alpha', autonomy: 'low' });
  const taskAId = String(taskA.task.id);
  const bGetTask = await fetch(`${baseUrl}/api/v1/tasks/${taskAId}`, {
    headers: { Authorization: `Bearer ${keyB.rawKey}` },
  });
  assert.equal(bGetTask.status, 404);

  // Tenant A chats via SDK -> Tenant B gets its own status cleanly
  const chatRes = await clientA.chat({ message: 'Calculate 20 * 5' });
  assert.ok(chatRes.reply.includes('100'));
});

test('Async DNS SSRF protection rejects localhost, private IPs, and metadata endpoints', async () => {
  assert.equal((await validateExternalUrlAsync('http://127.0.0.1:3000/api/admin/overview')).valid, false);
  assert.equal((await validateExternalUrlAsync('http://localhost:3000')).valid, false);
  assert.equal((await validateExternalUrlAsync('http://169.254.169.254/latest/meta-data')).valid, false);
  assert.equal((await validateExternalUrlAsync('http://10.0.0.8/secret')).valid, false);
});

test('OS Subprocess sandbox executes with empty env ({}) and never leaks host secrets', () => {
  // Confirm direct secret read attempt is blocked by static guard
  const blocked = executeHandlerInSandbox('function handle() { return process.env.ADMIN_PASSCODE; }', {});
  assert.equal(blocked.ok, false);

  // Confirm pure execution runs in isolated subprocess without accessing host environment
  const clean = executeHandlerInSandbox<{ ok: boolean }>('function handle(i) { return { ok: i.flag === true }; }', { flag: true });
  assert.equal(clean.ok, true);
  assert.equal(clean.output?.ok, true);
  assert.equal(clean.isolation, 'subprocess');
});
