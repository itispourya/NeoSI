import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import {
  approveCodeUpgrade,
  prepareAndRunTrainingJob,
  rejectCodeUpgrade,
  rollbackCodeUpgrade,
  runCodeEvolutionProposal,
  runConfigExperiment,
} from '../evolution/pipeline.ts';
import { requireApiGatewayAuth } from '../security/auth.ts';

export const evolutionRouter = Router();

evolutionRouter.get('/evolution', requireApiGatewayAuth('admin'), async (req, res) => {
  const db = await getDb();
  const [proposals, experiments, trainingJobs] = await Promise.all([
    db.listUpgrades(),
    db.listEvolutionExperiments(40),
    db.listTrainingJobs(req.neoAuth!.tenant.id, 30),
  ]);
  res.json({
    proposals,
    experiments,
    trainingJobs,
    autoMergeEnabled: env.autoMergeSafeUpgrades,
  });
});

evolutionRouter.post('/evolution/diagnose', requireApiGatewayAuth('admin'), async (req, res) => {
  const focusArea = typeof req.body?.focusArea === 'string' ? req.body.focusArea.slice(0, 200) : undefined;
  const proposal = await runCodeEvolutionProposal(focusArea);
  res.status(201).json({ proposal });
});

evolutionRouter.post('/evolution/proposals', requireApiGatewayAuth('admin'), async (req, res) => {
  const focusArea = typeof req.body?.focusArea === 'string' ? req.body.focusArea.slice(0, 200) : undefined;
  const proposal = await runCodeEvolutionProposal(focusArea);
  res.status(201).json({ proposal });
});

evolutionRouter.get('/evolution/proposals/:id', requireApiGatewayAuth('admin'), async (req, res) => {
  const db = await getDb();
  const proposal = await db.getUpgradeById(String(req.params.id));
  if (!proposal) return res.status(404).json({ error: 'Evolution proposal not found' });
  return res.json({ proposal });
});

evolutionRouter.post('/evolution/proposals/:id/approve', requireApiGatewayAuth('admin'), async (req, res) => {
  try {
    const proposal = await approveCodeUpgrade(String(req.params.id));
    if (!proposal) return res.status(404).json({ error: 'Evolution proposal not found' });
    return res.json({ proposal });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

evolutionRouter.post('/evolution/proposals/:id/reject', requireApiGatewayAuth('admin'), async (req, res) => {
  const proposal = await rejectCodeUpgrade(String(req.params.id));
  if (!proposal) return res.status(404).json({ error: 'Evolution proposal not found' });
  return res.json({ proposal });
});

evolutionRouter.post('/evolution/proposals/:id/rollback', requireApiGatewayAuth('admin'), async (req, res) => {
  const proposal = await rollbackCodeUpgrade(String(req.params.id));
  if (!proposal) return res.status(404).json({ error: 'Evolution proposal not found' });
  return res.json({ proposal });
});

const experimentSchema = z.object({
  title: z.string().min(3).max(160),
  hypothesis: z.string().min(4).max(400),
  configBefore: z.record(z.string(), z.unknown()).default({}),
  configAfter: z.record(z.string(), z.unknown()).default({}),
});

evolutionRouter.post('/evolution/experiments', requireApiGatewayAuth('admin'), async (req, res) => {
  const parsed = experimentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid experiment payload', issues: parsed.error.issues });
  const experiment = await runConfigExperiment(parsed.data);
  return res.status(201).json({ experiment });
});

const trainingSchema = z.object({
  baseModelId: z.string().min(2).max(120).default('qwen2.5:3b-instruct'),
  method: z.enum(['lora', 'qlora', 'sft', 'dataset_only']).default('lora'),
  minReliability: z.number().min(0).max(1).default(0.75),
});

evolutionRouter.post('/evolution/training', requireApiGatewayAuth('admin'), async (req, res) => {
  const parsed = trainingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid training payload', issues: parsed.error.issues });
  const job = await prepareAndRunTrainingJob({
    tenantId: req.neoAuth!.tenant.id,
    baseModelId: parsed.data.baseModelId,
    method: parsed.data.method,
    minReliability: parsed.data.minReliability,
  });
  return res.status(201).json({ job });
});

// Backward-compatible /upgrades aliases
evolutionRouter.get('/upgrades', requireApiGatewayAuth('admin'), async (_req, res) => {
  const db = await getDb();
  const upgrades = await db.listUpgrades();
  res.json({ upgrades, autoMergeEnabled: env.autoMergeSafeUpgrades });
});

evolutionRouter.post('/upgrades/diagnose', requireApiGatewayAuth('admin'), async (req, res) => {
  const focusArea = typeof req.body?.focusArea === 'string' ? req.body.focusArea.slice(0, 200) : undefined;
  const proposal = await runCodeEvolutionProposal(focusArea);
  res.status(201).json({ proposal });
});

evolutionRouter.post('/upgrades/:id/approve', requireApiGatewayAuth('admin'), async (req, res) => {
  try {
    const proposal = await approveCodeUpgrade(String(req.params.id));
    if (!proposal) return res.status(404).json({ error: 'Upgrade proposal not found' });
    return res.json({ proposal });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

evolutionRouter.post('/upgrades/:id/rollback', requireApiGatewayAuth('admin'), async (req, res) => {
  const proposal = await rollbackCodeUpgrade(String(req.params.id));
  if (!proposal) return res.status(404).json({ error: 'Upgrade proposal not found' });
  return res.json({ proposal });
});
