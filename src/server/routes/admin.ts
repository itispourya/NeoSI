import { Router } from 'express';
import { z } from 'zod';
import { getConfiguredSubsystems } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import { indexWorkspaceCodebase } from '../engineer/repoIndex.ts';
import { inspectHardware } from '../inference/hardware.ts';
import { modelRegistry, neoInferenceEngine } from '../inference/registry.ts';
import { getCapabilityRegistry } from '../multimodal/capabilities.ts';
import { listPromotedModules } from '../neo/sovereignEngine.ts';
import { autonomousScheduler } from '../scheduler/autonomousScheduler.ts';
import {
  claimInitialAdminPasscode,
  getAdminLockState,
  issueAdminToken,
  checkRateLimit,
  requireAdminConsoleAuth,
  verifyAdminCredential,
} from '../security/auth.ts';
import { generateScopedApiKey, signWebhookPayload, validateExternalUrlAsync } from '../security/crypto.ts';
import { toolRegistry } from '../tools/registry.ts';

export const adminRouter = Router();

adminRouter.get('/auth/status', async (_req, res) => {
  const lockState = await getAdminLockState();
  res.json(lockState);
});

adminRouter.post('/auth/claim', async (req, res) => {
  const rate = checkRateLimit(`admin-claim:${req.ip || req.socket.remoteAddress || 'unknown'}`, 5);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rate.resetMs / 1000)));
    return res.status(429).json({ error: 'Too many admin setup attempts. Try again later.' });
  }
  const passcode = String(req.body?.passcode || '');
  const result = await claimInitialAdminPasscode(passcode);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  const token = issueAdminToken();
  return res.status(201).json({ token, locked: true });
});

adminRouter.post('/auth/login', async (req, res) => {
  const rate = checkRateLimit(`admin-login:${req.ip || req.socket.remoteAddress || 'unknown'}`, 10);
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(rate.resetMs / 1000)));
    return res.status(429).json({ error: 'Too many admin login attempts. Try again later.' });
  }
  const passcode = String(req.body?.passcode || '');
  const valid = await verifyAdminCredential(passcode);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid admin passcode' });
  }
  const token = issueAdminToken();
  return res.json({ token });
});

adminRouter.get('/overview', requireAdminConsoleAuth, async (_req, res) => {
  const db = await getDb();
  const [
    tenants,
    apiKeys,
    memoryCounts,
    recentMemories,
    skills,
    streams,
    upgrades,
    dynamicApis,
    jobs,
    telemetrySummary,
    auditLogs,
    lockState,
    hardware,
    runtimeHealth,
    models,
    modelCompatibility,
    evaluations,
    tasks,
    dbTools,
    toolExecutions,
    scheduledJobs,
    experiments,
    trainingJobs,
    researchReports,
    knowledgeSources,
    entities,
    relationships,
    capabilities,
  ] = await Promise.all([
    db.listTenants(),
    db.listApiKeys(),
    db.countMemories(),
    db.listMemories({ limit: 40 }),
    db.listSkills(),
    db.listTopicStreams(),
    db.listUpgrades(),
    db.listDynamicApis(),
    db.listJobs(20),
    db.getTelemetrySummary(),
    db.listAuditLogs(30),
    getAdminLockState(),
    inspectHardware(),
    neoInferenceEngine.listRuntimeHealth(),
    db.listModels(),
    modelRegistry.discoverCompatibleModels(),
    db.listModelEvaluations(undefined, 15),
    db.listTasks(undefined, { limit: 30 }),
    db.listTools(),
    db.listToolExecutions(undefined, 30),
    db.listScheduledJobs(),
    db.listEvolutionExperiments(25),
    db.listTrainingJobs(undefined, 20),
    db.listResearchReports('global', 15),
    db.listKnowledgeSources('global', 25),
    db.listEntities('global', { limit: 40 }),
    db.listRelationships('global', undefined, 50),
    getCapabilityRegistry(),
  ]);

  const repoIndex = indexWorkspaceCodebase();

  res.json({
    subsystems: getConfiguredSubsystems(),
    capabilities: capabilities.modalities,
    hardware,
    runtimeHealth,
    lockState,
    tenants: tenants.map((t) => ({ ...t, webhook_secret: t.webhook_secret ? '********' : null })),
    apiKeys: apiKeys.map((k) => ({ ...k, key_hash: undefined })),
    memoryCounts,
    recentMemories: recentMemories.map((m) => ({ ...m, embedding: undefined })),
    skills,
    streams,
    upgrades,
    experiments,
    trainingJobs,
    promotedModules: listPromotedModules(),
    dynamicApis,
    jobs,
    scheduledJobs,
    tasks,
    tools: toolRegistry.toPublicRecords(dbTools),
    toolExecutions,
    models,
    modelCompatibility,
    evaluations,
    researchReports,
    knowledgeSources,
    graph: {
      entities: entities.map((e) => ({ ...e, embedding: undefined })),
      relationships,
    },
    telemetrySummary,
    auditLogs,
    repoSummary: {
      totalFiles: repoIndex.totalFiles,
      totalLines: repoIndex.totalLines,
      topModules: repoIndex.files.slice(0, 12),
    },
  });
});

