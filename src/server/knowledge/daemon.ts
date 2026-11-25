import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import { chunkText } from '../db/vector.ts';
import { routeJsonLlmCall } from '../llm/router.ts';
import { distillTextLocally } from '../neo/sovereignEngine.ts';
import { jobQueue } from '../queue/jobQueue.ts';
import { discoverWebKnowledge, type DiscoveredSource } from '../search/webSearch.ts';
import { storeMemory } from './memory.ts';

interface DistilledKnowledge {
  title: string;
  distilledSummary: string;
  structuredFacts: Record<string, unknown>;
  skillUpdate?: {
    slug: string;
    title: string;
    domain: string;
    markdownGuide: string;
  };
}

export interface CrawlResult {
  topic: string;
  sourcesDiscovered: number;
  memoriesStored: number;
  skillsUpdated: number;
  sources: Array<{ title: string; url: string; provider: string; reliabilityScore: number }>;
}

async function distillSource(topic: string, source: DiscoveredSource): Promise<DistilledKnowledge> {
  if (env.neoLocalOnly) {
    return distillTextLocally(topic, source.title, source.content);
  }
  try {
    const { data } = await routeJsonLlmCall<DistilledKnowledge>({
      taskType: 'knowledge_distillation',
      thinkingLevel: 'LOW',
      systemInstruction:
        'You are Neo KnowledgeDistiller. Given raw web/repo/paper content, extract verified technical or business intelligence. Return strict JSON: { "title": string, "distilledSummary": string, "structuredFacts": object, "skillUpdate"?: { "slug": string, "title": string, "domain": string, "markdownGuide": string } }.',
      prompt: `Topic: ${topic}\nSource URL: ${source.url}\nTitle: ${source.title}\nContent:\n${source.content.slice(0, 4000)}`,
    });
    return data;
  } catch {
    return distillTextLocally(topic, source.title, source.content);
  }
}

export async function runKnowledgeCrawlForTopic(topic: string, streamId?: string): Promise<CrawlResult> {
  const db = await getDb();
  const discovered = await discoverWebKnowledge(topic);
  const existingMemories = await db.listMemories({ memoryType: 'semantic', limit: 200 });
  const existingUrls = new Set(existingMemories.map((m) => m.source_url).filter(Boolean));

  let memoriesStored = 0;
  let skillsUpdated = 0;

  for (const src of discovered) {
    // Deduplicate identical source URLs already ingested recently
    if (existingUrls.has(src.url) && existingMemories.some((m) => m.source_url === src.url && m.topic === topic)) {
      continue;
    }

    const distilled = await distillSource(topic, src);
    const chunks = chunkText(distilled.distilledSummary || src.content, 1200, 120);

    for (const [idx, chunk] of chunks.slice(0, 2).entries()) {
      await storeMemory({
        tenantId: 'global',
        memoryType: 'semantic',
        topic,
        title: chunks.length > 1 ? `${distilled.title} (part ${idx + 1})` : distilled.title,
        content: chunk,
        structuredFacts: {
          ...distilled.structuredFacts,
          provider: src.provider,
          publishedAt: src.publishedAt || null,
        },
        sourceUrl: src.url,
        reliabilityScore: src.reliabilityScore,
        freshnessScore: 1.0,
      });
      memoriesStored++;
    }

    if (distilled.skillUpdate?.slug && distilled.skillUpdate?.markdownGuide) {
      await db.upsertSkill({
        slug: distilled.skillUpdate.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
        title: distilled.skillUpdate.title,
        domain: distilled.skillUpdate.domain || 'general',
        version: 1,
        format: 'markdown',
        content: distilled.skillUpdate.markdownGuide,
        metadata: { sourceUrl: src.url, topic, reliability: src.reliabilityScore },
      });
      skillsUpdated++;
    }
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
      return (await runKnowledgeCrawlForTopic(topic, streamId)) as unknown as Record<string, unknown>;
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
          await jobQueue.enqueue('knowledge', 'knowledge_crawl', { topic: stream.topic, streamId: stream.id });
          queuedJobs++;
        }
      }
      return { queuedJobs };
    } finally {
      this.runningCycle = false;
    }
  }

  async triggerManualLearn(topic: string, streamId?: string): Promise<CrawlResult> {
    const db = await getDb();
    let targetStreamId = streamId;
    if (!targetStreamId) {
      const streams = await db.listTopicStreams();
      const match = streams.find((s) => s.topic.toLowerCase() === topic.toLowerCase());
      if (match) {
        targetStreamId = match.id;
      } else {
        const created = await db.createTopicStream({ topic, category: 'custom', interval_minutes: 120 });
        targetStreamId = created.id;
      }
    }
    return runKnowledgeCrawlForTopic(topic, targetStreamId);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const knowledgeDaemon = new KnowledgeDaemonService();
