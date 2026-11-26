import { Router } from 'express';
import { agentRuntime } from '../agent/runtime.ts';
import { env, getConfiguredSubsystems } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import { inspectHardware } from '../inference/hardware.ts';
import { neoInferenceEngine } from '../inference/registry.ts';
import { getCapabilityRegistry } from '../multimodal/capabilities.ts';
import { requireApiGatewayAuth } from '../security/auth.ts';

export const systemRouter = Router();

systemRouter.get('/health', async (_req, res) => {
  // Public liveness endpoint: do not expose tenant memory volume, task activity, or infrastructure details.
  res.json({
    status: 'ok',
    service: 'neo',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

systemRouter.get('/ready', async (_req, res) => {
  try {
    const db = await getDb();
    await db.listTenants();
    res.json({
      ready: true,
      status: 'ready',
      service: 'neo',
      storage: db.mode,
      sandboxMode: env.sandboxMode,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Neo Readiness] Database readiness probe failed:', err);
    res.status(503).json({
      ready: false,
      status: 'degraded',
      service: 'neo',
      error: 'readiness_check_failed',
      timestamp: new Date().toISOString(),
    });
  }
});

systemRouter.get('/status', requireApiGatewayAuth('read'), async (_req, res) => {
  const [db, hardware, runtimeHealth] = await Promise.all([
    getDb(),
    inspectHardware(),
    neoInferenceEngine.listRuntimeHealth(),
  ]);
  const subsystems = getConfiguredSubsystems();
  res.json({
    service: 'neo',
    storage: db.mode,
    sandboxMode: env.sandboxMode,
    runtimeDefault: env.runtimeDefault,
    subsystems,
    hardware,
    runtimes: runtimeHealth,
    activeTasks: agentRuntime.getActiveTaskCount(),
    timestamp: new Date().toISOString(),
  });
});

systemRouter.get('/capabilities', requireApiGatewayAuth('read'), async (_req, res) => {
  const capabilities = await getCapabilityRegistry();
  res.json({ capabilities });
});

systemRouter.get('/metrics', requireApiGatewayAuth('read'), async (req, res) => {
  const tenantId = req.neoAuth!.tenant.id;
  const db = await getDb();
  const [memoryCounts, telemetry, tasks, toolExecutions, hardware] = await Promise.all([
    db.countMemories(tenantId),
    db.getTelemetrySummary(tenantId),
    db.listTasks(tenantId, { limit: 100 }),
    db.listToolExecutions(tenantId, 100),
    inspectHardware(),
  ]);

  const tasksByStatus = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});
  const toolsOk = toolExecutions.filter((e) => e.ok).length;

  res.json({
    tenantId,
    hardware,
    memoryCounts,
    telemetry,
    tasks: {
      total: tasks.length,
      activeNow: agentRuntime.getActiveTaskCount(),
      byStatus: tasksByStatus,
    },
    tools: {
      recentExecutions: toolExecutions.length,
      successRate: toolExecutions.length ? Number(((toolsOk / toolExecutions.length) * 100).toFixed(1)) : 100,
    },

  });
});
