import { agentRuntime } from '../agent/runtime.ts';
import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import { evaluateSkill, runCodeEvolutionProposal } from '../evolution/pipeline.ts';
import { runMemoryConsolidation } from '../knowledge/consolidation.ts';
import { knowledgeDaemon } from '../knowledge/daemon.ts';
import { runModelBenchmarkSuite } from '../inference/evaluator.ts';

class AutonomousScheduler {
  private timer: NodeJS.Timeout | null = null;
  private runningKinds = new Set<string>();

  start(): void {
    if (!env.schedulerEnabled || this.timer) return;
    const tickMs = Math.max(10_000, env.schedulerTickMs);
    this.timer = setInterval(() => {
      void this.tick(false);
    }, tickMs);
    this.timer.unref?.();
    console.log(`[Neo Scheduler] Started priority-aware autonomous scheduler (tick=${tickMs}ms).`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async executeJobKind(jobKind: string): Promise<Record<string, unknown>> {
    switch (jobKind) {
      case 'knowledge_updates': {
        return knowledgeDaemon.runScheduledCycle();
      }
      case 'memory_consolidation': {
        const db = await getDb();
        const tenants = await db.listTenants();
        const summaries = [];
        for (const tenant of tenants) summaries.push(await runMemoryConsolidation(tenant.id));
        summaries.push(await runMemoryConsolidation('global'));
        return { workspacesProcessed: tenants.length, summaries };
      }
      case 'skill_evaluation': {
        const db = await getDb();
        const skills = await db.listSkills();
        const results = [];
        for (const s of skills.slice(0, 5)) {
          results.push(await evaluateSkill(s.id));
        }
        return { evaluated: results.length, passed: results.filter((r) => r.passed).length };
      }
      case 'system_diagnostics': {
        const evalRecord = await runModelBenchmarkSuite('neo-embedded-core-v1');
        return {
          modelId: evalRecord.model_id,
          overallScore: evalRecord.overall_score,
          passedCases: evalRecord.passed_cases,
          totalCases: evalRecord.total_cases,
        };
      }
      case 'evolution_proposals': {
        const proposal = await runCodeEvolutionProposal('scheduled_autonomous_diagnostics');
        return { proposalId: proposal.id, status: proposal.status, branch: proposal.branch_name };
      }
      default:
        throw new Error(`Unknown scheduled job kind: ${jobKind}`);
    }
  }

  async tick(forceRunAllDue = false): Promise<{ ran: string[]; skippedBusy: boolean }> {
    // Priority invariant: never starve active user tasks
    if (!forceRunAllDue && agentRuntime.hasActiveUserTasks()) {
      return { ran: [], skippedBusy: true };
    }

    const db = await getDb();
    const jobs = await db.listScheduledJobs();
    const now = Date.now();
    const ran: string[] = [];

    const priorityRank: Record<string, number> = {
      urgent_maintenance: 0,
      user_task: 1,
      scheduled_task: 2,
      internal_improvement: 3,
    };

    const sorted = jobs
      .filter((j) => j.enabled)
      .sort((a, b) => (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3));

    for (const job of sorted) {
      if (!forceRunAllDue && agentRuntime.hasActiveUserTasks()) break;
      const due = !job.next_run_at || new Date(job.next_run_at).getTime() <= now || forceRunAllDue;
      if (!due) continue;
      if (this.runningKinds.has(job.job_kind)) continue;

      this.runningKinds.add(job.job_kind);
      const startedAt = new Date().toISOString();
      try {
        await this.executeJobKind(job.job_kind);
        await db.updateScheduledJob(job.id, {
          last_run_at: startedAt,
          next_run_at: new Date(Date.now() + job.interval_ms).toISOString(),
          last_status: 'completed',
          last_error: null,
          run_count: job.run_count + 1,
        });
        ran.push(job.job_kind);
      } catch (err) {
        await db.updateScheduledJob(job.id, {
          last_run_at: startedAt,
          next_run_at: new Date(Date.now() + job.interval_ms).toISOString(),
          last_status: 'failed',
          last_error: err instanceof Error ? err.message : String(err),
          run_count: job.run_count + 1,
        });
      } finally {
        this.runningKinds.delete(job.job_kind);
      }
    }

    return { ran, skippedBusy: false };
  }
}

export const autonomousScheduler = new AutonomousScheduler();
