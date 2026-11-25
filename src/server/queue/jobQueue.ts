import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';

export type JobHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

class PersistentJobQueue {
  private handlers = new Map<string, JobHandler>();
  private bullQueue: Queue | null = null;
  private bullWorker: Worker | null = null;
  private processing = false;
  private localQueue: Array<{ id: string; jobType: string; payload: Record<string, unknown> }> = [];

  constructor() {
    if (env.redisUrl) {
      const connection = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
      this.bullQueue = new Queue('neo-ai-jobs', { connection });
      this.bullWorker = new Worker(
        'neo-ai-jobs',
        async (job) => {
          const handler = this.handlers.get(job.name);
          if (!handler) throw new Error(`No handler registered for ${job.name}`);
          const db = await getDb();
          const dbJobId = String(job.data.__dbJobId || '');
          if (dbJobId) {
            await db.updateJob(dbJobId, { status: 'running', attempts: job.attemptsMade + 1 });
          }
          try {
            const result = await handler(job.data.payload || {});
            if (dbJobId) {
              await db.updateJob(dbJobId, { status: 'completed', result, finished_at: new Date().toISOString() });
            }
            return result;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (dbJobId) {
              await db.updateJob(dbJobId, { status: 'failed', error: msg, finished_at: new Date().toISOString() });
            }
            throw err;
          }
        },
        { connection, concurrency: 2 }
      );
    }
  }

  registerHandler(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  async enqueue(queueName: string, jobType: string, payload: Record<string, unknown>): Promise<string> {
    const db = await getDb();
    const record = await db.enqueueJob({ queue_name: queueName, job_type: jobType, payload });

    if (this.bullQueue) {
      await this.bullQueue.add(jobType, { __dbJobId: record.id, payload }, { attempts: 3, backoff: { type: 'exponential', delay: 2000 } });
      return record.id;
    }

    this.localQueue.push({ id: record.id, jobType, payload });
    void this.drainLocalQueue();
    return record.id;
  }

  private async drainLocalQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.localQueue.length > 0) {
        const item = this.localQueue.shift()!;
        const handler = this.handlers.get(item.jobType);
        const db = await getDb();
        if (!handler) {
          await db.updateJob(item.id, {
            status: 'failed',
            error: `No handler registered for ${item.jobType}`,
            finished_at: new Date().toISOString(),
          });
          continue;
        }
        await db.updateJob(item.id, { status: 'running', attempts: 1 });
        try {
          const result = await handler(item.payload);
          await db.updateJob(item.id, {
            status: 'completed',
            result,
            finished_at: new Date().toISOString(),
          });
        } catch (err) {
          await db.updateJob(item.id, {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
            finished_at: new Date().toISOString(),
          });
        }
      }
    } finally {
      this.processing = false;
    }
  }

  async close(): Promise<void> {
    if (this.bullWorker) await this.bullWorker.close();
    if (this.bullQueue) await this.bullQueue.close();
  }
}

export const jobQueue = new PersistentJobQueue();