const createKeySchema = z.object({
  tenantId: z.string().min(1),
  name: z.string().min(2).max(80),
  scopes: z.array(z.enum(['read', 'write', 'forge', 'admin'])).min(1),
});

adminRouter.post('/keys', requireAdminConsoleAuth, async (req, res) => {
  const parsed = createKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid API key payload', issues: parsed.error.issues });
  }
  const db = await getDb();
  const tenant = await db.getTenantById(parsed.data.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const { rawKey, prefix, hash } = generateScopedApiKey();
  const record = await db.createApiKey({
    tenant_id: tenant.id,
    name: parsed.data.name,
    key_prefix: prefix,
    key_hash: hash,
    scopes: parsed.data.scopes,
  });

  await db.recordAuditLog({
    tenant_id: tenant.id,
    actor: req.neoAuth!.actorLabel,
    action: 'POST /api/admin/keys',
    resource: `key:${prefix}`,
    status_code: 201,
    metadata: { scopes: parsed.data.scopes },
  });

  res.status(201).json({
    rawKey,
    key: { ...record, key_hash: undefined },
  });
});

adminRouter.post('/keys/:id/rotate', requireAdminConsoleAuth, async (req, res) => {
  const db = await getDb();
  const existing = await db.getApiKeyById(String(req.params.id));
  if (!existing || existing.revoked_at) return res.status(404).json({ error: 'Active API key not found' });

  await db.revokeApiKey(existing.id);
  const { rawKey, prefix, hash } = generateScopedApiKey();
  const rotated = await db.createApiKey({
    tenant_id: existing.tenant_id,
    name: `${existing.name} (rotated)`,
    key_prefix: prefix,
    key_hash: hash,
    scopes: existing.scopes,
  });

  await db.recordAuditLog({
    tenant_id: existing.tenant_id,
    actor: req.neoAuth!.actorLabel,
    action: 'POST /api/admin/keys/:id/rotate',
    resource: `key:${prefix}`,
    status_code: 201,
    metadata: { replacedKeyId: existing.id },
  });

  return res.status(201).json({ rawKey, key: { ...rotated, key_hash: undefined } });
});

