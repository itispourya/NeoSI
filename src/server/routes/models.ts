import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/adapter.ts';
import { runModelBenchmarkSuite } from '../inference/evaluator.ts';
import { inspectHardware } from '../inference/hardware.ts';
import { modelRegistry, neoInferenceEngine } from '../inference/registry.ts';
import type { ModelRole } from '../inference/types.ts';
import { requireApiGatewayAuth } from '../security/auth.ts';

export const modelsRouter = Router();

modelsRouter.get('/models', requireApiGatewayAuth('read'), async (_req, res) => {
  const db = await getDb();
  const [models, compatibility, evaluations, hardware] = await Promise.all([
    db.listModels(),
    modelRegistry.discoverCompatibleModels(),
    db.listModelEvaluations(undefined, 20),
    inspectHardware(),
  ]);
  res.json({ models, compatibility, evaluations, hardware });
});

modelsRouter.get('/models/health', requireApiGatewayAuth('read'), async (_req, res) => {
  const [runtimes, hardware] = await Promise.all([neoInferenceEngine.listRuntimeHealth(), inspectHardware()]);
  res.json({ runtimes, hardware });
});

const registerModelSchema = z.object({
  id: z.string().min(2).max(120),
  name: z.string().min(2).max(120),
  version: z.string().optional(),
  runtime: z.enum(['embedded', 'ollama', 'vllm', 'tensorrt-llm', 'transformers']),
  architecture: z.string().min(2).max(80),
  source_repo: z.string().min(2).max(200),
  license: z.string().min(2).max(80),
  quantization: z.string().optional(),
  context_length: z.number().int().min(512).max(200000).optional(),
  vram_gb: z.number().min(0).max(512).optional(),
  ram_gb: z.number().min(0).max(1024).optional(),
  roles: z.array(z.string()).optional(),
});

modelsRouter.post('/models', requireApiGatewayAuth('admin'), async (req, res) => {
  const parsed = registerModelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid model registration', issues: parsed.error.issues });
  try {
    const model = await modelRegistry.registerCandidateModel(parsed.data);
    return res.status(201).json({ model });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

modelsRouter.post('/models/install', requireApiGatewayAuth('admin'), async (req, res) => {
  const modelId = String(req.body?.modelId || '').trim();
  if (!modelId) return res.status(400).json({ error: 'modelId is required' });
  const result = await modelRegistry.installModel(modelId, {
    sourceUrl: typeof req.body?.sourceUrl === 'string' ? req.body.sourceUrl : undefined,
    expectedSha256: typeof req.body?.expectedSha256 === 'string' ? req.body.expectedSha256 : undefined,
  });
  return res.status(result.ok ? 200 : 400).json(result);
});

modelsRouter.post('/models/evaluate', requireApiGatewayAuth('write'), async (req, res) => {
  const modelId = String(req.body?.modelId || 'neo-embedded-core-v1');
  const evaluation = await runModelBenchmarkSuite(modelId);
  return res.json({ evaluation });
});

modelsRouter.post('/models/activate', requireApiGatewayAuth('admin'), async (req, res) => {
  const modelId = String(req.body?.modelId || '').trim();
  const role = (typeof req.body?.role === 'string' ? req.body.role : 'primary') as ModelRole;
  if (!modelId) return res.status(400).json({ error: 'modelId is required' });
  try {
    const deployment = await modelRegistry.activateModel(modelId, role);
    return res.json({ deployment });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

modelsRouter.post('/models/rollback', requireApiGatewayAuth('admin'), async (req, res) => {
  const role = (typeof req.body?.role === 'string' ? req.body.role : 'primary') as ModelRole;
  const deployment = await modelRegistry.rollbackModel(role);
  if (!deployment) return res.status(404).json({ error: 'No rollback target model found' });
  return res.json({ deployment });
});
