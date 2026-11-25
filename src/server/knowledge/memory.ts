import { getDb, type MemorySearchResult } from '../db/adapter.ts';
import type { MemoryType, SkillRecord } from '../db/schema.ts';
import { cosineSimilarity } from '../db/vector.ts';
import { embeddingEngine } from '../inference/embeddings.ts';

export interface RagContextBundle {
  working: MemorySearchResult[];
  episodic: MemorySearchResult[];
  semantic: MemorySearchResult[];
  procedural: MemorySearchResult[];
  personal: MemorySearchResult[];
  organizational: MemorySearchResult[];
  temporal: MemorySearchResult[];
  skills: SkillRecord[];
}

export async function retrieveRagContext(query: string, tenantId = 'global', limitPerType = 3): Promise<RagContextBundle> {
  const db = await getDb();
  const emb = await embeddingEngine.embed(query);
  const nowIso = new Date().toISOString();

  const [working, episodic, semantic, procedural, personal, organizational, temporal, allSkills] = await Promise.all([
    db.searchMemories(emb.vector, { memoryType: 'working', tenantId, queryText: query, limit: limitPerType, minScore: 0.02 }),
    db.searchMemories(emb.vector, { memoryType: 'episodic', tenantId, queryText: query, limit: limitPerType, minScore: 0.02 }),
    db.searchMemories(emb.vector, { memoryType: 'semantic', tenantId, includeGlobal: true, queryText: query, limit: limitPerType, minScore: 0.02 }),
    db.searchMemories(emb.vector, { memoryType: 'procedural', tenantId, includeGlobal: true, queryText: query, limit: limitPerType, minScore: 0.02 }),
    db.searchMemories(emb.vector, { memoryType: 'personal', tenantId, queryText: query, limit: 2, minScore: 0.03 }),
    db.searchMemories(emb.vector, { memoryType: 'organizational', tenantId, queryText: query, limit: 2, minScore: 0.03 }),
    db.searchMemories(emb.vector, { memoryType: 'temporal', tenantId, includeGlobal: true, validAt: nowIso, queryText: query, limit: 2, minScore: 0.02 }),
    db.listSkills(),
  ]);

  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/).filter((w) => w.length > 2);
  const skills = allSkills
    .map((s) => {
      const hay = `${s.title} ${s.domain} ${s.content}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w)).length;
      return { skill: s, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((x) => x.skill);

  return { working, episodic, semantic, procedural, personal, organizational, temporal, skills };
}

export function formatRagContextForPrompt(bundle: RagContextBundle): string {
  const sections: string[] = [];
  if (bundle.skills.length > 0) {
    sections.push(
      '### Active Skill Registry Playbooks\n' +
        bundle.skills.map((s) => `- **${s.title}** (v${s.version}, ${s.domain}):\n${s.content.slice(0, 500)}`).join('\n')
    );
  }
  if (bundle.procedural.length > 0) {
    sections.push(
      '### Procedural Lessons\n' +
        bundle.procedural.map((m) => `- [${m.topic}] ${m.title}: ${m.content}`).join('\n')
    );
  }
  if (bundle.organizational.length > 0) {
    sections.push(
      '### Organizational Context\n' +
        bundle.organizational.map((m) => `- ${m.title}: ${m.content.slice(0, 300)}`).join('\n')
    );
  }
  if (bundle.personal.length > 0) {
    sections.push(
      '### User Personal Context\n' +
        bundle.personal.map((m) => `- ${m.title}: ${m.content.slice(0, 260)}`).join('\n')
    );
  }
  if (bundle.semantic.length > 0) {
    sections.push(
      '### Verified Semantic Knowledge\n' +
        bundle.semantic
          .map((m) => `- [${m.topic} | rel=${m.reliability_score}] ${m.title}: ${m.content.slice(0, 380)}${m.source_url ? ` (${m.source_url})` : ''}`)
          .join('\n')
    );
  }
  if (bundle.temporal.length > 0) {
    sections.push(
      '### Active Temporal Facts\n' +
        bundle.temporal.map((m) => `- [${m.valid_from || 'active'}] ${m.title}: ${m.content.slice(0, 260)}`).join('\n')
    );
  }
  if (bundle.episodic.length > 0) {
    sections.push(
      '### Recent Episodic Outcomes\n' +
        bundle.episodic.map((m) => `- ${m.title}: ${m.content.slice(0, 240)}`).join('\n')
    );
  }
  return sections.join('\n\n');
}

export async function storeMemory(input: {
  tenantId?: string;
  memoryType: MemoryType;
  topic: string;
  title: string;
  content: string;
  structuredFacts?: Record<string, unknown>;
  sourceUrl?: string | null;
  reliabilityScore?: number;
  freshnessScore?: number;
  importanceScore?: number;
  confidenceScore?: number;
  validFrom?: string | null;
  validTo?: string | null;
}) {
  const db = await getDb();
  const emb = await embeddingEngine.embed(`${input.topic} ${input.title}\n${input.content}`);

  // Semantic duplicate & contradiction detection within same tenant and memory type
  const existing = await db.searchMemories(emb.vector, {
    memoryType: input.memoryType,
    tenantId: input.tenantId || 'global',
    includeGlobal: false,
    limit: 3,
    minScore: 0.78,
  });

  if (existing.length > 0) {
    const top = existing[0];
    if (top.similarity >= 0.94 && top.title.toLowerCase() === input.title.toLowerCase()) {
      // Update freshness & confidence on near-duplicate instead of bloating memory
      return (
        (await db.updateMemory(top.id, top.tenant_id, {
          content: input.content,
          structured_facts: { ...top.structured_facts, ...(input.structuredFacts || {}) },
          freshness_score: Math.max(top.freshness_score, input.freshnessScore ?? 1.0),
          confidence_score: Math.min(0.99, Math.max(top.confidence_score, input.confidenceScore ?? 0.85) + 0.03),
          embedding: emb.vector,
        })) || top
      );
    }
  }

  const inserted = await db.insertMemory({
    tenant_id: input.tenantId || 'global',
    memory_type: input.memoryType,
    topic: input.topic,
    title: input.title,
    content: input.content,
    structured_facts: input.structuredFacts || {},
    source_url: input.sourceUrl ?? null,
    reliability_score: input.reliabilityScore ?? 0.85,
    freshness_score: input.freshnessScore ?? 1.0,
    importance_score: input.importanceScore ?? 0.65,
    confidence_score: input.confidenceScore ?? 0.82,
    valid_from: input.validFrom ?? new Date().toISOString(),
    valid_to: input.validTo ?? null,
    embedding: emb.vector,
  });

  // Mark older temporal facts on identical topic & title as superseded
  if (input.memoryType === 'temporal') {
    const siblings = await db.listMemories({ memoryType: 'temporal', tenantId: input.tenantId || 'global', limit: 20 });
    for (const sib of siblings) {
      if (sib.id !== inserted.id && !sib.superseded_by && cosineSimilarity(sib.embedding, emb.vector) > 0.86) {
        await db.updateMemory(sib.id, sib.tenant_id, {
          valid_to: new Date().toISOString(),
          superseded_by: inserted.id,
        });
      }
    }
  }

  return inserted;
}
