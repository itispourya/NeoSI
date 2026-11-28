import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getDb, resetDbForTests } from '../db/adapter.ts';
import { ingestConfiguredFeeds } from '../knowledge/feeds.ts';
import { generateScopedApiKey } from '../security/crypto.ts';
import { securityHeadersAndTracingMiddleware, structuredErrorHandler } from '../security/headers.ts';
import { issueAdminToken } from '../security/auth.ts';
import { evolutionRouter } from '../routes/evolution.ts';
import { knowledgeRouter } from '../routes/knowledge.ts';
import { neosRouter } from '../routes/neos.ts';
import { openaiCompatRouter } from '../routes/openaiCompat.ts';

let tempDir = '';
let server: http.Server;
let baseUrl = '';
let tenantAId = '';
let tenantAWriteKey = '';
let tenantAReadKey = '';
let tenantBWriteKey = '';
let adminBearer = '';

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-e2e-neos-'));
  await resetDbForTests(path.join(tempDir, 'neo-e2e.sqlite'));

  const db = await getDb();
  const tenantA = await db.createTenant({
    name: 'Neos Tenant Alpha',
    slug: 'neos-alpha',
    workspace_language: 'en',
    webhook_url: null,
    webhook_secret: null,
    pii_redaction: true,
    rate_limit_rpm: 200,
  });
  tenantAId = tenantA.id;

  const tenantB = await db.createTenant({
    name: 'Neos Tenant Beta',
    slug: 'neos-beta',
    workspace_language: 'en',
    webhook_url: null,
    webhook_secret: null,
    pii_redaction: true,
    rate_limit_rpm: 200,
  });

  const keysAWrite = generateScopedApiKey();
  const keysARead = generateScopedApiKey();
  const keysBWrite = generateScopedApiKey();
  tenantAWriteKey = keysAWrite.rawKey;
  tenantAReadKey = keysARead.rawKey;
  tenantBWriteKey = keysBWrite.rawKey;

  await db.createApiKey({
    tenant_id: tenantA.id,
    name: 'Alpha Full Key',
    key_prefix: keysAWrite.prefix,
    key_hash: keysAWrite.hash,
    scopes: ['read', 'write', 'forge'],
  });
  await db.createApiKey({
    tenant_id: tenantA.id,
    name: 'Alpha Read Key',
    key_prefix: keysARead.prefix,
    key_hash: keysARead.hash,
    scopes: ['read'],
  });
  await db.createApiKey({
    tenant_id: tenantB.id,
    name: 'Beta Full Key',
    key_prefix: keysBWrite.prefix,
    key_hash: keysBWrite.hash,
    scopes: ['read', 'write'],
  });

  adminBearer = issueAdminToken();

  const app = express();
  app.use(securityHeadersAndTracingMiddleware);
  app.use(express.json());
  app.use('/v1', openaiCompatRouter);
  app.use('/api/v1', neosRouter);
  app.use('/api/v1', knowledgeRouter);
  app.use('/api/v1', evolutionRouter);
  app.use('/api/v1', openaiCompatRouter);
  app.use(structuredErrorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await resetDbForTests();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('E2E 1: Deep Neos capability sync, SSRF guard, context grounding, human confirmation gate, and tenant isolation', async () => {
  // Contract inspection
  const contractRes = await fetch(`${baseUrl}/api/v1/neos/contract`, {
    headers: { Authorization: `Bearer ${tenantAReadKey}` },
  });
  assert.equal(contractRes.status, 200);
  const contract = (await contractRes.json()) as { contractVersion: string; securityGuarantees: { highRiskHumanConfirmationRequired: boolean } };
  assert.equal(contract.contractVersion, '1.0.0');
  assert.equal(contract.securityGuarantees.highRiskHumanConfirmationRequired, true);

  // Sync valid high-risk financial capability + reject SSRF loopback endpoint_url
  const syncRes = await fetch(`${baseUrl}/api/v1/neos/capabilities/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenantAWriteKey}` },
    body: JSON.stringify({
      capabilities: [
        {
          module_name: 'accounting',
          capability_id: 'accounting.payment.release',
          title: 'Release Vendor Payment',
          description: 'Transfers approved invoice settlement funds.',
          required_scopes: ['write'],
          risk_level: 'high',
          requires_confirmation: true,
          input_schema: {
            type: 'object',
            required: ['invoiceId', 'amountUsd'],
            properties: {
              invoiceId: { type: 'string' },
              amountUsd: { type: 'number', minimum: 1 },
            },
          },
        },
        {
          module_name: 'billing',
          capability_id: 'billing.unsafe.local',
          title: 'Unsafe Local Hook',
          description: 'Should be rejected by SSRF validation.',
          endpoint_url: 'http://127.0.0.1:9000/hook',
        },
      ],
    }),
  });
  assert.equal(syncRes.status, 200);
  const syncJson = (await syncRes.json()) as {
    synced: Array<{ capability_id: string }>;
    rejected: Array<{ capability_id: string; reason: string }>;
  };
  assert.equal(syncJson.synced.length, 1);
  assert.equal(syncJson.synced[0].capability_id, 'accounting.payment.release');
  assert.equal(syncJson.rejected.length, 1);
  assert.equal(syncJson.rejected[0].capability_id, 'billing.unsafe.local');

  // Workspace context ingestion -> OpenAI chat completion grounds answer in ingested Neos snapshot
  const ctxRes = await fetch(`${baseUrl}/api/v1/neos/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenantAWriteKey}` },
    body: JSON.stringify({
      moduleName: 'accounting',
      title: 'Neos Q4 Invoice Batch 991',
      summary: 'Pending vendor payment for Atlas Logistics INV-991 totaling 14500 USD.',
      records: [{ invoiceId: 'INV-991', vendor: 'Atlas Logistics', amountUsd: 14500 }],
    }),
  });
  assert.equal(ctxRes.status, 201);

  const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenantAWriteKey}` },
    body: JSON.stringify({
      model: 'neo-ai-v1',
      messages: [{ role: 'user', content: 'Summarize Atlas Logistics INV-991 status from accounting context.' }],
    }),
  });
  assert.equal(chatRes.status, 200);
  const chatJson = (await chatRes.json()) as { choices: Array<{ message: { content: string } }> };
  assert.ok(chatJson.choices[0].message.content.includes('Atlas') || chatJson.choices[0].message.content.includes('INV-991'));

  // Missing scope (read-only key) must fail with 403 on write execute route
  const roExec = await fetch(`${baseUrl}/api/v1/neos/actions/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenantAReadKey}` },
    body: JSON.stringify({ capabilityId: 'accounting.payment.release', payload: { invoiceId: 'INV-991', amountUsd: 14500 } }),
  });
  assert.equal(roExec.status, 403);

  // Invalid schema payload must fail with 400
  const badSchemaExec = await fetch(`${baseUrl}/api/v1/neos/actions/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenantAWriteKey}` },
    body: JSON.stringify({ capabilityId: 'accounting.payment.release', payload: { invoiceId: 'INV-991', amountUsd: -10 } }),
  });
  assert.equal(badSchemaExec.status, 400);

  // High-risk capability queues confirmation_required (202) instead of executing immediately
  const queueRes = await fetch(`${baseUrl}/api/v1/neos/actions/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenantAWriteKey}` },
    body: JSON.stringify({
      capabilityId: 'accounting.payment.release',
      payload: { invoiceId: 'INV-991', amountUsd: 14500 },
      actionSummary: 'Release payment for INV-991',
    }),
  });
  assert.equal(queueRes.status, 202);
  const queueJson = (await queueRes.json()) as { status: string; approval: { id: string; status: string } };
  assert.equal(queueJson.status, 'confirmation_required');
  assert.equal(queueJson.approval.status, 'pending');

  // Cross-tenant isolation check: Tenant B cannot confirm or see Tenant A's approval
  const crossConfirm = await fetch(`${baseUrl}/api/v1/neos/approvals/${queueJson.approval.id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenantBWriteKey}` },
    body: JSON.stringify({ decisionNote: 'Cross-tenant hijack attempt' }),
  });
  assert.equal(crossConfirm.status, 404);

  // Human operator on Tenant A confirms approval -> status transitions to approved
  const confirmRes = await fetch(`${baseUrl}/api/v1/neos/approvals/${queueJson.approval.id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenantAWriteKey}` },
    body: JSON.stringify({ decisionNote: 'CFO signed settlement' }),
  });
  assert.equal(confirmRes.status, 200);
  const confirmJson = (await confirmRes.json()) as { approval: { status: string; decision_note: string } };
  assert.equal(confirmJson.approval.status, 'approved');
  assert.equal(confirmJson.approval.decision_note, 'CFO signed settlement');
});

test('E2E 2: Continuous knowledge governance, feed sync deduplication, diagnostics, and grounded query', async () => {
  // Add blocked_domain + feed_source policy
  const blockRes = await fetch(`${baseUrl}/api/v1/knowledge/policies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
    body: JSON.stringify({
      rule_type: 'blocked_domain',
      pattern: 'blocked-rumors.example.net',
      min_reliability: 0.6,
    }),
  });
  assert.equal(blockRes.status, 201);

  const db = await getDb();
  await db.upsertKnowledgePolicy({
    tenant_id: tenantAId,
    rule_type: 'feed_source',
    pattern: 'https://trusted-specs.example.org/neos-feed.xml',
    source_kind: 'rss',
    min_reliability: 0.6,
    revalidation_hours: 24,
    etag: null,
    last_modified: null,
    last_fetched_at: null,
    enabled: true,
    metadata: {},
  });

  const xmlBody = `<?xml version="1.0"?>
  <rss><channel><item>
    <title>Neos Treasury Liquidity Threshold</title>
    <link>https://trusted-specs.example.org/liquidity</link>
    <description>Neos treasury operations require minimum 90 days cash runway reserve before dividend payout.</description>
  </item></channel></rss>`;

  const mockFetch = (async (url: string | URL | Request) => {
    if (!String(url).includes('trusted-specs.example.org')) {
      return new Response(null, { status: 304 });
    }
    return new Response(xmlBody, { status: 200 });
  }) as typeof fetch;
  const run1 = await ingestConfiguredFeeds({ tenantId: tenantAId, fetchFn: mockFetch, allowLocalTestFetch: true });
  assert.equal(run1.itemsIngested, 1);

  // Second run with same body (no 304) still deduplicates via SHA-256 content_hash
  const run2 = await ingestConfiguredFeeds({ tenantId: tenantAId, fetchFn: mockFetch, allowLocalTestFetch: true });
  assert.equal(run2.itemsIngested, 0);
  assert.equal(run2.skippedDeduplicated, 1);

  // Diagnostics verifies normalized query & retrieved ingested feed item
  const diagRes = await fetch(
    `${baseUrl}/api/v1/knowledge/diagnostics?q=${encodeURIComponent('Neos treasury cash runway ۹۰ days')}`,
    { headers: { Authorization: `Bearer ${tenantAReadKey}` } }
  );
  assert.equal(diagRes.status, 200);
  const diagJson = (await diagRes.json()) as {
    diagnostics: { normalizedQuery: string };
    topMatches: Array<{ title: string }>;
  };
  assert.ok(diagJson.diagnostics.normalizedQuery.includes('90'));
  assert.ok(diagJson.topMatches.some((m) => m.title.includes('Treasury Liquidity')));
});

