import { EventEmitter } from 'node:events';
import { criticEngine } from '../cognitive/critic.ts';
import { taskPlanner, type PlannedStep } from '../cognitive/planner.ts';
import { getDb } from '../db/adapter.ts';
import type { TaskEventRecord, TaskPriority, TaskRecord, TaskStepRecord } from '../db/schema.ts';
import { neoInferenceEngine } from '../inference/registry.ts';
import { storeMemory } from '../knowledge/memory.ts';
import { sanitizeUntrustedContent } from '../security/promptGuard.ts';
import { toolRegistry } from '../tools/registry.ts';

export interface StartTaskInput {
  tenantId: string;
  actor: string;
  goal: string;
  autonomy?: 'low' | 'balanced' | 'high';
  priority?: TaskPriority;
  scopes?: string[];
  budgets?: Partial<{ maxSteps: number; maxToolCalls: number; maxDurationMs: number }>;
  deferExecution?: boolean;
}

const VALID_EXECUTION_SCOPES = new Set(['read', 'write', 'forge', 'admin']);

function normalizeExecutionScopes(scopes?: string[]): string[] {
  return Array.from(new Set((Array.isArray(scopes) ? scopes : ['read']).filter((scope) => VALID_EXECUTION_SCOPES.has(scope))));
}

function scopesFromCheckpoint(checkpoint: Record<string, unknown>): string[] {
  return normalizeExecutionScopes(Array.isArray(checkpoint.executionScopes) ? checkpoint.executionScopes as string[] : ['read']);
}

class DurableAgentRuntime {
  private events = new EventEmitter();
  private runningTaskIds = new Set<string>();
  private cancelledTaskIds = new Set<string>();

  subscribeTaskEvents(taskId: string, listener: (evt: TaskEventRecord) => void): () => void {
    const channel = `task:${taskId}`;
    this.events.on(channel, listener);
    return () => {
      this.events.off(channel, listener);
    };
  }

  hasActiveUserTasks(): boolean {
    return this.runningTaskIds.size > 0;
  }

  getActiveTaskCount(): number {
    return this.runningTaskIds.size;
  }

  private async emitEvent(taskId: string, tenantId: string, eventType: string, payload: Record<string, unknown>): Promise<TaskEventRecord> {
    const db = await getDb();
    const rec = await db.appendTaskEvent({
      task_id: taskId,
      tenant_id: tenantId,
      event_type: eventType,
      payload,
    });
    this.events.emit(`task:${taskId}`, rec);
    return rec;
  }

  async createAndStartTask(input: StartTaskInput): Promise<TaskRecord> {
    const db = await getDb();
    const autonomy = input.autonomy || 'balanced';
    const executionScopes = normalizeExecutionScopes(input.scopes);
    const planResult = await taskPlanner.buildAdaptivePlan(input.goal, autonomy, input.tenantId, executionScopes);
    const budgets = {
      maxSteps: input.budgets?.maxSteps ?? planResult.budgets.maxSteps,
      maxToolCalls: input.budgets?.maxToolCalls ?? planResult.budgets.maxToolCalls,
      maxDurationMs: input.budgets?.maxDurationMs ?? planResult.budgets.maxDurationMs,
    };

    const task = await db.createTask({
      tenant_id: input.tenantId,
      goal: input.goal,
      autonomy,
      priority: taskPlanner.selectPriority(input.priority),
      status: 'planning',
      plan: planResult.steps.map((s) => ({
        stepIndex: s.stepIndex,
        title: s.title,
        actionType: s.actionType,
        toolId: s.toolId,
        dependsOn: s.dependsOn,
      })),
      checkpoint: { lastCompletedStepIndex: -1, evidenceSnippets: [], executionScopes },
      result: null,
      verification: null,
      error: null,
      budgets,
      usage: { stepsExecuted: 0, toolCalls: 0, durationMs: 0, retries: 0 },
      loop_signature_counts: {},
    });

    for (const s of planResult.steps) {
      await db.upsertTaskStep({
        task_id: task.id,
        tenant_id: input.tenantId,
        step_index: s.stepIndex,
        title: s.title,
        action_type: s.actionType,
        tool_id: s.toolId ?? null,
        depends_on: s.dependsOn,
        status: 'pending',
        input: s.toolInput || {},
        output: null,
        error: null,
        attempts: 0,
        started_at: null,
        finished_at: null,
      });
    }

    await this.emitEvent(task.id, input.tenantId, 'task.created', {
      goal: task.goal,
      stepCount: planResult.steps.length,
      budgets,
      planValid: planResult.valid,
    });

    if (!planResult.valid) {
      const failed = await db.updateTask(task.id, {
        status: 'failed',
        error: `Plan validation failed: ${planResult.validationErrors.join('; ')}`,
        completed_at: new Date().toISOString(),
      });
      await this.emitEvent(task.id, input.tenantId, 'task.failed', { error: failed?.error });
      return failed || task;
    }

    if (!input.deferExecution) {
      queueMicrotask(() => {
        void this.executeTaskLoop(task.id, input.tenantId, input.actor, executionScopes);
      });
    }

    return task;
  }

