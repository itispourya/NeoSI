import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/adapter.ts';
import { forgeDynamicEndpoint, invokeDynamicEndpoint } from '../forge/generator.ts';
import { checkRateLimit, requireApiGatewayAuth } from '../security/auth.ts';

export const forgeRouter = Router();

forgeRouter.get('/forge/endpoints', requireApiGatewayAuth('admin'), async (req, res) => {
  const db = await getDb();
  const endpoints = await db.listDynamicApis(req.neoAuth!.tenant.id);
  res.json({ endpoints });
});

const forgeCreateSchema = z.object({
  requirement: z.string().min(8).max(4000),
});

forgeRouter.post('/forge/create', requireApiGatewayAuth('forge'), async (req, res) => {
  const parsed = forgeCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid forge requirement', issues: parsed.error.issues });
  }
  const tenant = req.neoAuth!.tenant;
  try {
    const endpoint = await forgeDynamicEndpoint(parsed.data.requirement, tenant.id);
    const db = await getDb();
    await db.recordAuditLog({
      tenant_id: tenant.id,
      actor: req.neoAuth!.actorLabel,
      action: 'POST /api/v1/forge/create',
      resource: `custom:${endpoint.slug}`,
      status_code: 201,
      metadata: { testsPassed: endpoint.test_report.passed, testsTotal: endpoint.test_report.total },
    });
    return res.status(201).json({ endpoint });
  } catch (err) {
    return res.status(422).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

forgeRouter.patch('/forge/:slug/toggle', requireApiGatewayAuth('forge'), async (req, res) => {
  const db = await getDb();
  const enabled = Boolean(req.body?.enabled);
  const updated = await db.toggleDynamicApi(String(req.params.slug), enabled, req.neoAuth!.tenant.id);
  if (!updated) return res.status(404).json({ error: 'Dynamic endpoint not found' });
  return res.json({ endpoint: updated });
});

forgeRouter.get('/openapi.json', requireApiGatewayAuth('admin'), async (_req, res) => {
  const db = await getDb();
  const dynamicApis = await db.listDynamicApis();

  const paths: Record<string, unknown> = {
    '/api/v1/health': { get: { summary: 'System health probe', tags: ['System'] } },
    '/api/v1/status': { get: { summary: 'Subsystem, hardware, and runtime health status', tags: ['System'] } },
    '/api/v1/capabilities': { get: { summary: 'Honest multimodal & runtime capability matrix', tags: ['System'] } },
    '/api/v1/metrics': { get: { summary: 'Telemetry, tasks, tools, and memory breakdown metrics', tags: ['System'] } },
    '/api/v1/chat': { post: { summary: 'Turn-based stateful cognitive chat with conversation persistence', tags: ['Core'] } },
    '/api/v1/chat/stream': { post: { summary: 'Multilingual context-aware SSE streaming chat', tags: ['Core'] } },
    '/api/v1/reason': { post: { summary: '13-stage structured reasoning with independent critic verification', tags: ['Cognitive'] } },
    '/api/v1/plan': { post: { summary: 'Dependency-aware DAG plan decomposition & budget check', tags: ['Cognitive'] } },
    '/api/v1/verify': { post: { summary: 'Independent critic check for grounding, arithmetic, and safety', tags: ['Cognitive'] } },
    '/api/v1/tasks': {
      post: { summary: 'Launch a durable asynchronous autonomous task', tags: ['Agent Runtime'] },
      get: { summary: 'List tenant autonomous tasks', tags: ['Agent Runtime'] },
    },
    '/api/v1/tasks/{id}': { get: { summary: 'Get task state, DAG steps, and checkpoints', tags: ['Agent Runtime'] } },
    '/api/v1/tasks/{id}/cancel': { post: { summary: 'Cancel running autonomous task', tags: ['Agent Runtime'] } },
    '/api/v1/tasks/{id}/events': { get: { summary: 'Subscribe to live SSE task execution events', tags: ['Agent Runtime'] } },
    '/api/v1/memory': { post: { summary: 'Store working/episodic/semantic/procedural/personal/org/temporal memory', tags: ['Memory'] } },
    '/api/v1/memory/search': { get: { summary: 'Hybrid BM25 + vector + temporal decay memory retrieval', tags: ['Memory'] } },
    '/api/v1/memory/consolidate': { post: { summary: 'Consolidate episodic/working memory and detect contradictions', tags: ['Memory'] } },
    '/api/v1/graph/entities': {
      post: { summary: 'Upsert Knowledge Graph entity', tags: ['Knowledge Graph'] },
      get: { summary: 'Search Knowledge Graph entities & relationships', tags: ['Knowledge Graph'] },
    },
    '/api/v1/graph/relationships': { post: { summary: 'Create Knowledge Graph relationship with contradiction check', tags: ['Knowledge Graph'] } },
    '/api/v1/graph/traverse/{entityId}': { get: { summary: 'BFS traverse Knowledge Graph neighborhood', tags: ['Knowledge Graph'] } },
    '/api/v1/research': { post: { summary: 'Run 16-stage autonomous web research & citation synthesis', tags: ['Research'] } },
    '/api/v1/knowledge/ingest': { post: { summary: 'Ingest text, URL, or base64 PDF document locally', tags: ['Knowledge'] } },
    '/api/v1/knowledge/learn': { post: { summary: 'Trigger live web research learning on topic', tags: ['Knowledge'] } },
    '/api/v1/skills': {
      get: { summary: 'List procedural skills registry', tags: ['Skills'] },
      post: { summary: 'Register or version a reusable skill', tags: ['Skills'] },
    },
    '/api/v1/tools': { get: { summary: 'List standardized Zod-validated Neo tools', tags: ['Tools'] } },
    '/api/v1/tools/{id}/execute': { post: { summary: 'Execute a registered tool with scope & schema validation', tags: ['Tools'] } },
    '/api/v1/mcp': { post: { summary: 'Model Context Protocol JSON-RPC tools/list & tools/call', tags: ['Tools'] } },
    '/api/v1/models': { get: { summary: 'List model registry, hardware compatibility, and benchmarks', tags: ['Models'] } },
    '/api/v1/models/evaluate': { post: { summary: 'Run 12-category Neo intelligence benchmark suite', tags: ['Models'] } },
    '/api/v1/models/install': { post: { summary: 'Verify hardware/license & pull/download open-weight model', tags: ['Models'] } },
    '/api/v1/models/activate': { post: { summary: 'Promote model to active role', tags: ['Models'] } },
    '/api/v1/models/rollback': { post: { summary: 'Rollback active model role to prior healthy model', tags: ['Models'] } },
    '/api/v1/evolution': { get: { summary: 'Inspect Layer A/B/C/D evolution proposals, experiments, and training jobs', tags: ['Evolution'] } },
    '/api/v1/evolution/proposals': { post: { summary: 'Create isolated git + measured benchmark code evolution proposal', tags: ['Evolution'] } },
    '/api/v1/evolution/training': { post: { summary: 'Prepare privacy-filtered JSONL SFT/LoRA training dataset & job', tags: ['Evolution'] } },
    '/api/v1/business/analyze': { post: { summary: 'Deep multi-module business & accounting audit', tags: ['Business Intelligence'] } },
    '/api/v1/engineer/task': { post: { summary: 'Autonomous Plan->Code->Test->Fix software engineering task', tags: ['Engineer'] } },
    '/api/v1/forge/create': { post: { summary: 'Synthesize, test in isolated subprocess sandbox, and register a new API', tags: ['API Forge'] } },
  };

  for (const api of dynamicApis) {
    if (!api.enabled) continue;
    paths[`/api/v1/custom/${api.slug}`] = {
      [api.method.toLowerCase()]: {
        summary: api.name,
        description: api.description,
        tags: ['Forged Custom APIs'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: api.input_schema } },
        },
        responses: {
          '200': {
            description: 'Execution output',
            content: { 'application/json': { schema: api.output_schema } },
          },
        },
      },
    };
  }

  res.json({
    openapi: '3.1.0',
    info: {
      title: 'Neo Autonomous Cognitive Engine & API Forge',
      version: '2.0.0',
      description: 'Independent, sovereign, continuously learning cognitive backend and API platform for Neos.',
    },
    components: {
      securitySchemes: {
        BearerApiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'neos_live_...',
        },
      },
    },
    paths,
  });
});

forgeRouter.all('/custom/:slug', requireApiGatewayAuth('read'), async (req, res) => {
  const slug = String(req.params.slug);
  const tenantId = req.neoAuth!.tenant.id;
  const db = await getDb();
  const api = await db.getDynamicApiBySlug(slug, tenantId);
  if (!api) {
    return res.status(404).json({ error: `Dynamic endpoint '/api/v1/custom/${slug}' not found` });
  }

  const limit = checkRateLimit(`custom:${slug}:${req.neoAuth!.actorLabel}`, api.rate_limit_rpm);
  if (!limit.allowed) {
    return res.status(429).json({ error: 'Dynamic endpoint rate limit exceeded', retryAfterMs: limit.resetMs });
  }

  const payload = req.method === 'GET' ? req.query : req.body;
  const result = await invokeDynamicEndpoint(slug, payload, tenantId);

  await db.recordAuditLog({
    tenant_id: tenantId,
    actor: req.neoAuth!.actorLabel,
    action: `${req.method} /api/v1/custom/${slug}`,
    resource: `custom:${slug}`,
    status_code: result.status,
    metadata: { ok: result.status === 200 },
  });

  return res.status(result.status).json(result.body);
});
