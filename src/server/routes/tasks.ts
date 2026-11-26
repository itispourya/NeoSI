import { Router } from 'express';
import { z } from 'zod';
import { agentRuntime } from '../agent/runtime.ts';
import { getDb } from '../db/adapter.ts';
import { requireApiGatewayAuth } from '../security/auth.ts';
import { asyncHandler } from '../security/headers.ts';

export const tasksRouter = Router();

const createTaskSchema = z.object({
  goal: z.string().min(4).max(8000),
  autonomy: z.enum(['low', 'balanced', 'high']).default('balanced'),
  priority: z.enum(['urgent_maintenance', 'user_task', 'scheduled_task', 'internal_improvement']).default('user_task'),
  budgets: z
    .object({
      maxSteps: z.number().int().min(3).max(30).optional(),
      maxToolCalls: z.number().int().min(1).max(20).optional(),
      maxDurationMs: z.number().int().min(2000).max(180_000).optional(),
    })
    .optional(),
});

tasksRouter.post('/tasks', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const parsed = createTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid task payload', issues: parsed.error.issues });
  }

  const tenant = req.neoAuth!.tenant;
  const task = await agentRuntime.createAndStartTask({
    tenantId: tenant.id,
    actor: req.neoAuth!.actorLabel,
    goal: parsed.data.goal,
    autonomy: parsed.data.autonomy,
    priority: parsed.data.priority,
    scopes: req.neoAuth!.scopes,
    budgets: parsed.data.budgets,
  });

  const db = await getDb();
  await db.recordAuditLog({
    tenant_id: tenant.id,
    actor: req.neoAuth!.actorLabel,
    action: 'POST /api/v1/tasks',
    resource: `task:${task.id}`,
    status_code: 201,
    metadata: { autonomy: task.autonomy, priority: task.priority },
  });

  return res.status(201).json({ task });
}));

tasksRouter.get('/tasks', requireApiGatewayAuth('read'), asyncHandler(async (req, res) => {
  const db = await getDb();
  const limit = Math.min(100, Number(req.query.limit || 30));
  const tasks = await db.listTasks(req.neoAuth!.tenant.id, { limit });
  res.json({ tasks });
}));

tasksRouter.get('/tasks/:id', requireApiGatewayAuth('read'), asyncHandler(async (req, res) => {
  const db = await getDb();
  const taskId = String(req.params.id);
  const tenantId = req.neoAuth!.tenant.id;
  const task = await db.getTaskById(taskId, tenantId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const [steps, events] = await Promise.all([
    db.listTaskSteps(task.id, tenantId),
    db.listTaskEvents(task.id, tenantId, 100),
  ]);
  return res.json({ task, steps, events });
}));

tasksRouter.post('/tasks/:id/cancel', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const updated = await agentRuntime.cancelTask(String(req.params.id), req.neoAuth!.tenant.id);
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  return res.json({ task: updated });
}));

tasksRouter.post('/tasks/:id/resume', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const updated = await agentRuntime.resumeTask(String(req.params.id), req.neoAuth!.tenant.id, req.neoAuth!.actorLabel, req.neoAuth!.scopes);
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  return res.json({ task: updated });
}));

tasksRouter.get('/tasks/:id/events', requireApiGatewayAuth('read'), asyncHandler(async (req, res) => {
  const db = await getDb();
  const taskId = String(req.params.id);
  const tenantId = req.neoAuth!.tenant.id;
  const task = await db.getTaskById(taskId, tenantId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const send = (evtType: string, data: unknown) => {
    if (!res.writableEnded) {
      res.write(`event: ${evtType}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  const history = await db.listTaskEvents(task.id, tenantId, 100);
  for (const evt of history) {
    send('task_event', evt);
  }

  if (task.status === 'completed' || task.status === 'partial' || task.status === 'failed' || task.status === 'cancelled') {
    send('task_done', { status: task.status, result: task.result, error: task.error });
    return res.end();
  }

  const unsubscribe = agentRuntime.subscribeTaskEvents(task.id, (evt) => {
    if (res.writableEnded) return;
    send('task_event', evt);
    if (evt.event_type === 'task.completed' || evt.event_type === 'task.partial' || evt.event_type === 'task.failed' || evt.event_type === 'task.cancelled') {
      send('task_done', { eventType: evt.event_type, payload: evt.payload });
      unsubscribe();
      clearTimeout(safetyTimer);
      if (!res.writableEnded) res.end();
    }
  });

  const safetyTimer = setTimeout(() => {
    unsubscribe();
    send('task_timeout', { message: 'SSE stream window closed' });
    if (!res.writableEnded) res.end();
  }, 45_000);

  // Keep the event subscription alive for the response lifetime; the request body completes immediately.
  res.on('close', () => {
    clearTimeout(safetyTimer);
    unsubscribe();
  });
}));

const createObjectiveSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(3).max(4000),
  category: z.string().min(2).max(80).default('general'),
  priority_score: z.number().min(0).max(1).default(0.7),
  value_score: z.number().min(0).max(1).default(0.7),
  urgency_score: z.number().min(0).max(1).default(0.5),
  uncertainty_score: z.number().min(0).max(1).default(0.3),
  success_criteria: z.string().max(1000).default(''),
  compute_budget_ms: z.number().int().min(1000).max(600_000).default(30_000),
});

tasksRouter.get('/objectives', requireApiGatewayAuth('read'), asyncHandler(async (req, res) => {
  const db = await getDb();
  const limit = Math.min(100, Number(req.query.limit || 30));
  const objectives = await db.listObjectives(req.neoAuth!.tenant.id, { limit });
  return res.json({ objectives });
}));

tasksRouter.post('/objectives', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const parsed = createObjectiveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid objective payload', issues: parsed.error.issues });
  }
  const db = await getDb();
  const objective = await db.createObjective({
    tenant_id: req.neoAuth!.tenant.id,
    title: parsed.data.title,
    description: parsed.data.description,
    category: parsed.data.category,
    priority_score: parsed.data.priority_score,
    value_score: parsed.data.value_score,
    urgency_score: parsed.data.urgency_score,
    uncertainty_score: parsed.data.uncertainty_score,
    progress_pct: 0,
    status: 'active',
    success_criteria: parsed.data.success_criteria,
    compute_budget_ms: parsed.data.compute_budget_ms,
    compute_used_ms: 0,
    linked_task_ids: [],
    linked_research_ids: [],
    knowledge_gaps: [],
    last_evaluated_at: new Date().toISOString(),
  });
  return res.status(201).json({ objective });
}));

const patchObjectiveSchema = z.object({
  status: z.enum(['active', 'paused', 'achieved', 'abandoned', 'blocked']).optional(),
  progress_pct: z.number().min(0).max(100).optional(),
  priority_score: z.number().min(0).max(1).optional(),
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(3).max(4000).optional(),
});

tasksRouter.patch('/objectives/:id', requireApiGatewayAuth('write'), asyncHandler(async (req, res) => {
  const parsed = patchObjectiveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid objective update', issues: parsed.error.issues });
  }
  const db = await getDb();
  const updated = await db.updateObjective(String(req.params.id), req.neoAuth!.tenant.id, {
    ...parsed.data,
    last_evaluated_at: new Date().toISOString(),
  });
  if (!updated) return res.status(404).json({ error: 'Objective not found' });
  return res.json({ objective: updated });
}));