  async cancelTask(taskId: string, tenantId: string): Promise<TaskRecord | null> {
    const db = await getDb();
    const existing = await db.getTaskById(taskId, tenantId);
    if (!existing) return null;
    if (existing.status === 'completed' || existing.status === 'partial' || existing.status === 'failed' || existing.status === 'cancelled') {
      return existing;
    }
    const updated = await db.updateTaskIfStatus(taskId, tenantId, ['planning', 'running'], {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    });
    if (!updated) return db.getTaskById(taskId, tenantId);
    this.cancelledTaskIds.add(taskId);
    await this.emitEvent(taskId, tenantId, 'task.cancelled', { reason: 'Cancelled by request' });
    return updated;
  }

  async resumeTask(taskId: string, tenantId: string, actor = 'system:resume', currentScopes: string[] = ['read']): Promise<TaskRecord | null> {
    const db = await getDb();
    const existing = await db.getTaskById(taskId, tenantId);
    if (!existing) return null;
    if (existing.status === 'completed' || existing.status === 'cancelled' || existing.status === 'running') return existing;
    if (!['failed', 'partial', 'planning'].includes(existing.status)) return existing;
    const savedScopes = normalizeExecutionScopes(Array.isArray(existing.checkpoint?.executionScopes)
      ? (existing.checkpoint.executionScopes as string[])
      : ['read']);
    // A new credential can only recover the intersection of its current scopes and the original grant.
    const effectiveScopes = normalizeExecutionScopes(currentScopes).filter((scope) => savedScopes.includes(scope));
    const queued = existing.status === 'planning'
      ? existing
      : await db.updateTaskIfStatus(taskId, tenantId, ['failed', 'partial'], {
          status: 'planning',
          error: null,
          completed_at: null,
        });
    if (!queued) return db.getTaskById(taskId, tenantId);
    this.cancelledTaskIds.delete(taskId);
    await this.emitEvent(taskId, tenantId, 'task.resumed', { actor, scopes: effectiveScopes });
    if (!this.runningTaskIds.has(taskId)) {
      queueMicrotask(() => {
        void this.executeTaskLoop(taskId, tenantId, actor, effectiveScopes);
      });
    }
    return db.getTaskById(taskId, tenantId);
  }

  async recoverInterruptedTasks(): Promise<number> {
    const db = await getDb();
    const [runningTasks, planningTasks] = await Promise.all([
      db.listTasks(undefined, { status: 'running', limit: 100 }),
      db.listTasks(undefined, { status: 'planning', limit: 100 }),
    ]);
    const interruptedMap = new Map<string, TaskRecord>();
    for (const t of [...runningTasks, ...planningTasks]) {
      interruptedMap.set(t.id, t);
    }
    const interrupted = Array.from(interruptedMap.values());
    for (const task of interrupted) {
      await this.emitEvent(task.id, task.tenant_id, 'task.recovered', {
        previousStatus: task.status,
        checkpoint: task.checkpoint,
      });
      if (!this.runningTaskIds.has(task.id)) {
        const reset = task.status === 'running'
          ? await db.updateTaskIfStatus(task.id, task.tenant_id, ['running'], {
              status: 'planning',
              error: 'Interrupted execution recovered with read-only permissions; resume with a fresh credential to regain previously granted write scopes.',
            })
          : task;
        if (!reset) continue;
        // Recovered tasks do not inherit historical write/admin privileges without a fresh credential.
        queueMicrotask(() => {
          void this.executeTaskLoop(task.id, task.tenant_id, 'system:recovery', ['read']);
        });
      }
    }
    return interrupted.length;
  }

