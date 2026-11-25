import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/adapter.ts';
import { forgeDynamicEndpoint, invokeDynamicEndpoint } from '../forge/generator.ts';
import { checkRateLimit, requireApiGatewayAuth } from '../security/auth.ts';

export const forgeRouter = Router();

forgeRouter.get('/forge/endpoints', requireApiGatewayAuth('read'), async (_req, res) => {
  const db = await getDb();
  const endpoints = await db.listDynamicApis();
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
  const updated = await db.toggleDynamicApi(String(req.params.slug), enabled);
  if (!updated) return res.status(404).json({ error: 'Dynamic endpoint not found' });
  return res.json({ endpoint: updated });
});

forgeRouter.get('/openapi.json', async (_req, res) => {
  const db = await getDb();
  const dynamicApis = await db.listDynamicApis();

  const paths: Record<string, unknown> = {
    '/api/v1/chat/stream': {
      post: { summary: 'Multilingual context-aware SSE streaming chat', tags: ['Core'] },
    },
    '/api/v1/business/analyze': {
      post: { summary: 'Deep multi-module business & accounting audit', tags: ['Business Intelligence'] },
    },
    '/api/v1/engineer/task': {
      post: { summary: 'Autonomous Plan->Code->Test->Fix software engineering task', tags: ['Engineer'] },
    },
    '/api/v1/knowledge/query': {
      post: { summary: 'Semantic + Procedural + Episodic RAG search', tags: ['Knowledge'] },
    },
    '/api/v1/knowledge/learn': {
      post: { summary: 'Trigger live internet research & distillation', tags: ['Knowledge'] },
    },
    '/api/v1/forge/create': {
      post: { summary: 'Synthesize, test in sandbox, and hot-register a new API', tags: ['API Forge'] },
    },
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
      title: 'Neo Gateway & Autonomous API Forge',
      version: '1.0.0',
      description: 'External cognitive brain API for Neos Business Operations OS.',
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
  const db = await getDb();
  const api = await db.getDynamicApiBySlug(slug);
  if (!api) {
    return res.status(404).json({ error: `Dynamic endpoint '/api/v1/custom/${slug}' not found` });
  }

  const limit = checkRateLimit(`custom:${slug}:${req.neoAuth!.actorLabel}`, api.rate_limit_rpm);
  if (!limit.allowed) {
    return res.status(429).json({ error: 'Dynamic endpoint rate limit exceeded', retryAfterMs: limit.resetMs });
  }

  const payload = req.method === 'GET' ? req.query : req.body;
  const result = await invokeDynamicEndpoint(slug, payload);

  await db.recordAuditLog({
    tenant_id: req.neoAuth!.tenant.id,
    actor: req.neoAuth!.actorLabel,
    action: `${req.method} /api/v1/custom/${slug}`,
    resource: `custom:${slug}`,
    status_code: result.status,
    metadata: { ok: result.status === 200 },
  });

  return res.status(result.status).json(result.body);
});
