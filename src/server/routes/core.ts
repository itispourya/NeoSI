import { Router } from 'express';
import { z } from 'zod';
import { analyzeNeosBusiness, type BusinessPayload } from '../business/analyzer.ts';
import { detectLanguage, getLanguageDirective } from '../business/language.ts';
import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import { runAutonomousEngineeringTask } from '../engineer/agent.ts';
import { knowledgeDaemon } from '../knowledge/daemon.ts';
import { formatRagContextForPrompt, retrieveRagContext } from '../knowledge/memory.ts';
import { scheduleReflection } from '../knowledge/reflection.ts';
import { embedText, streamLlmCall } from '../llm/router.ts';
import { executePromotedModule, generateSovereignLocalResponse } from '../neo/sovereignEngine.ts';
import { requireApiGatewayAuth } from '../security/auth.ts';
import { redactPII, redactUnknownObject, signWebhookPayload, validateExternalUrl } from '../security/crypto.ts';
import { approveSelfUpgrade, rollbackSelfUpgrade, runSelfDiagnosticAndProposeUpgrade } from '../upgrades/pipeline.ts';

export const coreRouter = Router();

coreRouter.get('/health', async (_req, res) => {
  const db = await getDb();
  const memCounts = await db.countMemories();
  res.json({
    status: 'ok',
    service: 'neo',
    storage: db.mode,
    memoryCount: memCounts.total,
    timestamp: new Date().toISOString(),
  });
});

const chatSchema = z.object({
  message: z.string().min(1).max(16000),
  language: z.enum(['en', 'fa', 'ar', 'nl']).optional(),
  mode: z.enum(['neural', 'sovereign-local']).optional(),
  workspaceContext: z.record(z.string(), z.unknown()).optional(),
});