  async executeTaskLoop(
    taskId: string,
    tenantId: string,
    actor = 'agent-runtime',
    scopes: string[] = ['read']
  ): Promise<TaskRecord | null> {
    if (this.runningTaskIds.has(taskId)) {
      const db = await getDb();
      return db.getTaskById(taskId, tenantId);
    }

    const db = await getDb();
    // Atomic claim: only a task in planning state may transition to running.
    const claimed = await db.updateTaskIfStatus(taskId, tenantId, ['planning'], { status: 'running' });
    if (!claimed) return db.getTaskById(taskId, tenantId);

    this.runningTaskIds.add(taskId);
    const startMs = Date.now();

    try {
      const task = claimed;
      const savedScopes = scopesFromCheckpoint(task.checkpoint);
      const grantedScopes = normalizeExecutionScopes(scopes);
      const effectiveScopes = grantedScopes.filter((scope) => savedScopes.includes(scope));
      const scopesForExecution = effectiveScopes;
      await this.emitEvent(task.id, tenantId, 'task.started', { goal: task.goal, scopes: scopesForExecution });

      const steps = await db.listTaskSteps(task.id, tenantId);
      const usage = { ...task.usage };
      const loopCounts = { ...(task.loop_signature_counts || {}) };
      const evidenceSnippets: string[] = Array.isArray(task.checkpoint?.evidenceSnippets)
        ? [...(task.checkpoint.evidenceSnippets as string[])]
        : [];
      const toolOutputs: Array<{ toolId: string; ok: boolean; output?: Record<string, unknown>; error?: string }> = [];
      let answerText = '';

      for (const step of steps) {
        if (step.status === 'completed' || step.status === 'skipped') continue;

        // Cancellation check
        const latestTask = await db.getTaskById(task.id, tenantId);
        if (this.cancelledTaskIds.has(task.id) || latestTask?.status === 'cancelled') {
          await this.emitEvent(task.id, tenantId, 'task.cancelled', { stepIndex: step.step_index });
          return latestTask;
        }

        // Budget enforcement
        const elapsed = Date.now() - startMs;
        const cumulativeDurationMs = Number(task.usage.durationMs || 0) + elapsed;
        if (usage.stepsExecuted >= task.budgets.maxSteps || cumulativeDurationMs > task.budgets.maxDurationMs) {
          const msg = `Execution budget exceeded (steps=${usage.stepsExecuted}/${task.budgets.maxSteps}, elapsed=${cumulativeDurationMs}ms)`;
          await db.updateTaskIfStatus(task.id, tenantId, ['running'], {
            status: 'failed',
            error: msg,
            usage: { ...usage, durationMs: cumulativeDurationMs },
            completed_at: new Date().toISOString(),
          });
          await this.emitEvent(task.id, tenantId, 'task.failed', { error: msg });
          return db.getTaskById(task.id, tenantId);
        }

        // Dependency readiness check (allow reason/verify to synthesize over available evidence once prior steps have settled)
        const freshSteps = await db.listTaskSteps(task.id, tenantId);
        const depsReady = step.depends_on.every((depIdx) => {
          const dep = freshSteps.find((s) => s.step_index === depIdx);
          return Boolean(dep && (dep.status === 'completed' || dep.status === 'skipped'));
        });
        if (!depsReady) continue;

        // Loop signature guard
        const sig = `${step.action_type}:${step.tool_id || 'none'}:${JSON.stringify(step.input).slice(0, 80)}`;
        const loopCheck = taskPlanner.detectLoop(loopCounts, sig, 3);
        if (loopCheck.looped) {
          const msg = `Loop guard aborted repeated step signature (${sig})`;
          await db.updateTaskIfStatus(task.id, tenantId, ['running'], {
            status: 'failed',
            error: msg,
            loop_signature_counts: loopCounts,
            completed_at: new Date().toISOString(),
          });
          await this.emitEvent(task.id, tenantId, 'task.loop_aborted', { signature: sig });
          return db.getTaskById(task.id, tenantId);
        }

        await db.upsertTaskStep({
          ...step,
          status: 'running',
          attempts: step.attempts + 1,
          started_at: new Date().toISOString(),
        });
        await this.emitEvent(task.id, tenantId, 'step.started', {
          stepIndex: step.step_index,
          title: step.title,
          actionType: step.action_type,
        });

        try {
          let stepOutput: Record<string, unknown> = {};
          if (step.action_type === 'reason') {
            const prompt = [
              evidenceSnippets.length > 0 ? `Retrieved Context & Evidence:\n${evidenceSnippets.join('\n')}` : '',
              `User Request: ${task.goal}`,
            ]
              .filter(Boolean)
              .join('\n\n');
            const inf = await neoInferenceEngine.infer({
              tenantId,
              role: 'reasoning',
              taskType: 'agent_task_synthesis',
              prompt,
            });
            answerText = inf.text;
            stepOutput = { answer: inf.text, runtime: inf.runtime, model: inf.modelId };
          } else if (step.action_type === 'verify') {
            const verdict = criticEngine.verify({
              goal: task.goal,
              draftResponse: answerText || evidenceSnippets.join('\n'),
              evidenceSnippets,
              toolOutputs,
            });
            stepOutput = verdict as unknown as Record<string, unknown>;
            await db.updateTaskIfStatus(task.id, tenantId, ['running'], { verification: stepOutput });
          } else if (step.tool_id) {
            if (usage.toolCalls >= task.budgets.maxToolCalls) {
              throw new Error(`Tool call budget (${task.budgets.maxToolCalls}) exceeded`);
            }
            // Retry up to 2 attempts on transient failure with bounded backoff
            let execRes = await toolRegistry.executeTool(step.tool_id, step.input, {
              tenantId,
              actor,
              taskId: task.id,
              scopes: scopesForExecution,
            });
            if (!execRes.ok && step.attempts === 0) {
              usage.retries++;
              await new Promise((r) => setTimeout(r, 150));
              execRes = await toolRegistry.executeTool(step.tool_id, step.input, {
                tenantId,
                actor,
                taskId: task.id,
                scopes: scopesForExecution,
              });
            }
            usage.toolCalls++;
            toolOutputs.push({ toolId: step.tool_id, ok: execRes.ok, output: execRes.output, error: execRes.error });
            if (!execRes.ok) {
              throw new Error(execRes.error || `Tool ${step.tool_id} failed`);
            }
            stepOutput = execRes.output || {};
            const wrapped = sanitizeUntrustedContent(JSON.stringify(stepOutput).slice(0, 700), `tool:${step.tool_id}`);
            evidenceSnippets.push(wrapped.wrappedData);
          }

          const afterExecution = await db.getTaskById(task.id, tenantId);
          if (this.cancelledTaskIds.has(task.id) || afterExecution?.status === 'cancelled') {
            await db.upsertTaskStep({
              ...step,
              status: 'failed',
              error: 'Task was cancelled while this step was executing.',
              attempts: step.attempts + 1,
              started_at: step.started_at || new Date().toISOString(),
              finished_at: new Date().toISOString(),
            });
            await this.emitEvent(task.id, tenantId, 'task.cancelled', { stepIndex: step.step_index });
            return afterExecution;
          }

          usage.stepsExecuted++;
          usage.durationMs = Number(task.usage.durationMs || 0) + (Date.now() - startMs);

          await db.upsertTaskStep({
            ...step,
            status: 'completed',
            output: stepOutput,
            error: null,
            attempts: step.attempts + 1,
            started_at: step.started_at || new Date().toISOString(),
            finished_at: new Date().toISOString(),
          });

          await db.updateTaskIfStatus(task.id, tenantId, ['running'], {
            checkpoint: { ...task.checkpoint, lastCompletedStepIndex: step.step_index, evidenceSnippets, executionScopes: savedScopes },
            usage,
            loop_signature_counts: loopCounts,
          });
          await this.emitEvent(task.id, tenantId, 'step.completed', {
            stepIndex: step.step_index,
            title: step.title,
            usage,
          });
        } catch (stepErr) {
          const latestAfterError = await db.getTaskById(task.id, tenantId);
          if (this.cancelledTaskIds.has(task.id) || latestAfterError?.status === 'cancelled') {
            await db.upsertTaskStep({
              ...step,
              status: 'failed',
              error: 'Task was cancelled while this step was executing.',
              attempts: step.attempts + 1,
              started_at: step.started_at || new Date().toISOString(),
              finished_at: new Date().toISOString(),
            });
            await this.emitEvent(task.id, tenantId, 'task.cancelled', { stepIndex: step.step_index });
            return latestAfterError;
          }
          const msg = stepErr instanceof Error ? stepErr.message : String(stepErr);
          await db.upsertTaskStep({
            ...step,
            status: 'failed',
            error: msg,
            attempts: step.attempts + 1,
            started_at: step.started_at || new Date().toISOString(),
            finished_at: new Date().toISOString(),
          });
          await this.emitEvent(task.id, tenantId, 'step.failed', { stepIndex: step.step_index, error: msg });
        }
      }

      const beforeFinalization = await db.getTaskById(task.id, tenantId);
      if (this.cancelledTaskIds.has(task.id) || beforeFinalization?.status === 'cancelled') return beforeFinalization;

      const cumulativeDurationAtFinalization = Number(task.usage.durationMs || 0) + (Date.now() - startMs);
      const finalVerification = criticEngine.verify({
        goal: task.goal,
        draftResponse: answerText || evidenceSnippets.join('\n'),
        evidenceSnippets,
        toolOutputs,
      });

      const finalSteps = await db.listTaskSteps(task.id, tenantId);
      const failedSteps = finalSteps.filter((s) => s.status === 'failed');
      const unresolvedSteps = finalSteps.filter((s) => s.status === 'pending' || s.status === 'running');
      const hasUsefulOutput = Boolean(answerText.trim() || evidenceSnippets.length > 0);
      const allStepsSettled = failedSteps.length === 0 && unresolvedSteps.length === 0;
      const withinDurationBudget = cumulativeDurationAtFinalization <= task.budgets.maxDurationMs;
      const finalStatus = allStepsSettled && finalVerification.passed && withinDurationBudget
        ? 'completed'
        : hasUsefulOutput || finalSteps.some((s) => s.status === 'completed')
          ? 'partial'
          : 'failed';
      const executionError = [
        ...failedSteps.map((s) => `Step ${s.step_index}: ${s.error || 'failed'}`),
        ...unresolvedSteps.map((s) => `Step ${s.step_index}: blocked by an incomplete dependency`),
        ...(!finalVerification.passed ? finalVerification.issues : []),
        ...(!withinDurationBudget ? [`Execution time budget exceeded at finalization (${cumulativeDurationAtFinalization}ms / ${task.budgets.maxDurationMs}ms).`] : []),
      ].filter(Boolean).join('; ') || null;
      const finalResult = {
        answer: answerText || evidenceSnippets.join('\n'),
        evidenceCount: evidenceSnippets.length,
        toolCalls: usage.toolCalls,
        verification: finalVerification,
        completedSteps: finalSteps.filter((s) => s.status === 'completed').length,
        failedSteps: failedSteps.length,
        unresolvedSteps: unresolvedSteps.length,
      };

      const completed = await db.updateTaskIfStatus(task.id, tenantId, ['running'], {
        status: finalStatus,
        result: finalResult,
        verification: finalVerification as unknown as Record<string, unknown>,
        error: finalStatus === 'completed' ? null : executionError || 'Task could not be fully verified.',
        usage: { ...usage, durationMs: Number(task.usage.durationMs || 0) + (Date.now() - startMs) },
        loop_signature_counts: loopCounts,
        completed_at: new Date().toISOString(),
      });

      if (!completed) return db.getTaskById(task.id, tenantId);

      if (hasUsefulOutput) {
        await storeMemory({
          tenantId,
          memoryType: 'episodic',
          topic: 'autonomous-task',
          title: `Task ${finalStatus}: ${task.goal.slice(0, 64)}`,
          content: `Goal: ${task.goal} | status=${finalStatus} | steps=${usage.stepsExecuted} | critic=${finalVerification.overallScore}%`,
          structuredFacts: { taskId: task.id, usage, criticScore: finalVerification.overallScore, status: finalStatus },
          reliabilityScore: Number((finalVerification.overallScore / 100).toFixed(2)),
          importanceScore: 0.72,
        });
      }

      const eventType = finalStatus === 'completed' ? 'task.completed' : finalStatus === 'partial' ? 'task.partial' : 'task.failed';
      await this.emitEvent(task.id, tenantId, eventType, {
        usage: completed?.usage,
        verification: finalVerification,
        error: completed?.error,
      });

      return completed;
    } catch (err) {
      const latest = await db.getTaskById(taskId, tenantId);
      if (this.cancelledTaskIds.has(taskId) || latest?.status === 'cancelled') return latest;
      const msg = err instanceof Error ? err.message : String(err);
      await db.updateTaskIfStatus(taskId, tenantId, ['running'], {
        status: 'failed',
        error: msg,
        completed_at: new Date().toISOString(),
      });
      await this.emitEvent(taskId, tenantId, 'task.failed', { error: msg });
      return db.getTaskById(taskId, tenantId);
    } finally {
      this.runningTaskIds.delete(taskId);
      this.cancelledTaskIds.delete(taskId);
    }
  }
}

export const agentRuntime = new DurableAgentRuntime();