test('E2E 3: Self-evaluation suite -> Layer 3 Behavioral Policy proposal -> promotion -> rollback', async () => {
  const evalRes = await fetch(`${baseUrl}/api/v1/evolution/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
    body: JSON.stringify({}),
  });
  assert.equal(evalRes.status, 201);
  const evalJson = (await evalRes.json()) as { evaluation: { overall_score: number } };
  assert.ok(evalJson.evaluation.overall_score > 0);

  const propRes = await fetch(`${baseUrl}/api/v1/evolution/policies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
    body: JSON.stringify({
      title: 'Precision Policy vNext',
      hypothesis: 'Tighten minReliability slightly to 0.45 and increase ragTopK to 5.',
      patch: { ragTopK: 5, minReliability: 0.45 },
      autoPromote: false,
    }),
  });
  assert.equal(propRes.status, 201);
  const propJson = (await propRes.json()) as { policy: { id: string; status: string; version: number } };
  assert.equal(propJson.policy.status, 'candidate');

  const promoteRes = await fetch(`${baseUrl}/api/v1/evolution/policies/${propJson.policy.id}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
  });
  assert.equal(promoteRes.status, 200);
  const promoteJson = (await promoteRes.json()) as { policy: { status: string } };
  assert.equal(promoteJson.policy.status, 'active');

  const diagRes = await fetch(`${baseUrl}/api/v1/knowledge/diagnostics?q=runway`, {
    headers: { Authorization: `Bearer ${tenantAReadKey}` },
  });
  assert.equal(diagRes.status, 200);
  const diagJson = (await diagRes.json()) as { diagnostics: { ragTopK: number; policyVersion: number } };
  assert.equal(diagJson.diagnostics.ragTopK, 5);
  assert.equal(diagJson.diagnostics.policyVersion, propJson.policy.version);

  const rollbackRes = await fetch(`${baseUrl}/api/v1/evolution/policies/rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminBearer}` },
    body: JSON.stringify({}),
  });
  assert.equal(rollbackRes.status, 200);
  const rollbackJson = (await rollbackRes.json()) as { policy: { id: string; status: string } };
  assert.equal(rollbackJson.policy.status, 'active');
  assert.notEqual(rollbackJson.policy.id, propJson.policy.id);
});
