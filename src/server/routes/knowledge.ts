import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/adapter.ts';
import type { MemoryType } from '../db/schema.ts';
import { evaluateSkill } from '../evolution/pipeline.ts';
import { embeddingEngine } from '../inference/embeddings.ts';
import { knowledgeDaemon } from '../knowledge/daemon.ts';
import { knowledgeGraph } from '../knowledge/graph.ts';
import { storeMemory } from '../knowledge/memory.ts';
import { runAutonomousResearch } from '../knowledge/research.ts';
import { extractTextFromPdfBuffer } from '../multimodal/pdf.ts';
import { distillTextLocally } from '../neo/sovereignEngine.ts';
import { fetchCleanUrlContent } from '../search/webSearch.ts';
import { requireAdminConsoleAuth, requireApiGatewayAuth } from '../security/auth.ts';

export const knowledgeRouter = Router();

const researchSchema = z.object({
  query: z.string().min(3).max(600),
  urls: z.array(z.string().url()).max(3).optional(),
});

knowledgeRouter.post('/research', requireApiGatewayAuth('write'), async (req, res) => {
  const parsed = researchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid research payload', issues: parsed.error.issues });
  try {
    const report = await runAutonomousResearch({
      tenantId: req.neoAuth!.tenant.id,
      query: parsed.data.query,
      urls: parsed.data.urls,
    });
    return res.status(201).json({ report });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

knowledgeRouter.get('/research', requireApiGatewayAuth('read'), async (req, res) => {
  const db = await getDb();
  const reports = await db.listResearchReports(req.neoAuth!.tenant.id, 30);
  res.json({ reports });
});

knowledgeRouter.get('/research/:id', requireApiGatewayAuth('read'), async (req, res) => {
  const db = await getDb();
  const report = await db.getResearchReportById(String(req.params.id), req.neoAuth!.tenant.id);
  if (!report) return res.status(404).json({ error: 'Research report not found' });
  return res.json({ report });
});

const ingestSchema = z.object({
  topic: z.string().min(2).max(160),
  title: z.string().min(2).max(200).optional(),
  text: z.string().optional(),
  url: z.string().url().optional(),
  pdfBase64: z.string().optional(),
  sourceType: z.enum(['document', 'url', 'pdf', 'note']).optional(),
});

knowledgeRouter.post('/knowledge/ingest', requireApiGatewayAuth('write'), async (req, res) => {
  const parsed = ingestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid ingest payload', issues: parsed.error.issues });

  const tenantId = req.neoAuth!.tenant.id;
  let content = parsed.data.text || '';
  let sourceUrl = parsed.data.url || null;
  let title = parsed.data.title || parsed.data.topic;

  try {
    if (parsed.data.url) {
      const fetched = await fetchCleanUrlContent(parsed.data.url);
      content = fetched.text;
      sourceUrl = fetched.finalUrl;
      title = parsed.data.title || `Source: ${fetched.finalUrl}`;
    } else if (parsed.data.pdfBase64) {
      const buf = Buffer.from(parsed.data.pdfBase64, 'base64');
      const pdf = extractTextFromPdfBuffer(buf);
      content = pdf.text;
      if (!content) {
        return res.status(422).json({ error: 'No extractable text found in PDF payload (scanned image-only PDFs require local OCR binary).' });
      }
    }

    if (!content.trim()) {
      return res.status(400).json({ error: 'Provide non-empty text, url, or pdfBase64 to ingest.' });
    }

    const distilled = distillTextLocally(parsed.data.topic, title, content);
    const memory = await storeMemory({
      tenantId,
      memoryType: 'semantic',
      topic: parsed.data.topic,
      title: distilled.title,
      content: distilled.distilledSummary,
      structuredFacts: distilled.structuredFacts,
      sourceUrl,
      reliabilityScore: sourceUrl ? 0.8 : 0.88,
    });
    const graph = await knowledgeGraph.extractFromText(tenantId, `${title} ${distilled.distilledSummary}`, sourceUrl);

    return res.status(201).json({
      memory: { ...memory, embedding: undefined },
      graph,
      engine: 'neo-local-distiller',
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const queryKnowledgeSchema = z.object({
  query: z.string().min(2).max(1000),
  memoryType: z.enum(['working', 'episodic', 'semantic', 'procedural', 'personal', 'organizational', 'temporal']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

knowledgeRouter.post('/knowledge/query', requireApiGatewayAuth('read'), async (req, res) => {
  const parsed = queryKnowledgeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid query payload', issues: parsed.error.issues });

  const db = await getDb();
  const embedding = await embeddingEngine.embed(parsed.data.query);
  const matches = await db.searchMemories(embedding.vector, {
    queryEmbeddingModel: embedding.model,
    memoryType: parsed.data.memoryType as MemoryType | undefined,
    tenantId: req.neoAuth!.tenant.id,
    includeGlobal: true,
    queryText: parsed.data.query,
    limit: parsed.data.limit ?? 6,
    minScore: 0.01,
  });
  return res.json({ query: parsed.data.query, matches: matches.map((m) => ({ ...m, embedding: undefined })) });
});

knowledgeRouter.get('/knowledge/search', requireApiGatewayAuth('read'), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query parameter q is required' });
  const db = await getDb();
  const emb = await embeddingEngine.embed(q);
  const matches = await db.searchMemories(emb.vector, {
    queryEmbeddingModel: emb.model,
    tenantId: req.neoAuth!.tenant.id,
    includeGlobal: true,
    queryText: q,
    limit: Math.min(20, Number(req.query.limit || 8)),
    minScore: 0.01,
  });
  return res.json({ query: q, matches: matches.map((m) => ({ ...m, embedding: undefined })) });
});

knowledgeRouter.post('/knowledge/learn', requireApiGatewayAuth('write'), async (req, res) => {
  const topic = String(req.body?.topic || '').trim();
  if (topic.length < 3) return res.status(400).json({ error: 'Topic must be at least 3 characters' });
  try {
    const result = await knowledgeDaemon.triggerManualLearn(topic, typeof req.body?.streamId === 'string' ? req.body.streamId : undefined, req.neoAuth!.tenant.id);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

knowledgeRouter.get('/knowledge/sources', requireApiGatewayAuth('read'), async (req, res) => {
  const db = await getDb();
  const sources = await db.listKnowledgeSources(req.neoAuth!.tenant.id, 50);
  res.json({ sources });
});

// Skills Registry endpoints
knowledgeRouter.get('/skills', requireApiGatewayAuth('read'), async (_req, res) => {
  const db = await getDb();
  const skills = await db.listSkills();
  res.json({ skills });
});

const skillCreateSchema = z.object({
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
  title: z.string().min(3).max(160),
  domain: z.string().min(2).max(80),
  format: z.enum(['markdown', 'json']).default('markdown'),
  content: z.string().min(20).max(20000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

knowledgeRouter.post('/skills', requireAdminConsoleAuth, async (req, res) => {
  const parsed = skillCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid skill payload', issues: parsed.error.issues });
  const db = await getDb();
  const skill = await db.upsertSkill({
    slug: parsed.data.slug,
    title: parsed.data.title,
    domain: parsed.data.domain,
    version: 1,
    format: parsed.data.format,
    content: parsed.data.content,
    metadata: parsed.data.metadata || {},
  });
  return res.status(201).json({ skill });
});

knowledgeRouter.get('/skills/:id', requireApiGatewayAuth('read'), async (req, res) => {
  const db = await getDb();
  const skill = await db.getSkillByIdOrSlug(String(req.params.id));
  if (!skill) return res.status(404).json({ error: 'Skill not found' });
  return res.json({ skill });
});

knowledgeRouter.patch('/skills/:id', requireAdminConsoleAuth, async (req, res) => {
  const db = await getDb();
  const updated = await db.updateSkillById(String(req.params.id), {
    title: typeof req.body?.title === 'string' ? req.body.title : undefined,
    domain: typeof req.body?.domain === 'string' ? req.body.domain : undefined,
    content: typeof req.body?.content === 'string' ? req.body.content : undefined,
    metadata: req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : undefined,
  });
  if (!updated) return res.status(404).json({ error: 'Skill not found' });
  return res.json({ skill: updated });
});

knowledgeRouter.post('/skills/:id/evaluate', requireAdminConsoleAuth, async (req, res) => {
  const result = await evaluateSkill(String(req.params.id));
  if (!result.skill) return res.status(404).json({ error: 'Skill not found' });
  return res.json(result);
});
