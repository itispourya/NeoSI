import { getDb } from '../db/adapter.ts';
import type { MemoryRecord, MemoryType, SkillRecord } from '../db/schema.ts';
import { embedText } from '../llm/router.ts';

export interface RagContextBundle {
  semantic: Array<MemoryRecord & { similarity: number }>;
  procedural: Array<MemoryRecord & { similarity: number }>;
  episodic: Array<MemoryRecord & { similarity: number }>;
  skills: SkillRecord[];
}

export async function retrieveRagContext(query: string, tenantId = 'global', limitPerType = 3): Promise<RagContextBundle> {
  const db = await getDb();
  const queryEmbedding = await embedText(query);

  const [semantic, procedural, episodic, allSkills] = await Promise.all([
    db.searchMemories(queryEmbedding, { memoryType: 'semantic', tenantId, limit: limitPerType, minScore: 0.02 }),
    db.searchMemories(queryEmbedding, { memoryType: 'procedural', tenantId, limit: limitPerType, minScore: 0.02 }),
    db.searchMemories(queryEmbedding, { memoryType: 'episodic', tenantId, limit: 2, minScore: 0.02 }),
    db.listSkills(),
  ]);

  const queryLower = query.toLowerCase();
  const skills = allSkills
    .map((s) => {
      const hay = `${s.title} ${s.domain} ${s.content}`.toLowerCase();
      const words = queryLower.split(/\s+/).filter((w) => w.length > 2);
      const hits = words.filter((w) => hay.includes(w)).length;
      return { skill: s, hits };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((x) => x.skill);

  return { semantic, procedural, episodic, skills };
}

export function formatRagContextForPrompt(bundle: RagContextBundle): string {
  const sections: string[] = [];
  if (bundle.skills.length > 0) {
    sections.push(
      '### Active Skill Registry Playbooks\n' +
        bundle.skills.map((s) => `- **${s.title}** (v${s.version}, ${s.domain}):\n${s.content.slice(0, 600)}`).join('\n')
    );
  }
  if (bundle.procedural.length > 0) {
    sections.push(
      '### Procedural Lessons (Past Error/Success Guardrails)\n' +
        bundle.procedural.map((m) => `- [${m.topic}] ${m.title}: ${m.content}`).join('\n')
    );
  }
  if (bundle.semantic.length > 0) {
    sections.push(
      '### Verified Semantic Knowledge\n' +
        bundle.semantic
          .map((m) => `- [${m.topic} | rel=${m.reliability_score}] ${m.title}: ${m.content.slice(0, 400)}${m.source_url ? ` (${m.source_url})` : ''}`)
          .join('\n')
    );
  }
  if (bundle.episodic.length > 0) {
    sections.push(
      '### Recent Episodic Task Outcomes\n' +
        bundle.episodic.map((m) => `- ${m.title}: ${m.content.slice(0, 280)}`).join('\n')
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
}) {
  const db = await getDb();
  const embedding = await embedText(`${input.topic} ${input.title}\n${input.content}`);
  return db.insertMemory({
    tenant_id: input.tenantId || 'global',
    memory_type: input.memoryType,
    topic: input.topic,
    title: input.title,
    content: input.content,
    structured_facts: input.structuredFacts || {},
    source_url: input.sourceUrl ?? null,
    reliability_score: input.reliabilityScore ?? 0.85,
    freshness_score: input.freshnessScore ?? 1.0,
    embedding,
  });
}
