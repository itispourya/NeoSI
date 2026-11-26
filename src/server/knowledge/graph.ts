import { getDb } from '../db/adapter.ts';
import type { GraphEntityRecord, GraphRelationshipRecord } from '../db/schema.ts';
import { cosineSimilarity } from '../db/vector.ts';
import { embeddingEngine } from '../inference/embeddings.ts';

export class NeoKnowledgeGraph {
  async upsertEntity(input: {
    tenantId: string;
    name: string;
    entityType: string;
    aliases?: string[];
    attributes?: Record<string, unknown>;
    confidence?: number;
  }): Promise<GraphEntityRecord> {
    const db = await getDb();
    const emb = await embeddingEngine.embed(`${input.entityType} ${input.name} ${(input.aliases || []).join(' ')}`);
    return db.upsertEntity({
      tenant_id: input.tenantId,
      name: input.name.trim(),
      entity_type: input.entityType.trim().toLowerCase(),
      aliases: input.aliases || [],
      attributes: input.attributes || {},
      confidence: input.confidence ?? 0.85,
      embedding: emb.vector,
    });
  }

  async addRelationship(input: {
    tenantId: string;
    sourceEntityId: string;
    targetEntityId: string;
    relationType: string;
    properties?: Record<string, unknown>;
    sourceUrl?: string | null;
    confidence?: number;
    validFrom?: string | null;
    validTo?: string | null;
  }): Promise<GraphRelationshipRecord> {
    const db = await getDb();
    const [source, target] = await Promise.all([
      db.getEntityById(input.sourceEntityId, input.tenantId),
      db.getEntityById(input.targetEntityId, input.tenantId),
    ]);
    if (!source || !target) {
      throw new Error('Both relationship endpoints must exist in the authenticated workspace.');
    }
    // Detect existing relationship with same source & relationType pointing to different target (contradiction tracking)
    const existing = await db.listRelationships(input.tenantId, input.sourceEntityId, 50);
    let contradictsId: string | null = null;
    for (const rel of existing) {
      if (
        rel.source_entity_id === input.sourceEntityId &&
        rel.relation_type === input.relationType &&
        rel.target_entity_id !== input.targetEntityId &&
        !rel.valid_to
      ) {
        contradictsId = rel.id;
        break;
      }
    }

    return db.addRelationship({
      tenant_id: input.tenantId,
      source_entity_id: input.sourceEntityId,
      target_entity_id: input.targetEntityId,
      relation_type: input.relationType,
      properties: input.properties || {},
      source_url: input.sourceUrl ?? null,
      confidence: input.confidence ?? 0.85,
      valid_from: input.validFrom ?? new Date().toISOString(),
      valid_to: input.validTo ?? null,
      contradicts_id: contradictsId,
    });
  }

  async extractFromText(tenantId: string, text: string, sourceUrl?: string | null): Promise<{ entitiesAdded: number; relationshipsAdded: number }> {
    const candidates = Array.from(new Set(text.match(/\b[A-Z][a-zA-Z0-9_-]{2,28}(?:\s+[A-Z][a-zA-Z0-9_-]{2,20})?\b/g) || []))
      .filter((w) => !/^(The|This|That|These|When|Where|With|From|Into|After|Before|While|Should|Could)$/.test(w))
      .slice(0, 8);

    const entities: GraphEntityRecord[] = [];
    for (const name of candidates) {
      const entityType = /Inc|Corp|LLC|Labs|Neos|PostgreSQL|Ollama|vLLM|GitHub|arXiv/i.test(name) ? 'system_or_org' : 'concept';
      const ent = await this.upsertEntity({
        tenantId,
        name,
        entityType,
        attributes: sourceUrl ? { sourceUrl } : {},
      });
      entities.push(ent);
    }

    // Entity co-occurrence is not a semantic relationship. Do not fabricate graph edges.
    // Relationships must be extracted with explicit evidence and validated by addRelationship().
    return { entitiesAdded: entities.length, relationshipsAdded: 0 };
  }

  async searchEntities(tenantId: string, query: string, limit = 10): Promise<Array<GraphEntityRecord & { score: number }>> {
    const db = await getDb();
    const [emb, all] = await Promise.all([
      embeddingEngine.embed(query),
      db.listEntities(tenantId, { limit: 150 }),
    ]);
    return all
      .map((e) => {
        const vecSim = e.embedding.length ? cosineSimilarity(emb.vector, e.embedding) : 0;
        const nameMatch = e.name.toLowerCase().includes(query.toLowerCase()) ? 0.45 : 0;
        return { ...e, embedding: [], score: Number((vecSim + nameMatch).toFixed(4)) };
      })
      .filter((e) => e.score > 0.08)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async traverse(tenantId: string, startEntityId: string, maxDepth = 2): Promise<{
    nodes: GraphEntityRecord[];
    edges: GraphRelationshipRecord[];
  }> {
    const db = await getDb();
    const startEntity = await db.getEntityById(startEntityId, tenantId);
    if (!startEntity) return { nodes: [], edges: [] };
    const allEntities = await db.listEntities(tenantId, { limit: 300 });
    const entityMap = new Map(allEntities.map((e) => [e.id, e]));
    const visited = new Set<string>([startEntityId]);
    const collectedEdges: GraphRelationshipRecord[] = [];
    let frontier = [startEntityId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const rels = await db.listRelationships(tenantId, nodeId, 50);
        for (const r of rels) {
          const neighbor = r.source_entity_id === nodeId ? r.target_entity_id : r.source_entity_id;
          // Ignore legacy or malformed edges that point outside this tenant's entity set.
          if (!entityMap.has(r.source_entity_id) || !entityMap.has(r.target_entity_id)) continue;
          collectedEdges.push(r);
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }
      frontier = nextFrontier;
    }

    const nodes = Array.from(visited)
      .map((id) => entityMap.get(id))
      .filter((x): x is GraphEntityRecord => Boolean(x))
      .map((n) => ({ ...n, embedding: [] }));
    const uniqueEdges = Array.from(new Map(collectedEdges.map((e) => [e.id, e])).values());

    return { nodes, edges: uniqueEdges };
  }
}

export const knowledgeGraph = new NeoKnowledgeGraph();
