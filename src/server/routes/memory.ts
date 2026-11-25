import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/adapter.ts';
import type { MemoryType } from '../db/schema.ts';
import { embeddingEngine } from '../inference/embeddings.ts';
import { runMemoryConsolidation } from '../knowledge/consolidation.ts';
import { knowledgeGraph } from '../knowledge/graph.ts';
import { storeMemory } from '../knowledge/memory.ts';
import { requireApiGatewayAuth } from '../security/auth.ts';

export const memoryRouter = Router();

const memoryTypeEnum = z.enum(['working', 'episodic', 'semantic', 'procedural', 'personal', 'organizational', 'temporal']);

const createMemorySchema = z.object({
  memoryType: memoryTypeEnum,
  topic: z.string().min(2).max(120),
  title: z.string().min(2).max(200),
  content: z.string().min(3).max(16000),
  structuredFacts: z.record(z.string(), z.unknown()).optional(),
  sourceUrl: z.string().nullable().optional(),
  reliabilityScore: z.number().min(0).max(1).optional(),
  importanceScore: z.number().min(0).max(1).optional(),
  confidenceScore: z.number().min(0).max(1).optional(),
  validFrom: z.string().nullable().optional(),
  validTo: z.string().nullable().optional(),
});

memoryRouter.post('/memory', requireApiGatewayAuth('write'), async (req, res) => {
  const parsed = createMemorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid memory payload', issues: parsed.error.issues });

  const mem = await storeMemory({
    tenantId: req.neoAuth!.tenant.id,
    ...parsed.data,
  });
  return res.status(201).json({ memory: { ...mem, embedding: undefined } });
});

memoryRouter.get('/memory/search', requireApiGatewayAuth('read'), async (req, res) => {
  const q = String(req.query.q || req.query.query || '').trim();
  const memoryTypeRaw = typeof req.query.type === 'string' ? req.query.type : undefined;
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 15)));
  const includeGlobal = req.query.includeGlobal !== 'false';
  const db = await getDb();

  if (!q) {
    const items = await db.listMemories({
      tenantId: req.neoAuth!.tenant.id,
      includeGlobal,
      memoryType: memoryTypeRaw as MemoryType | undefined,
      limit,
    });
    return res.json({
      query: '',
      matches: items.map((m) => ({ ...m, embedding: undefined, similarity: 1, hybridScore: 1 })),
    });
  }

  const emb = await embeddingEngine.embed(q);
  const matches = await db.searchMemories(emb.vector, {
    tenantId: req.neoAuth!.tenant.id,
    includeGlobal,
    memoryType: memoryTypeRaw as MemoryType | undefined,
    queryText: q,
    limit,
    minScore: 0.01,
  });
  return res.json({
    query: q,
    matches: matches.map((m) => ({ ...m, embedding: undefined })),
  });
});

memoryRouter.post('/memory/consolidate', requireApiGatewayAuth('write'), async (_req, res) => {
  const summary = await runMemoryConsolidation();
  res.json(summary);
});

memoryRouter.get('/memory/:id', requireApiGatewayAuth('read'), async (req, res) => {
  const db = await getDb();
  const mem = await db.getMemoryById(String(req.params.id), req.neoAuth!.tenant.id, true);
  if (!mem) return res.status(404).json({ error: 'Memory not found' });
  return res.json({ memory: { ...mem, embedding: undefined } });
});

const patchMemorySchema = z.object({
  title: z.string().min(2).max(200).optional(),
  content: z.string().min(2).max(16000).optional(),
  topic: z.string().min(2).max(120).optional(),
  importance_score: z.number().min(0).max(1).optional(),
  confidence_score: z.number().min(0).max(1).optional(),
  valid_to: z.string().nullable().optional(),
});

memoryRouter.patch('/memory/:id', requireApiGatewayAuth('write'), async (req, res) => {
  const parsed = patchMemorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid memory update', issues: parsed.error.issues });

  const db = await getDb();
  const patch: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.content || parsed.data.title) {
    const existing = await db.getMemoryById(String(req.params.id), req.neoAuth!.tenant.id, false);
    if (!existing) return res.status(404).json({ error: 'Memory not found or cross-tenant modification forbidden' });
    const emb = await embeddingEngine.embed(`${parsed.data.topic || existing.topic} ${parsed.data.title || existing.title}\n${parsed.data.content || existing.content}`);
    patch.embedding = emb.vector;
  }

  const updated = await db.updateMemory(String(req.params.id), req.neoAuth!.tenant.id, patch);
  if (!updated) return res.status(404).json({ error: 'Memory not found' });
  return res.json({ memory: { ...updated, embedding: undefined } });
});

memoryRouter.delete('/memory/:id', requireApiGatewayAuth('write'), async (req, res) => {
  const db = await getDb();
  const hard = req.query.hard === 'true';
  const ok = await db.deleteMemory(String(req.params.id), req.neoAuth!.tenant.id, hard);
  if (!ok) return res.status(404).json({ error: 'Memory not found' });
  return res.json({ deleted: true, hard });
});

// Knowledge Graph endpoints (strictly tenant-isolated)
const entitySchema = z.object({
  name: z.string().min(1).max(160),
  entityType: z.string().min(1).max(80).default('concept'),
  aliases: z.array(z.string()).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

memoryRouter.post('/graph/entities', requireApiGatewayAuth('write'), async (req, res) => {
  const parsed = entitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid entity payload', issues: parsed.error.issues });
  const entity = await knowledgeGraph.upsertEntity({
    tenantId: req.neoAuth!.tenant.id,
    ...parsed.data,
  });
  return res.status(201).json({ entity: { ...entity, embedding: undefined } });
});

memoryRouter.get('/graph/entities', requireApiGatewayAuth('read'), async (req, res) => {
  const db = await getDb();
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const entityType = typeof req.query.type === 'string' ? req.query.type : undefined;
  const entities = q
    ? await knowledgeGraph.searchEntities(req.neoAuth!.tenant.id, q, 25)
    : await db.listEntities(req.neoAuth!.tenant.id, { entityType, limit: 50 });
  const relationships = await db.listRelationships(req.neoAuth!.tenant.id, undefined, 80);
  res.json({
    entities: entities.map((e) => ({ ...e, embedding: undefined })),
    relationships,
  });
});

const relationshipSchema = z.object({
  sourceEntityId: z.string().min(1),
  targetEntityId: z.string().min(1),
  relationType: z.string().min(1).max(100),
  properties: z.record(z.string(), z.unknown()).optional(),
  sourceUrl: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

memoryRouter.post('/graph/relationships', requireApiGatewayAuth('write'), async (req, res) => {
  const parsed = relationshipSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid relationship payload', issues: parsed.error.issues });
  const relationship = await knowledgeGraph.addRelationship({
    tenantId: req.neoAuth!.tenant.id,
    ...parsed.data,
  });
  return res.status(201).json({ relationship });
});

memoryRouter.get('/graph/traverse/:entityId', requireApiGatewayAuth('read'), async (req, res) => {
  const depth = Math.min(3, Math.max(1, Number(req.query.depth || 2)));
  const graph = await knowledgeGraph.traverse(req.neoAuth!.tenant.id, String(req.params.entityId), depth);
  return res.json(graph);
});
