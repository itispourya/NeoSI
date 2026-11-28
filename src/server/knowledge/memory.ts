import { normalizeMultilingualQuery } from '../business/language.ts';
import { getDb, type MemorySearchResult } from '../db/adapter.ts';
import type { EpistemicStatus, MemoryType, RetentionPolicy, SkillRecord } from '../db/schema.ts';
import { cosineSimilarity } from '../db/vector.ts';
import { sanitizeUntrustedContent } from '../security/promptGuard.ts';
import { embeddingEngine } from '../inference/embeddings.ts';

export interface RagDiagnostics {
  originalQuery: string;
  normalizedQuery: string;
  policyVersion: number;
  minReliability: number;
  ragTopK: number;
  totalHitsBeforeFilter: number;
  filteredOutLowReliability: number;
  hitsByLayer: Record<string, number>;
  vectorHits: number;
  lexicalHits: number;
}

export interface RagContextBundle {
  working: MemorySearchResult[];
  episodic: MemorySearchResult[];
  semantic: MemorySearchResult[];
  procedural: MemorySearchResult[];
  personal: MemorySearchResult[];
  organizational: MemorySearchResult[];
  temporal: MemorySearchResult[];
  skills: SkillRecord[];
  diagnostics?: RagDiagnostics;
}

function filterByPolicyAndFreshness(
  items: MemorySearchResult[],
  minReliability: number,
  nowMs: number
): { kept: MemorySearchResult[]; filteredOut: number } {
  const kept: MemorySearchResult[] = [];
  let filteredOut = 0;
  for (const m of items) {
    if (m.superseded_by) {
      filteredOut++;
      continue;
    }
    if (m.valid_to && Date.parse(m.valid_to) < nowMs) {
      filteredOut++;
      continue;
    }
    if (m.reliability_score < minReliability) {
      filteredOut++;
      continue;
    }
    kept.push(m);
  }
  return { kept, filteredOut };
}

