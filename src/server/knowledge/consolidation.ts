import { getDb } from '../db/adapter.ts';
import { cosineSimilarity } from '../db/vector.ts';
import { storeMemory } from './memory.ts';

export interface ConsolidationSummary {
  scannedWorking: number;
  scannedEpisodic: number;
  consolidatedSemantic: number;
  prunedExpiredWorking: number;
  contradictionsDetected: number;
}

/**
 * MemoryConsolidationWorker:
 * Periodically transforms repeated episodic experiences into durable semantic/procedural knowledge,
 * expires stale working memory, and detects contradicting claims across stored memories.
 */
export async function runMemoryConsolidation(): Promise<ConsolidationSummary> {
  const db = await getDb();
  const working = await db.listMemories({ memoryType: 'working', limit: 100 });
  const episodic = await db.listMemories({ memoryType: 'episodic', limit: 100 });
  const semantic = await db.listMemories({ memoryType: 'semantic', limit: 100 });

  let prunedExpiredWorking = 0;
  let consolidatedSemantic = 0;
  let contradictionsDetected = 0;

  const cutoffMs = Date.now() - 4 * 3600 * 1000; // Working memory older than 4h expires
  for (const w of working) {
    const createdMs = new Date(w.created_at).getTime();
    if (Number.isFinite(createdMs) && createdMs < cutoffMs) {
      if (w.importance_score >= 0.8) {
        await storeMemory({
          tenantId: w.tenant_id,
          memoryType: 'semantic',
          topic: w.topic,
          title: `Consolidated: ${w.title}`,
          content: w.content,
          structuredFacts: { ...w.structured_facts, consolidatedFrom: w.id },
          reliabilityScore: w.reliability_score,
          importanceScore: w.importance_score,
        });
        consolidatedSemantic++;
      }
      await db.deleteMemory(w.id, w.tenant_id, false);
      prunedExpiredWorking++;
    }
  }

  // Group episodic events by topic + tenant; when >= 3 events share a topic, distill a semantic insight
  const topicBuckets = new Map<string, typeof episodic>();
  for (const ep of episodic) {
    if (ep.structured_facts?.consolidated === true) continue;
    const key = `${ep.tenant_id}::${ep.topic}`;
    const list = topicBuckets.get(key) || [];
    list.push(ep);
    topicBuckets.set(key, list);
  }

  for (const [key, items] of topicBuckets.entries()) {
    if (items.length < 3) continue;
    const [tenantId, topic] = key.split('::');
    const summaryText = items
      .slice(0, 5)
      .map((i) => `${i.title}: ${i.content.slice(0, 140)}`)
      .join(' | ');

    await storeMemory({
      tenantId,
      memoryType: 'semantic',
      topic,
      title: `Consolidated Operational Pattern (${topic})`,
      content: summaryText,
      structuredFacts: { episodeCount: items.length, sourceIds: items.slice(0, 5).map((i) => i.id) },
      reliabilityScore: 0.9,
      importanceScore: 0.82,
    });
    consolidatedSemantic++;

    for (const item of items.slice(0, 5)) {
      await db.updateMemory(item.id, item.tenant_id, {
        structured_facts: { ...item.structured_facts, consolidated: true },
      });
    }
  }

  // Detect potential semantic contradictions (high topic similarity with opposing negation markers)
  for (let i = 0; i < semantic.length; i++) {
    for (let j = i + 1; j < Math.min(semantic.length, i + 15); j++) {
      const a = semantic[i];
      const b = semantic[j];
      if (a.tenant_id !== b.tenant_id || a.topic !== b.topic) continue;
      if (!a.embedding.length || !b.embedding.length) continue;
      const sim = cosineSimilarity(a.embedding, b.embedding);
      if (sim > 0.72) {
        const aNeg = /\b(not|never|forbidden|blocked|false|imbalanced)\b/i.test(a.content);
        const bNeg = /\b(not|never|forbidden|blocked|false|imbalanced)\b/i.test(b.content);
        if (aNeg !== bNeg) contradictionsDetected++;
      }
    }
  }

  return {
    scannedWorking: working.length,
    scannedEpisodic: episodic.length,
    consolidatedSemantic,
    prunedExpiredWorking,
    contradictionsDetected,
  };
}