coreRouter.post('/chat/stream', requireApiGatewayAuth('read'), async (req, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
  }

  const tenant = req.neoAuth!.tenant;
  const rawMessage = tenant.pii_redaction ? redactPII(parsed.data.message) : parsed.data.message;
  const safeContext =
    parsed.data.workspaceContext && tenant.pii_redaction
      ? redactUnknownObject(parsed.data.workspaceContext)
      : parsed.data.workspaceContext;

  const language = detectLanguage(rawMessage, parsed.data.language || tenant.workspace_language);
  const useLocalOnly = parsed.data.mode === 'sovereign-local' || env.neoLocalOnly;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const start = Date.now();

  if (useLocalOnly) {
    const local = await generateSovereignLocalResponse(rawMessage, language, tenant.id);
    sendEvent('meta', {
      language,
      ragMatches: local.ragMatches,
      piiRedacted: tenant.pii_redaction,
      engine: 'neo-sovereign-local',
    });
    sendEvent('delta', { text: local.text });
    sendEvent('done', {
      provider: 'neo-sovereign-core',
      model: 'neo-vector-rag-v1',
      latencyMs: Date.now() - start,
    });
    return res.end();
  }

  const rag = await retrieveRagContext(rawMessage, tenant.id, 3);
  const ragPrompt = formatRagContextForPrompt(rag);

  sendEvent('meta', {
    language,
    ragMatches: rag.semantic.length + rag.procedural.length + rag.skills.length,
    piiRedacted: tenant.pii_redaction,
    engine: 'neo-neural-core',
  });

  try {
    const prompt = [
      safeContext ? `Active Neos Workspace Context:\n${JSON.stringify(safeContext, null, 2).slice(0, 4000)}` : '',
      ragPrompt ? `Retrieved Long-Term Memory & Skills:\n${ragPrompt}` : '',
      `User Request:\n${rawMessage}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    let finalMeta: Record<string, unknown> | undefined;
    for await (const part of streamLlmCall({
      tenantId: tenant.id,
      taskType: 'chat_stream',
      systemInstruction: `You are Neo — a completely independent, autonomous cognitive operating system and principal software & business architect for Neos. Never identify yourself as any other AI system or external model. Always speak strictly as Neo. ${getLanguageDirective(language)}`,
      prompt,
    })) {
      if (part.chunk) sendEvent('delta', { text: part.chunk });
      if (part.done) {
        finalMeta = {
          provider: 'neo-neural-core',
          model: 'neo-neural-4',
          promptTokens: part.done.promptTokens,
          completionTokens: part.done.completionTokens,
          estimatedCostUsd: part.done.estimatedCostUsd,
          latencyMs: part.done.latencyMs,
        };
      }
    }

    const db = await getDb();
    await db.recordAuditLog({
      tenant_id: tenant.id,
      actor: req.neoAuth!.actorLabel,
      action: 'POST /api/v1/chat/stream',
      resource: 'chat',
      status_code: 200,
      metadata: { language, ...(finalMeta || {}) },
    });

    await scheduleReflection({
      tenantId: tenant.id,
      taskType: 'chat',
      goal: rawMessage.slice(0, 120),
      outcome: 'success',
      durationMs: Date.now() - start,
      summary: `Streamed multilingual (${language}) response using ${rag.skills.length} skills.`,
    });

    sendEvent('done', finalMeta || { ok: true });
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendEvent('error', { error: msg });
    res.end();
  }
});

const businessSchema = z.object({
  workspaceName: z.string().optional(),
  language: z.enum(['en', 'fa', 'ar', 'nl']).optional(),
  question: z.string().optional(),
  accounting: z.record(z.string(), z.unknown()).optional(),
  crm: z.record(z.string(), z.unknown()).optional(),
  inventory: z.array(z.record(z.string(), z.unknown())).optional(),
  customData: z.record(z.string(), z.unknown()).optional(),
  deliverWebhook: z.boolean().optional(),
});

coreRouter.post('/business/analyze', requireApiGatewayAuth('write'), async (req, res) => {
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid business payload', issues: parsed.error.issues });
  }

  const tenant = req.neoAuth!.tenant;
  const payload = (tenant.pii_redaction ? redactUnknownObject(parsed.data) : parsed.data) as BusinessPayload & {
    deliverWebhook?: boolean;
  };

  try {
    const analysis = await analyzeNeosBusiness(payload, tenant.id);
    const db = await getDb();

    let webhookDelivered = false;
    if (parsed.data.deliverWebhook && tenant.webhook_url) {
      const check = validateExternalUrl(tenant.webhook_url);
      if (check.valid) {
        const bodyStr = JSON.stringify({ event: 'business.analysis.completed', tenantId: tenant.id, analysis });
        const secret = tenant.webhook_secret || env.webhookSecret || 'neos-default-signing-secret';
        const sig = signWebhookPayload(bodyStr, secret);
        try {
          const hookRes = await fetch(tenant.webhook_url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Neo-Signature': sig.header,
            },
            body: bodyStr,
            signal: AbortSignal.timeout(5000),
          });
          webhookDelivered = hookRes.ok;
        } catch {
          webhookDelivered = false;
        }
      }
    }

    await db.recordAuditLog({
      tenant_id: tenant.id,
      actor: req.neoAuth!.actorLabel,
      action: 'POST /api/v1/business/analyze',
      resource: 'business',
      status_code: 200,
      metadata: { language: analysis.language, webhookDelivered },
    });

    return res.json({ ...analysis, webhookDelivered });
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const engineerSchema = z.object({
  task: z.string().min(4).max(8000),
  stack: z.string().optional(),
  existingCode: z.string().optional(),
});

coreRouter.post('/engineer/task', requireApiGatewayAuth('write'), async (req, res) => {
  const parsed = engineerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid engineering task payload', issues: parsed.error.issues });
  }
  const tenant = req.neoAuth!.tenant;
  try {
    const result = await runAutonomousEngineeringTask({
      tenantId: tenant.id,
      task: parsed.data.task,
      stack: parsed.data.stack,
      existingCode: parsed.data.existingCode,
    });
    const db = await getDb();
    await db.recordAuditLog({
      tenant_id: tenant.id,
      actor: req.neoAuth!.actorLabel,
      action: 'POST /api/v1/engineer/task',
      resource: 'engineer',
      status_code: 200,
      metadata: { verified: result.verified, iterations: result.iterations },
    });
    return res.json(result);
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const queryKnowledgeSchema = z.object({
  query: z.string().min(2).max(1000),
  memoryType: z.enum(['episodic', 'semantic', 'procedural']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

coreRouter.post('/knowledge/query', requireApiGatewayAuth('read'), async (req, res) => {
  const parsed = queryKnowledgeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query payload', issues: parsed.error.issues });
  }
  const db = await getDb();
  const embedding = await embedText(parsed.data.query);
  const matches = await db.searchMemories(embedding, {
    memoryType: parsed.data.memoryType,
    tenantId: req.neoAuth!.tenant.id,
    limit: parsed.data.limit ?? 6,
    minScore: 0.01,
  });
  return res.json({ query: parsed.data.query, matches });
});

const learnKnowledgeSchema = z.object({
  topic: z.string().min(3).max(240),
  streamId: z.string().optional(),
});

coreRouter.post('/knowledge/learn', requireApiGatewayAuth('write'), async (req, res) => {
  const parsed = learnKnowledgeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid learn payload', issues: parsed.error.issues });
  }
  try {
    const result = await knowledgeDaemon.triggerManualLearn(parsed.data.topic, parsed.data.streamId);
    const db = await getDb();
    await db.recordAuditLog({
      tenant_id: req.neoAuth!.tenant.id,
      actor: req.neoAuth!.actorLabel,
      action: 'POST /api/v1/knowledge/learn',
      resource: 'knowledge',
      status_code: 200,
      metadata: { topic: parsed.data.topic, memoriesStored: result.memoriesStored },
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

coreRouter.get('/upgrades', requireApiGatewayAuth('read'), async (_req, res) => {
  const db = await getDb();
  const upgrades = await db.listUpgrades();
  res.json({ upgrades, autoMergeEnabled: env.autoMergeSafeUpgrades });
});

coreRouter.post('/upgrades/diagnose', requireApiGatewayAuth('write'), async (req, res) => {
  const focusArea = typeof req.body?.focusArea === 'string' ? req.body.focusArea.slice(0, 200) : undefined;
  try {
    const proposal = await runSelfDiagnosticAndProposeUpgrade(focusArea);
    const db = await getDb();
    await db.recordAuditLog({
      tenant_id: req.neoAuth!.tenant.id,
      actor: req.neoAuth!.actorLabel,
      action: 'POST /api/v1/upgrades/diagnose',
      resource: `upgrade:${proposal.id}`,
      status_code: 201,
      metadata: { status: proposal.status, branch: proposal.branch_name },
    });
    res.status(201).json({ proposal });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

coreRouter.post('/upgrades/:id/approve', requireApiGatewayAuth('admin'), async (req, res) => {
  try {
    const updated = await approveSelfUpgrade(String(req.params.id));
    if (!updated) return res.status(404).json({ error: 'Upgrade proposal not found' });
    const db = await getDb();
    await db.recordAuditLog({
      tenant_id: req.neoAuth!.tenant.id,
      actor: req.neoAuth!.actorLabel,
      action: 'POST /api/v1/upgrades/:id/approve',
      resource: `upgrade:${updated.id}`,
      status_code: 200,
      metadata: { status: updated.status },
    });
    return res.json({ proposal: updated });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

coreRouter.post('/upgrades/:id/rollback', requireApiGatewayAuth('admin'), async (req, res) => {
  const updated = await rollbackSelfUpgrade(String(req.params.id));
  if (!updated) return res.status(404).json({ error: 'Upgrade proposal not found' });
  const db = await getDb();
  await db.recordAuditLog({
    tenant_id: req.neoAuth!.tenant.id,
    actor: req.neoAuth!.actorLabel,
    action: 'POST /api/v1/upgrades/:id/rollback',
    resource: `upgrade:${updated.id}`,
    status_code: 200,
    metadata: { status: updated.status },
  });
  return res.json({ proposal: updated });
});

coreRouter.post('/modules/:id/execute', requireApiGatewayAuth('read'), async (req, res) => {
  const result = executePromotedModule(String(req.params.id), req.body ?? {});
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  return res.json({ output: result.output, durationMs: result.durationMs, logs: result.logs });
});