export async function retrieveRagContext(query: string, tenantId = 'global', limitPerType?: number): Promise<RagContextBundle> {
  const db = await getDb();
  const activePolicy = await db.getActiveBehavioralPolicy().catch(() => null);
  const policyTopK = limitPerType ?? activePolicy?.config.ragTopK ?? 3;
  const minReliability = activePolicy?.config.minReliability ?? 0.35;
  const normalizedQuery = normalizeMultilingualQuery(query) || query;
  const emb = await embeddingEngine.embed(normalizedQuery);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const [rawWorking, rawEpisodic, rawSemantic, rawProcedural, rawPersonal, rawOrganizational, rawTemporal, allSkills] = await Promise.all([
    db.searchMemories(emb.vector, { memoryType: 'working', tenantId, queryText: normalizedQuery, queryEmbeddingModel: emb.model, limit: policyTopK, minScore: 0.02 }),
    db.searchMemories(emb.vector, { memoryType: 'episodic', tenantId, queryText: normalizedQuery, queryEmbeddingModel: emb.model, limit: policyTopK, minScore: 0.02 }),
    db.searchMemories(emb.vector, { memoryType: 'semantic', tenantId, includeGlobal: true, queryText: normalizedQuery, queryEmbeddingModel: emb.model, limit: policyTopK, minScore: 0.02 }),
    db.searchMemories(emb.vector, { memoryType: 'procedural', tenantId, includeGlobal: true, queryText: normalizedQuery, queryEmbeddingModel: emb.model, limit: policyTopK, minScore: 0.02 }),
    db.searchMemories(emb.vector, { memoryType: 'personal', tenantId, queryText: normalizedQuery, queryEmbeddingModel: emb.model, limit: 2, minScore: 0.03 }),
    db.searchMemories(emb.vector, { memoryType: 'organizational', tenantId, queryText: normalizedQuery, queryEmbeddingModel: emb.model, limit: 2, minScore: 0.03 }),
    db.searchMemories(emb.vector, { memoryType: 'temporal', tenantId, includeGlobal: true, validAt: nowIso, queryText: normalizedQuery, queryEmbeddingModel: emb.model, limit: 2, minScore: 0.02 }),
    db.listSkills(),
  ]);

  const w = filterByPolicyAndFreshness(rawWorking, 0.25, nowMs);
  const e = filterByPolicyAndFreshness(rawEpisodic, 0.25, nowMs);
  const s = filterByPolicyAndFreshness(rawSemantic, minReliability, nowMs);
  const pr = filterByPolicyAndFreshness(rawProcedural, minReliability, nowMs);
  const pe = filterByPolicyAndFreshness(rawPersonal, 0.25, nowMs);
  const org = filterByPolicyAndFreshness(rawOrganizational, 0.25, nowMs);
  const tm = filterByPolicyAndFreshness(rawTemporal, minReliability, nowMs);

  const queryLower = normalizedQuery.toLowerCase();
  const words = queryLower.split(/\s+/).filter((word) => word.length > 2);
  const skills = allSkills
    .map((skill) => {
      const hay = `${skill.title} ${skill.domain} ${skill.content}`.toLowerCase();
      const hits = words.filter((word) => hay.includes(word)).length;
      return { skill, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((x) => x.skill);

  const allRaw = [...rawWorking, ...rawEpisodic, ...rawSemantic, ...rawProcedural, ...rawPersonal, ...rawOrganizational, ...rawTemporal];
  const allKept = [...w.kept, ...e.kept, ...s.kept, ...pr.kept, ...pe.kept, ...org.kept, ...tm.kept];
  const diagnostics: RagDiagnostics = {
    originalQuery: query,
    normalizedQuery,
    policyVersion: activePolicy?.version ?? 1,
    minReliability,
    ragTopK: policyTopK,
    totalHitsBeforeFilter: allRaw.length,
    filteredOutLowReliability: w.filteredOut + e.filteredOut + s.filteredOut + pr.filteredOut + pe.filteredOut + org.filteredOut + tm.filteredOut,
    hitsByLayer: {
      working: w.kept.length,
      episodic: e.kept.length,
      semantic: s.kept.length,
      procedural: pr.kept.length,
      personal: pe.kept.length,
      organizational: org.kept.length,
      temporal: tm.kept.length,
      skills: skills.length,
    },
    vectorHits: allKept.filter((m) => m.similarity > 0.1).length,
    lexicalHits: allKept.filter((m) => m.hybridScore - m.similarity * 0.35 > 0.05).length,
  };

  return {
    working: w.kept,
    episodic: e.kept,
    semantic: s.kept,
    procedural: pr.kept,
    personal: pe.kept,
    organizational: org.kept,
    temporal: tm.kept,
    skills,
    diagnostics,
  };
}

export async function getRetrievalDiagnostics(query: string, tenantId = 'global'): Promise<{
  diagnostics: RagDiagnostics;
  topMatches: Array<{ id: string; memoryType: MemoryType; title: string; epistemicStatus: EpistemicStatus; reliability: number; score: number; sourceUrl: string | null }>;
}> {
  const bundle = await retrieveRagContext(query, tenantId);
  const all = [
    ...bundle.semantic,
    ...bundle.procedural,
    ...bundle.organizational,
    ...bundle.personal,
    ...bundle.temporal,
    ...bundle.episodic,
    ...bundle.working,
  ]
    .sort((a, b) => b.hybridScore - a.hybridScore)
    .slice(0, 12)
    .map((m) => ({
      id: m.id,
      memoryType: m.memory_type,
      title: m.title,
      epistemicStatus: m.epistemic_status,
      reliability: m.reliability_score,
      score: Number(m.hybridScore.toFixed(3)),
      sourceUrl: m.source_url,
    }));
  return {
    diagnostics: bundle.diagnostics!,
    topMatches: all,
  };
}

export function formatRagContextForPrompt(bundle: RagContextBundle): string {
  const sections: string[] = [];
  if (bundle.skills.length > 0) {
    sections.push(
      '### Active Skill Registry Playbooks [provenance=procedural_skill]\n' +
        bundle.skills.map((s) => `- **${s.title}** (v${s.version}, ${s.domain}):\n${s.content.slice(0, 500)}`).join('\n')
    );
  }
  if (bundle.procedural.length > 0) {
    sections.push(
      '### Procedural Lessons [provenance=memory_procedural]\n' +
        bundle.procedural.map((m) => `- [${m.topic} | ${m.epistemic_status}] ${m.title}: ${m.content}`).join('\n')
    );
  }
  if (bundle.organizational.length > 0) {
    sections.push(
      '### Organizational Context [provenance=business_context]\n' +
        bundle.organizational.map((m) => `- [${m.epistemic_status}] ${m.title}: ${m.content.slice(0, 300)}`).join('\n')
    );
  }
  if (bundle.personal.length > 0) {
    sections.push(
      '### User Personal Context [provenance=user_context]\n' +
        bundle.personal.map((m) => `- ${m.title}: ${m.content.slice(0, 260)}`).join('\n')
    );
  }
  if (bundle.semantic.length > 0) {
    sections.push(
      '### Semantic Knowledge [provenance=public_web_and_docs]\n' +
        bundle.semantic
          .map(
            (m) =>
              `- [${m.topic} | ${m.epistemic_status === 'verified_fact' ? 'verified' : m.epistemic_status} | rel=${m.reliability_score}] ${m.title}: ${m.content.slice(0, 380)}${m.source_url ? ` (${m.source_url})` : ''}`
          )
          .join('\n')
    );
  }
  if (bundle.temporal.length > 0) {
    sections.push(
      '### Active Temporal Facts [provenance=temporal_memory]\n' +
        bundle.temporal.map((m) => `- [${m.valid_from || 'active'}] ${m.title}: ${m.content.slice(0, 260)}`).join('\n')
    );
  }
  if (bundle.episodic.length > 0) {
    sections.push(
      '### Recent Episodic Outcomes [provenance=episodic_memory]\n' +
        bundle.episodic.map((m) => `- [${m.epistemic_status}] ${m.title}: ${m.content.slice(0, 240)}`).join('\n')
    );
  }
  return sections.length ? sanitizeUntrustedContent(sections.join('\n\n'), 'retrieved_memory').wrappedData : '';
}

function defaultEpistemicStatus(_memoryType: MemoryType, _sourceUrl?: string | null): EpistemicStatus {
  // A source URL establishes provenance, not truth. Verification is an explicit evidence-evaluation step.
  return 'observation';
}

function defaultRetentionPolicy(memoryType: MemoryType): RetentionPolicy {
  if (memoryType === 'working') return 'ephemeral';
  if (memoryType === 'episodic') return 'long_term';
  if (memoryType === 'procedural' || memoryType === 'organizational') return 'permanent';
  return 'long_term';
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
  epistemicStatus?: EpistemicStatus;
  retentionPolicy?: RetentionPolicy;
  validFrom?: string | null;
  validTo?: string | null;
}) {
  const db = await getDb();
  const emb = await embeddingEngine.embed(`${input.topic} ${input.title}\n${input.content}`);
  const epistemicStatus = input.epistemicStatus ?? defaultEpistemicStatus(input.memoryType, input.sourceUrl);
  const retentionPolicy = input.retentionPolicy ?? defaultRetentionPolicy(input.memoryType);

  // Semantic duplicate detection isolated within same tenant, type, and embedding space
  const existing = await db.searchMemories(emb.vector, {
    memoryType: input.memoryType,
    tenantId: input.tenantId || 'global',
    includeGlobal: false,
    queryText: `${input.title} ${input.topic}`,
    queryEmbeddingModel: emb.model,
    limit: 3,
    minScore: 0.78,
  });

  if (existing.length > 0) {
    const top = existing[0];
    if (
      top.embedding_model === emb.model &&
      top.similarity >= 0.94 &&
      top.title.toLowerCase() === input.title.toLowerCase()
    ) {
      return (
        (await db.updateMemory(top.id, top.tenant_id, {
          content: input.content,
          structured_facts: { ...top.structured_facts, ...(input.structuredFacts || {}) },
          freshness_score: Math.max(top.freshness_score, input.freshnessScore ?? 1.0),
          confidence_score: Math.min(0.99, Math.max(top.confidence_score, input.confidenceScore ?? 0.85) + 0.03),
          epistemic_status: epistemicStatus,
          retention_policy: retentionPolicy,
          embedding: emb.vector,
          embedding_model: emb.model,
          embedding_dim: emb.dim,
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
    epistemic_status: epistemicStatus,
    retention_policy: retentionPolicy,
    valid_from: input.validFrom ?? new Date().toISOString(),
    valid_to: input.validTo ?? null,
    embedding: emb.vector,
    embedding_model: emb.model,
    embedding_dim: emb.dim,
  });

  // Mark older temporal facts within the SAME embedding space & matching vector dimension as superseded
  if (input.memoryType === 'temporal') {
    const siblings = await db.listMemories({ memoryType: 'temporal', tenantId: input.tenantId || 'global', limit: 25 });
    for (const sib of siblings) {
      if (sib.id === inserted.id || sib.superseded_by) continue;
      const sameSpace =
        sib.embedding_model === emb.model &&
        sib.embedding.length === emb.vector.length &&
        sib.embedding.length > 0;
      const simMatch = sameSpace
        ? cosineSimilarity(sib.embedding, emb.vector) > 0.86
        : sib.topic.toLowerCase() === input.topic.toLowerCase() &&
          sib.title.toLowerCase() === input.title.toLowerCase();
      if (simMatch) {
        await db.updateMemory(sib.id, sib.tenant_id, {
          valid_to: new Date().toISOString(),
          superseded_by: inserted.id,
        });
      }
    }
  }

  return inserted;
}

export async function reindexMemoriesForTenant(
  tenantId = 'global',
  opts?: { force?: boolean; limit?: number }
): Promise<{ totalScanned: number; reindexed: number; targetModel: string; targetDim: number }> {
  const db = await getDb();
  const sample = await embeddingEngine.embed('neo embedding space probe');
  const memories = await db.listMemories({
    tenantId,
    includeGlobal: tenantId === 'global',
    limit: opts?.limit ?? 500,
  });

  let reindexed = 0;
  for (const m of memories) {
    const mismatch =
      m.embedding_model !== sample.model ||
      m.embedding_dim !== sample.dim ||
      m.embedding.length !== sample.dim;
    if (!opts?.force && !mismatch) continue;

    const emb = await embeddingEngine.embed(`${m.topic} ${m.title}\n${m.content}`);
    await db.updateMemory(m.id, m.tenant_id, {
      embedding: emb.vector,
      embedding_model: emb.model,
      embedding_dim: emb.dim,
    });
    reindexed++;
  }

  return {
    totalScanned: memories.length,
    reindexed,
    targetModel: sample.model,
    targetDim: sample.dim,
  };
}