adminRouter.delete('/keys/:id', requireAdminConsoleAuth, async (req, res) => {
  const db = await getDb();
  const ok = await db.revokeApiKey(String(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Active key not found' });
  return res.json({ revoked: true });
});

const createTenantSchema = z.object({
  name: z.string().min(2).max(80),
  slug: z.string().min(2).max(40).regex(/^[a-z0-9-]+$/),
  workspace_language: z.enum(['en', 'fa', 'ar', 'nl']).default('en'),
  rate_limit_rpm: z.number().int().min(10).max(5000).default(120),
  pii_redaction: z.boolean().default(false),
});

adminRouter.post('/tenants', requireAdminConsoleAuth, async (req, res) => {
  const parsed = createTenantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid tenant payload', issues: parsed.error.issues });
  const db = await getDb();
  try {
    const tenant = await db.createTenant({
      name: parsed.data.name,
      slug: parsed.data.slug,
      workspace_language: parsed.data.workspace_language,
      webhook_url: null,
      webhook_secret: null,
      pii_redaction: parsed.data.pii_redaction,
      rate_limit_rpm: parsed.data.rate_limit_rpm,
    });
    return res.status(201).json({ tenant });
  } catch (err) {
    return res.status(409).json({ error: err instanceof Error ? err.message : 'Tenant slug conflict' });
  }
});

const updateTenantSchema = z.object({
  workspace_language: z.enum(['en', 'fa', 'ar', 'nl']).optional(),
  webhook_url: z.string().nullable().optional(),
  webhook_secret: z.string().nullable().optional(),
  pii_redaction: z.boolean().optional(),
  rate_limit_rpm: z.number().int().min(10).max(5000).optional(),
});

adminRouter.patch('/tenants/:id', requireAdminConsoleAuth, async (req, res) => {
  const parsed = updateTenantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid tenant update', issues: parsed.error.issues });

  if (parsed.data.webhook_url) {
    const check = await validateExternalUrlAsync(parsed.data.webhook_url);
    if (!check.valid) return res.status(400).json({ error: `Invalid webhook URL: ${check.reason}` });
  }

  const db = await getDb();
  const updated = await db.updateTenant(String(req.params.id), parsed.data);
  if (!updated) return res.status(404).json({ error: 'Tenant not found' });
  return res.json({ tenant: { ...updated, webhook_secret: updated.webhook_secret ? '********' : null } });
});

adminRouter.post('/tenants/:id/sign-webhook-preview', requireAdminConsoleAuth, async (req, res) => {
  const db = await getDb();
  const tenant = await db.getTenantById(String(req.params.id));
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  const payload = JSON.stringify(req.body?.payload || { event: 'neos.ping', timestamp: new Date().toISOString() });
  const secret = tenant.webhook_secret || 'neos_webhook_preview_secret';
  const signed = signWebhookPayload(payload, secret);
  return res.json({ payload, header: signed.header, signature: signed.signature, timestamp: signed.timestamp });
});

const createStreamSchema = z.object({
  topic: z.string().min(3).max(200),
  category: z.enum(['engineering', 'business', 'custom']).default('custom'),
  interval_minutes: z.number().int().min(5).max(1440).default(120),
});

adminRouter.post('/streams', requireAdminConsoleAuth, async (req, res) => {
  const parsed = createStreamSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid topic stream', issues: parsed.error.issues });
  const db = await getDb();
  const stream = await db.createTopicStream(parsed.data);
  res.status(201).json({ stream });
});

adminRouter.patch('/streams/:id', requireAdminConsoleAuth, async (req, res) => {
  const db = await getDb();
  const updated = await db.toggleTopicStream(String(req.params.id), Boolean(req.body?.enabled));
  if (!updated) return res.status(404).json({ error: 'Topic stream not found' });
  res.json({ stream: updated });
});

// Autonomous Scheduler management
adminRouter.get('/scheduler', requireAdminConsoleAuth, async (_req, res) => {
  const db = await getDb();
  const jobs = await db.listScheduledJobs();
  res.json({ jobs });
});

adminRouter.patch('/scheduler/:id', requireAdminConsoleAuth, async (req, res) => {
  const db = await getDb();
  const patch: { enabled?: boolean; interval_ms?: number } = {};
  if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
  if (typeof req.body?.interval_ms === 'number' && req.body.interval_ms >= 30_000) {
    patch.interval_ms = Math.round(req.body.interval_ms);
  }
  const updated = await db.updateScheduledJob(String(req.params.id), patch);
  if (!updated) return res.status(404).json({ error: 'Scheduled job not found' });
  return res.json({ job: updated });
});

adminRouter.post('/scheduler/tick', requireAdminConsoleAuth, async (req, res) => {
  const result = await autonomousScheduler.tick(Boolean(req.body?.force));
  res.json(result);
});
