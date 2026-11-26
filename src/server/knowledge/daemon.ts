import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import { chunkText } from '../db/vector.ts';
import { distillTextLocally } from '../neo/sovereignEngine.ts';
import { jobQueue } from '../queue/jobQueue.ts';
import { discoverWebKnowledge, type DiscoveredSource } from '../search/webSearch.ts';
import { knowledgeGraph } from './graph.ts';
import { storeMemory } from './memory.ts';

export interface CrawlResult {
  topic: string;
  sourcesDiscovered: number;
  memoriesStored: number;
  skillsUpdated: number;
  sources: Array<{ title: string; url: string; provider: string; reliabilityScore: number }>;
}

async function distillSource(topic: string, source: DiscoveredSource) {
  return distillTextLocally(topic, source.title, source.content);
}

export async function runKnowledgeCrawlForTopic(topic: string, streamId?: string, tenantId = 'global'): Promise<CrawlResult> {
  const db = await getDb();
  const discovered = await discoverWebKnowledge(topic);
  const existingMemories = await db.listMemories({ memoryType: 'semantic', tenantId, limit: 200 });
  const existingUrls = new Set(existingMemories.map((m) => m.source_url).filter(Boolean));

  let memoriesStored = 0;
  let skillsUpdated = 0;

  for (const src of discovered) {
    await db.upsertKnowledgeSource({
      tenant_id: tenantId,
      url: src.url,
      title: src.title,
      source_type: src.sourceType,
      author: src.author,
      published_at: src.publishedAt || null,
      last_verified_at: new Date().toISOString(),
      reliability_score: src.reliabilityScore,
      quality_breakdown: src.qualityBreakdown,
      content_hash: src.contentHash,
      injection_flagged: src.injectionFlagged,
    });

    if (src.injectionFlagged) {
      continue;
    }

    if (existingUrls.has(src.url) && existingMemories.some((m) => m.source_url === src.url && m.topic === topic)) {
      continue;
    }

    const distilled = await distillSource(topic, src);
    const chunks = chunkText(distilled.distilledSummary || src.content, 1200, 120);

    for (const [idx, chunk] of chunks.slice(0, 2).entries()) {
      await storeMemory({
        tenantId,
        memoryType: 'semantic',
        topic,
        title: chunks.length > 1 ? `${distilled.title} (part ${idx + 1})` : distilled.title,
        content: chunk,
        structuredFacts: {
          ...distilled.structuredFacts,
          provider: src.provider,
          publishedAt: src.publishedAt || null,
          injectionFlagged: src.injectionFlagged,
        },
        sourceUrl: src.url,
        reliabilityScore: src.reliabilityScore,
        freshnessScore: 1.0,
      });
      memoriesStored++;
    }

    await knowledgeGraph.extractFromText(tenantId, `${distilled.title} ${distilled.distilledSummary}`, src.url);
  }

  if (streamId) {
    await db.markTopicCrawled(streamId, memoriesStored);
  }

  return {
    topic,
    sourcesDiscovered: discovered.length,
    memoriesStored,
    skillsUpdated,
    sources: discovered.map((s) => ({
      title: s.title,
      url: s.url,
      provider: s.provider,
      reliabilityScore: s.reliabilityScore,
    })),
  };
}

class KnowledgeDaemonService {
  private timer: NodeJS.Timeout | null = null;
  private runningCycle = false;

  start(): void {
    jobQueue.registerHandler('knowledge_crawl', async (payload) => {
      const topic = String(payload.topic || '');
      const streamId = payload.streamId ? String(payload.streamId) : undefined;
      const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : 'global';
      return (await runKnowledgeCrawlForTopic(topic, streamId, tenantId)) as unknown as Record<string, unknown>;
    });

    if (this.timer) return;
    const interval = Math.max(60_000, env.knowledgeDaemonIntervalMs);
    this.timer = setInterval(() => {
      void this.runScheduledCycle();
    }, interval);
    this.timer.unref();
  }

  async runScheduledCycle(): Promise<{ queuedJobs: number }> {
    if (this.runningCycle) return { queuedJobs: 0 };
    this.runningCycle = true;
    try {
      const db = await getDb();
      const streams = await db.listTopicStreams();
      const now = Date.now();
      let queuedJobs = 0;

      for (const stream of streams) {
        if (!stream.enabled) continue;
        const lastMs = stream.last_crawled_at ? new Date(stream.last_crawled_at).getTime() : 0;
        const dueMs = stream.interval_minutes * 60_000;
        if (!lastMs || now - lastMs >= dueMs) {
          await jobQueue.enqueue('knowledge', 'knowledge_crawl', { topic: stream.topic, streamId: stream.id, tenantId: 'global' });
          queuedJobs++;
        }
      }
      return { queuedJobs };
    } finally {
      this.runningCycle = false;
    }
  }

  async triggerManualLearn(topic: string, streamId?: string, tenantId = 'global'): Promise<CrawlResult> {
    const db = await getDb();
    // Topic streams are shared system records; workspace learning must not mutate the global schedule.
    let targetStreamId = tenantId === 'global' ? streamId : undefined;
    if (tenantId === 'global' && !targetStreamId) {
      const streams = await db.listTopicStreams();
      const match = streams.find((s) => s.topic.toLowerCase() === topic.toLowerCase());
      if (match) {
        targetStreamId = match.id;
      } else {
        const created = await db.createTopicStream({ topic, category: 'custom', interval_minutes: 120 });
        targetStreamId = created.id;
      }
    }
    return runKnowledgeCrawlForTopic(topic, targetStreamId, tenantId);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const knowledgeDaemon = new KnowledgeDaemonService();
