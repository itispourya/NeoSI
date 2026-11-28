import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type {
  MemoryCounts,
  MemoryQueryOptions,
  MemorySearchOptions,
  MemorySearchResult,
  NeoDatabase,
} from './interface.ts';
import type {
  ApiKeyRecord,
  AuditLogRecord,
  BackgroundJobRecord,
  ConversationRecord,
  DynamicApiRecord,
  EpistemicStatus,
  EvolutionExperimentRecord,
  GraphEntityRecord,
  GraphRelationshipRecord,
  KnowledgeSourceRecord,
  LlmTelemetryRecord,
  MemoryRecord,
  MessageRecord,
  ModelEvaluationRecord,
  ModelRecord,
  ObjectiveRecord,
  ObjectiveStatus,
  ResearchReportRecord,
  RetentionPolicy,
  ScheduledJobRecord,
  SelfUpgradeRecord,
  SkillRecord,
  TaskEventRecord,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  TaskStepRecord,
  TenantRecord,
  ToolExecutionRecord,
  ToolRecord,
  TopicStreamRecord,
  TrainingJobRecord,
  UpgradeStatus,
} from './schema.ts';
import { seedInitialData } from './seed.ts';
import { computeBm25Scores, computeTemporalDecay, hybridRerank, tokenizeMultilingual } from './vector.ts';

export function toPgVectorLiteral(vector: number[]): string | null {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  if (vector.length > 16_000 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding must contain 1–16000 finite numeric dimensions.');
  }
  return `[${vector.map((value) => Number(value).toString()).join(',')}]`;
}

export function buildPostgresMemoryFilters(opts?: MemorySearchOptions): {
  clauses: string[];
  params: unknown[];
  nextParameterIndex: number;
} {
  const clauses = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  let index = 1;
  if (opts?.memoryType) {
    clauses.push('memory_type = $' + index++);
    params.push(opts.memoryType);
  }
  if (opts?.tenantId) {
    if (opts.includeGlobal) {
      clauses.push('(tenant_id = $' + index++ + ' OR tenant_id = $' + index++ + ')');
      params.push(opts.tenantId, 'global');
    } else {
      clauses.push('tenant_id = $' + index++);
      params.push(opts.tenantId);
    }
  }
  if (opts?.validAt) {
    clauses.push('(valid_from IS NULL OR valid_from <= $' + index + ') AND (valid_to IS NULL OR valid_to >= $' + index + ')');
    params.push(opts.validAt);
    index++;
  }
  return { clauses, params, nextParameterIndex: index };
}
export function buildPostgresLexicalFilter(
  terms: string[],
  startParameterIndex: number
): { sql: string; params: string[]; nextParameterIndex: number } {
  if (!Number.isSafeInteger(startParameterIndex) || startParameterIndex < 1) {
    throw new Error('PostgreSQL parameter indices start at 1.');
  }
  const normalized = Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean))).slice(0, 8);
  const params: string[] = [];
  const clauses = normalized.map((term) => {
    const placeholder = '$' + String(startParameterIndex + params.length);
    params.push('%' + term + '%');
    return '(topic ILIKE ' + placeholder + ' OR title ILIKE ' + placeholder + ' OR content ILIKE ' + placeholder + ')';
  });
  return {
    sql: clauses.length > 0 ? '(' + clauses.join(' OR ') + ')' : 'FALSE',
    params,
    nextParameterIndex: startParameterIndex + params.length,
  };
}

export function buildPostgresUpdateTaskIfStatusQuery(
  id: string,
  tenantId: string,
  expectedStatuses: TaskStatus[],
  patch: Partial<
    Pick<TaskRecord, 'status' | 'plan' | 'checkpoint' | 'result' | 'verification' | 'error' | 'usage' | 'loop_signature_counts' | 'completed_at'>
  >
): { sql: string; values: unknown[] } | null {
  if (expectedStatuses.length === 0) return null;
  const columns: Record<string, { column: string; serialize: (value: unknown) => unknown }> = {
    status: { column: 'status', serialize: (v) => v },
    plan: { column: 'plan', serialize: (v) => JSON.stringify(v) },
    checkpoint: { column: 'checkpoint', serialize: (v) => JSON.stringify(v) },
    result: { column: 'result', serialize: (v) => (v === null ? null : JSON.stringify(v)) },
    verification: { column: 'verification', serialize: (v) => (v === null ? null : JSON.stringify(v)) },
    error: { column: 'error', serialize: (v) => v },
    usage: { column: 'usage', serialize: (v) => JSON.stringify(v) },
    loop_signature_counts: { column: 'loop_signature_counts', serialize: (v) => JSON.stringify(v) },
    completed_at: { column: 'completed_at', serialize: (v) => v },
  };
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const definition = columns[key];
    if (!definition) continue;
    values.push(definition.serialize(value));
    assignments.push(`${definition.column} = $${values.length}`);
  }
  if (assignments.length === 0) return null;
  assignments.push('updated_at = NOW()');
  values.push(id, tenantId, expectedStatuses);
  return {
    sql: `UPDATE tasks SET ${assignments.join(', ')} WHERE id = $${values.length - 2} AND tenant_id = $${values.length - 1} AND status = ANY($${values.length}::text[]) RETURNING *`,
    values,
  };
}

export class PostgresNeoDatabase implements NeoDatabase {
  public readonly mode = 'postgresql' as const;
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async init(): Promise<void> {
    for (const file of ['001_init.sql', '002_neo_cognitive_core.sql', '003_neo_upgrade.sql', '004_promoted_upgrade_status.sql', '005_variable_dimension_embeddings.sql']) {
      const migrationPath = path.resolve(process.cwd(), 'migrations', file);
      if (fs.existsSync(migrationPath)) {
        const sql = fs.readFileSync(migrationPath, 'utf8');
        await this.pool.query(sql);
      }
    }
    await seedInitialData(this);
  }

  // --- Tenants & API Keys ---
  async listTenants(): Promise<TenantRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM tenants ORDER BY created_at ASC');
    return rows;
  }

  async getTenantById(id: string): Promise<TenantRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM tenants WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async createTenant(input: Omit<TenantRecord, 'id' | 'created_at'>): Promise<TenantRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO tenants (id, name, slug, workspace_language, webhook_url, webhook_secret, pii_redaction, rate_limit_rpm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [uuidv4(), input.name, input.slug, input.workspace_language, input.webhook_url, input.webhook_secret, input.pii_redaction, input.rate_limit_rpm]
    );
    return rows[0];
  }

  async updateTenant(
    id: string,
    patch: Partial<Pick<TenantRecord, 'workspace_language' | 'webhook_url' | 'webhook_secret' | 'pii_redaction' | 'rate_limit_rpm'>>
  ): Promise<TenantRecord | null> {
    const existing = await this.getTenantById(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    const { rows } = await this.pool.query(
      `UPDATE tenants SET workspace_language = $1, webhook_url = $2, webhook_secret = $3, pii_redaction = $4, rate_limit_rpm = $5 WHERE id = $6 RETURNING *`,
      [merged.workspace_language, merged.webhook_url, merged.webhook_secret, merged.pii_redaction, merged.rate_limit_rpm, id]
    );
    return rows[0] || null;
  }

  async listApiKeys(tenantId?: string): Promise<ApiKeyRecord[]> {
    const { rows } = tenantId
      ? await this.pool.query('SELECT * FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId])
      : await this.pool.query('SELECT * FROM api_keys ORDER BY created_at DESC');
    return rows;
  }

  async getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM api_keys WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM api_keys WHERE key_hash = $1', [hash]);
    return rows[0] || null;
  }

  async createApiKey(input: Omit<ApiKeyRecord, 'id' | 'last_used_at' | 'revoked_at' | 'created_at'>): Promise<ApiKeyRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [uuidv4(), input.tenant_id, input.name, input.key_prefix, input.key_hash, JSON.stringify(input.scopes)]
    );
    return rows[0];
  }

  async touchApiKey(id: string): Promise<void> {
    await this.pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [id]);
  }

  async revokeApiKey(id: string): Promise<boolean> {
    const res = await this.pool.query('UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  // --- Conversations & Messages ---
  async listConversations(tenantId: string, limit = 30): Promise<ConversationRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM conversations WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2', [tenantId, limit]);
    return rows;
  }

  async getConversationById(id: string, tenantId: string): Promise<ConversationRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return rows[0] || null;
  }

  async createConversation(input: Omit<ConversationRecord, 'id' | 'created_at' | 'updated_at'>): Promise<ConversationRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO conversations (id, tenant_id, user_id, title, language, metadata) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [uuidv4(), input.tenant_id, input.user_id, input.title, input.language, JSON.stringify(input.metadata)]
    );
    return rows[0];
  }

  async deleteConversation(id: string, tenantId: string): Promise<boolean> {
    await this.pool.query('DELETE FROM messages WHERE conversation_id = $1 AND tenant_id = $2', [id, tenantId]);
    const res = await this.pool.query('DELETE FROM conversations WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  async listMessages(conversationId: string, tenantId: string, limit = 100): Promise<MessageRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 AND tenant_id = $2 ORDER BY created_at ASC LIMIT $3',
      [conversationId, tenantId, limit]
    );
    return rows;
  }

  async addMessage(input: Omit<MessageRecord, 'id' | 'created_at'>): Promise<MessageRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO messages (id, conversation_id, tenant_id, role, content, metadata) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [uuidv4(), input.conversation_id, input.tenant_id, input.role, input.content, JSON.stringify(input.metadata)]
    );
    await this.pool.query('UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND tenant_id = $2', [input.conversation_id, input.tenant_id]);
    return rows[0];
  }

  // --- Memories ---
  async insertMemory(input: Parameters<NeoDatabase['insertMemory']>[0]): Promise<MemoryRecord> {
    const id = uuidv4();
    const embModel = input.embedding_model || 'neo-embed-local-v2';
    const embDim = input.embedding_dim ?? input.embedding.length;
    if (embDim !== input.embedding.length) {
      throw new Error('Embedding metadata dimension does not match the supplied vector length.');
    }
    const vecLiteral = toPgVectorLiteral(input.embedding);
    if (input.embedding.length > 0 && !vecLiteral) {
      throw new Error('Embedding vector must contain finite numeric values.');
    }
    const { rows } = await this.pool.query(
      `INSERT INTO memories (id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, importance_score, confidence_score, epistemic_status, retention_policy, valid_from, valid_to, superseded_by, version, embedding, embedding_model, embedding_dim)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::vector, $20, $21) RETURNING *`,
      [
        id,
        input.tenant_id,
        input.memory_type,
        input.topic,
        input.title,
        input.content,
        JSON.stringify(input.structured_facts || {}),
        input.source_url,
        input.reliability_score ?? 0.8,
        input.freshness_score ?? 1.0,
        input.importance_score ?? 0.6,
        input.confidence_score ?? 0.8,
        input.epistemic_status ?? ('observation' as EpistemicStatus),
        input.retention_policy ?? ('long_term' as RetentionPolicy),
        input.valid_from ?? new Date().toISOString(),
        input.valid_to ?? null,
        input.superseded_by ?? null,
        input.version ?? 1,
        vecLiteral,
        embModel,
        embDim,
      ]
    );
    return { ...rows[0], embedding: input.embedding };
  }

  async getMemoryById(id: string, tenantId: string, includeGlobal = false): Promise<MemoryRecord | null> {
    const { rows } = includeGlobal
      ? await this.pool.query(
          `SELECT id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, importance_score, confidence_score, epistemic_status, retention_policy, valid_from, valid_to, superseded_by, version, deleted_at, last_accessed_at, embedding_model, embedding_dim, created_at FROM memories WHERE id = $1 AND (tenant_id = $2 OR tenant_id = 'global') AND deleted_at IS NULL`,
          [id, tenantId]
        )
      : await this.pool.query(
          `SELECT id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, importance_score, confidence_score, epistemic_status, retention_policy, valid_from, valid_to, superseded_by, version, deleted_at, last_accessed_at, embedding_model, embedding_dim, created_at FROM memories WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
          [id, tenantId]
        );
    return rows[0] ? { ...rows[0], embedding: [] } : null;
  }

  async updateMemory(id: string, tenantId: string, patch: Parameters<NeoDatabase['updateMemory']>[2]): Promise<MemoryRecord | null> {
    const existing = await this.getMemoryById(id, tenantId, false);
    if (!existing) return null;
    if (patch.embedding && patch.embedding_dim !== undefined && patch.embedding_dim !== patch.embedding.length) {
      throw new Error('Embedding metadata dimension does not match the supplied vector length.');
    }
    if (!patch.embedding && (
      (patch.embedding_model !== undefined && patch.embedding_model !== existing.embedding_model) ||
      (patch.embedding_dim !== undefined && patch.embedding_dim !== existing.embedding_dim)
    )) {
      throw new Error('Embedding model or dimension cannot change without supplying the matching replacement vector.');
    }
    const merged = {
      ...existing,
      ...patch,
      embedding_dim: patch.embedding_dim ?? (patch.embedding ? patch.embedding.length : existing.embedding_dim),
      version: existing.version + 1,
    };
    if (patch.embedding && merged.embedding_dim !== patch.embedding.length) {
      throw new Error('Embedding metadata dimension does not match the supplied vector length.');
    }
    const embeddingLiteral = patch.embedding ? toPgVectorLiteral(patch.embedding) : null;
    if (patch.embedding && !embeddingLiteral) {
      throw new Error('A replacement embedding must contain finite numeric values.');
    }
    const { rows } = await this.pool.query(
      `UPDATE memories SET title = $1, content = $2, topic = $3, structured_facts = $4, reliability_score = $5, freshness_score = $6, importance_score = $7, confidence_score = $8, epistemic_status = $9, retention_policy = $10, valid_from = $11, valid_to = $12, superseded_by = $13, version = $14, embedding = COALESCE($15::vector, embedding), embedding_model = $16, embedding_dim = $17 WHERE id = $18 AND tenant_id = $19 RETURNING *`,
      [
        merged.title,
        merged.content,
        merged.topic,
        JSON.stringify(merged.structured_facts),
        merged.reliability_score,
        merged.freshness_score,
        merged.importance_score,
        merged.confidence_score,
        merged.epistemic_status,
        merged.retention_policy,
        merged.valid_from,
        merged.valid_to,
        merged.superseded_by,
        merged.version,
        embeddingLiteral,
        merged.embedding_model,
        merged.embedding_dim,
        id,
        tenantId,
      ]
    );
    return rows[0] ? { ...rows[0], embedding: patch.embedding || [] } : null;
  }

  async deleteMemory(id: string, tenantId: string, hardDelete = false): Promise<boolean> {
    const res = hardDelete
      ? await this.pool.query('DELETE FROM memories WHERE id = $1 AND tenant_id = $2', [id, tenantId])
      : await this.pool.query('UPDATE memories SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL', [id, tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  async listMemories(opts?: MemoryQueryOptions): Promise<MemoryRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (!opts?.includeDeleted) clauses.push('deleted_at IS NULL');
    if (opts?.memoryType) {
      clauses.push(`memory_type = $${idx++}`);
      params.push(opts.memoryType);
    }
    if (opts?.tenantId) {
      if (opts.includeGlobal) {
        clauses.push(`(tenant_id = $${idx++} OR tenant_id = $${idx++})`);
        params.push(opts.tenantId, 'global');
      } else {
        clauses.push(`tenant_id = $${idx++}`);
        params.push(opts.tenantId);
      }
    }
    if (opts?.validAt) {
      clauses.push(`(valid_from IS NULL OR valid_from <= $${idx}) AND (valid_to IS NULL OR valid_to >= $${idx})`);
      params.push(opts.validAt);
      idx++;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(opts?.limit ?? 50, opts?.offset ?? 0);
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, importance_score, confidence_score, epistemic_status, retention_policy, valid_from, valid_to, superseded_by, version, deleted_at, last_accessed_at, embedding_model, embedding_dim, created_at FROM memories ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );
    return rows.map((r) => ({ ...r, embedding: [] }));
  }

  async searchMemories(queryEmbedding: number[], opts?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const queryModel = opts?.queryEmbeddingModel;
    const canVector = queryEmbedding.length > 0 && queryEmbedding.length <= 16_000 && queryEmbedding.every(Number.isFinite) && queryEmbedding.some((value) => value !== 0);
    const queryVectorLiteral = canVector ? toPgVectorLiteral(queryEmbedding) : null;
    const filters = buildPostgresMemoryFilters(opts);
    const clauses = filters.clauses;
    const params = [...filters.params];
    const idx = filters.nextParameterIndex;
    const baseClauses = [...clauses];
    const baseParams = [...params];
    let rows: Record<string, unknown>[];
    if (canVector && queryVectorLiteral) {
      params.unshift(queryVectorLiteral);
      // Re-index existing $ placeholders by +1
      const shiftedClauses = clauses.map((c) => c.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`));
      const nextIdx = idx + 1;
      const modelCheck = queryModel ? `embedding_model = $${nextIdx}` : 'TRUE';
      if (queryModel) params.push(queryModel);
      const limitIdx = params.length + 1;
      params.push(150);
      const res = await this.pool.query(
        `SELECT id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, importance_score, confidence_score, epistemic_status, retention_policy, valid_from, valid_to, superseded_by, version, deleted_at, last_accessed_at, embedding_model, embedding_dim, created_at,
         CASE WHEN embedding IS NOT NULL AND embedding_dim = ${queryEmbedding.length} AND ${modelCheck} THEN 1 - (embedding <=> $1::vector) ELSE 0 END AS similarity
         FROM memories WHERE ${shiftedClauses.join(' AND ')}
         ORDER BY similarity DESC, created_at DESC LIMIT $${limitIdx}`,
        params
      );
      rows = res.rows;
    } else {
      params.push(150);
      const res = await this.pool.query(
        `SELECT id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, importance_score, confidence_score, epistemic_status, retention_policy, valid_from, valid_to, superseded_by, version, deleted_at, last_accessed_at, embedding_model, embedding_dim, created_at, 0 AS similarity
         FROM memories WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${idx}`,
        params
      );
      rows = res.rows;
    }

    const queryTerms = opts?.queryText
      ? Array.from(new Set(tokenizeMultilingual(opts.queryText).filter((term) => term.length >= 2))).slice(0, 8)
      : [];
    if (queryTerms.length > 0) {
      const lexicalFilter = buildPostgresLexicalFilter(queryTerms, baseParams.length + 1);
      const lexicalClauses = [...baseClauses, lexicalFilter.sql];
      const lexicalParams: unknown[] = [...baseParams, ...lexicalFilter.params, 200];
      const limitParameter = lexicalParams.length;
      const lexicalResult = await this.pool.query(
        `SELECT id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, importance_score, confidence_score, epistemic_status, retention_policy, valid_from, valid_to, superseded_by, version, deleted_at, last_accessed_at, embedding_model, embedding_dim, created_at, 0 AS similarity
         FROM memories WHERE ${lexicalClauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${limitParameter}`,
        lexicalParams
      );
      const candidateMap = new Map(rows.map((row) => [String(row.id), row]));
      for (const row of lexicalResult.rows as Record<string, unknown>[]) {
        if (!candidateMap.has(String(row.id))) candidateMap.set(String(row.id), row);
      }
      rows = Array.from(candidateMap.values());
    }

    if (rows.length === 0) return [];
    const bm25 = opts?.queryText
      ? computeBm25Scores(
          opts.queryText,
          rows.map((row) => `${row.topic} ${row.title} ${row.content}`)
        )
      : rows.map(() => 0);
    const ranked = hybridRerank(
      rows.map((r, i) => ({
        item: { ...r, embedding: [] } as unknown as MemoryRecord,
        vectorScore: Number(r.similarity || 0),
        lexicalScore: bm25[i] || 0,
        reliability: Number(r.reliability_score ?? 0.8),
        importance: Number(r.importance_score ?? 0.6),
        freshness: Number(r.freshness_score ?? 1.0) * computeTemporalDecay(String(r.created_at)),
      }))
    );
    const minScore = opts?.minScore ?? 0.04;
    const filtered = ranked.filter((m) => m.similarity >= minScore || m.hybridScore >= minScore + 0.08).slice(0, opts?.limit ?? 8);
    if (filtered.length > 0) {
      const ids = filtered.map((memory) => memory.id);
      await this.pool.query('UPDATE memories SET last_accessed_at = NOW() WHERE id = ANY($1::text[])', [ids]);
    }
    return filtered;
  }

  async countMemories(tenantId?: string): Promise<MemoryCounts> {
    const { rows } = tenantId
      ? await this.pool.query(`SELECT memory_type, COUNT(*)::int as cnt FROM memories WHERE deleted_at IS NULL AND (tenant_id = $1 OR tenant_id = 'global') GROUP BY memory_type`, [tenantId])
      : await this.pool.query('SELECT memory_type, COUNT(*)::int as cnt FROM memories WHERE deleted_at IS NULL GROUP BY memory_type');
    const counts: MemoryCounts = { total: 0, working: 0, episodic: 0, semantic: 0, procedural: 0, personal: 0, organizational: 0, temporal: 0 };
    for (const r of rows) {
      const c = Number(r.cnt || 0);
      counts.total += c;
      if (r.memory_type in counts && r.memory_type !== 'total') {
        counts[r.memory_type as keyof Omit<MemoryCounts, 'total'>] = c;
      }
    }
    return counts;
  }

  // --- Skills ---
  async listSkills(): Promise<SkillRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM skills ORDER BY updated_at DESC');
    return rows;
  }

  async getSkillByIdOrSlug(idOrSlug: string): Promise<SkillRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM skills WHERE id = $1 OR slug = $1', [idOrSlug]);
    return rows[0] || null;
  }

  async upsertSkill(input: Omit<SkillRecord, 'id' | 'updated_at'>): Promise<SkillRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO skills (id, slug, title, domain, version, format, content, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, domain = EXCLUDED.domain, version = skills.version + 1, format = EXCLUDED.format, content = EXCLUDED.content, metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING *`,
      [uuidv4(), input.slug, input.title, input.domain, input.version, input.format, input.content, JSON.stringify(input.metadata)]
    );
    return rows[0];
  }

  async updateSkillById(id: string, patch: Partial<Pick<SkillRecord, 'title' | 'domain' | 'content' | 'metadata'>>): Promise<SkillRecord | null> {
    const existing = await this.getSkillByIdOrSlug(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch, version: existing.version + 1 };
    const { rows } = await this.pool.query(
      `UPDATE skills SET title = $1, domain = $2, version = $3, content = $4, metadata = $5, updated_at = NOW() WHERE id = $6 RETURNING *`,
      [merged.title, merged.domain, merged.version, merged.content, JSON.stringify(merged.metadata), existing.id]
    );
    return rows[0] || null;
  }

  // --- Streams, Sources & Research ---
  async listTopicStreams(): Promise<TopicStreamRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM topic_streams ORDER BY created_at ASC');
    return rows;
  }

  async createTopicStream(input: Pick<TopicStreamRecord, 'topic' | 'category' | 'interval_minutes'>): Promise<TopicStreamRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO topic_streams (id, topic, category, enabled, interval_minutes) VALUES ($1, $2, $3, TRUE, $4) RETURNING *`,
      [uuidv4(), input.topic, input.category, input.interval_minutes]
    );
    return rows[0];
  }

  async toggleTopicStream(id: string, enabled: boolean): Promise<TopicStreamRecord | null> {
    const { rows } = await this.pool.query('UPDATE topic_streams SET enabled = $1 WHERE id = $2 RETURNING *', [enabled, id]);
    return rows[0] || null;
  }

  async markTopicCrawled(id: string, addedItems: number): Promise<void> {
    await this.pool.query('UPDATE topic_streams SET last_crawled_at = NOW(), items_ingested = items_ingested + $1 WHERE id = $2', [addedItems, id]);
  }

  async upsertKnowledgeSource(input: Omit<KnowledgeSourceRecord, 'id' | 'created_at'>): Promise<KnowledgeSourceRecord> {
    const existing = await this.pool.query('SELECT id FROM knowledge_sources WHERE url = $1 AND tenant_id = $2', [input.url, input.tenant_id]);
    if (existing.rows[0]) {
      const { rows } = await this.pool.query(
        `UPDATE knowledge_sources SET title = $1, source_type = $2, author = $3, published_at = $4, last_verified_at = $5, reliability_score = $6, quality_breakdown = $7, content_hash = $8, injection_flagged = $9 WHERE id = $10 RETURNING *`,
        [input.title, input.source_type, input.author, input.published_at, input.last_verified_at, input.reliability_score, JSON.stringify(input.quality_breakdown), input.content_hash, input.injection_flagged, existing.rows[0].id]
      );
      return rows[0];
    }
    const { rows } = await this.pool.query(
      `INSERT INTO knowledge_sources (id, tenant_id, url, title, source_type, author, published_at, last_verified_at, reliability_score, quality_breakdown, content_hash, injection_flagged)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [uuidv4(), input.tenant_id, input.url, input.title, input.source_type, input.author, input.published_at, input.last_verified_at, input.reliability_score, JSON.stringify(input.quality_breakdown), input.content_hash, input.injection_flagged]
    );
    return rows[0];
  }

  async listKnowledgeSources(tenantId?: string, limit = 50): Promise<KnowledgeSourceRecord[]> {
    const { rows } = tenantId
      ? await this.pool.query('SELECT * FROM knowledge_sources WHERE tenant_id = $1 ORDER BY last_verified_at DESC LIMIT $2', [tenantId, limit])
      : await this.pool.query('SELECT * FROM knowledge_sources ORDER BY last_verified_at DESC LIMIT $1', [limit]);
    return rows;
  }

  async createResearchReport(input: Omit<ResearchReportRecord, 'id' | 'created_at'>): Promise<ResearchReportRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO research_reports (id, tenant_id, query, sub_questions, status, summary, findings, contradictions, citations, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [uuidv4(), input.tenant_id, input.query, JSON.stringify(input.sub_questions), input.status, input.summary, JSON.stringify(input.findings), JSON.stringify(input.contradictions), JSON.stringify(input.citations), input.confidence]
    );
    return rows[0];
  }

  async getResearchReportById(id: string, tenantId: string): Promise<ResearchReportRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM research_reports WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return rows[0] || null;
  }

  async listResearchReports(tenantId: string, limit = 30): Promise<ResearchReportRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM research_reports WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2', [tenantId, limit]);
    return rows;
  }

  // --- Knowledge Graph ---
  async upsertEntity(input: Omit<GraphEntityRecord, 'id' | 'created_at' | 'updated_at'>): Promise<GraphEntityRecord> {
    const existing = await this.pool.query('SELECT * FROM entities WHERE tenant_id = $1 AND lower(name) = lower($2) AND entity_type = $3', [
      input.tenant_id,
      input.name,
      input.entity_type,
    ]);
    const vecLiteral = toPgVectorLiteral(input.embedding);
    const embModel = input.embedding_model || 'neo-embed-local-v2';
    const embDim = input.embedding_dim ?? input.embedding.length;
    if (existing.rows[0]) {
      const mergedAliases = Array.from(new Set([...(existing.rows[0].aliases || []), ...input.aliases]));
      const mergedAttrs = { ...(existing.rows[0].attributes || {}), ...input.attributes };
      const { rows } = await this.pool.query(
        `UPDATE entities SET aliases = $1, attributes = $2, confidence = $3, embedding = $4::vector, embedding_model = $5, embedding_dim = $6, updated_at = NOW() WHERE id = $7 RETURNING id, tenant_id, name, entity_type, aliases, attributes, confidence, embedding_model, embedding_dim, created_at, updated_at`,
        [JSON.stringify(mergedAliases), JSON.stringify(mergedAttrs), Math.max(Number(existing.rows[0].confidence), input.confidence), vecLiteral, embModel, embDim, existing.rows[0].id]
      );
      return { ...rows[0], embedding: input.embedding };
    }
    const { rows } = await this.pool.query(
      `INSERT INTO entities (id, tenant_id, name, entity_type, aliases, attributes, confidence, embedding, embedding_model, embedding_dim) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10) RETURNING id, tenant_id, name, entity_type, aliases, attributes, confidence, embedding_model, embedding_dim, created_at, updated_at`,
      [uuidv4(), input.tenant_id, input.name, input.entity_type, JSON.stringify(input.aliases), JSON.stringify(input.attributes), input.confidence, vecLiteral, embModel, embDim]
    );
    return { ...rows[0], embedding: input.embedding };
  }

  async getEntityById(id: string, tenantId: string): Promise<GraphEntityRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT id, tenant_id, name, entity_type, aliases, attributes, confidence, embedding_model, embedding_dim, created_at, updated_at FROM entities WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    return rows[0] ? { ...rows[0], embedding: [] } : null;
  }

  async listEntities(tenantId: string, opts?: { entityType?: string; query?: string; limit?: number }): Promise<GraphEntityRecord[]> {
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    let idx = 2;
    if (opts?.entityType) {
      clauses.push(`entity_type = $${idx++}`);
      params.push(opts.entityType);
    }
    if (opts?.query) {
      clauses.push(`(lower(name) LIKE $${idx} OR aliases::text ILIKE $${idx})`);
      params.push(`%${opts.query.toLowerCase()}%`);
      idx++;
    }
    params.push(opts?.limit ?? 50);
    const { rows } = await this.pool.query(`SELECT id, tenant_id, name, entity_type, aliases, attributes, confidence, embedding_model, embedding_dim, created_at, updated_at FROM entities WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT $${idx}`, params);
    return rows.map((r) => ({ ...r, embedding: [] }));
  }

  async addRelationship(input: Omit<GraphRelationshipRecord, 'id' | 'created_at'>): Promise<GraphRelationshipRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO relationships (id, tenant_id, source_entity_id, target_entity_id, relation_type, properties, source_url, confidence, valid_from, valid_to, contradicts_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [uuidv4(), input.tenant_id, input.source_entity_id, input.target_entity_id, input.relation_type, JSON.stringify(input.properties), input.source_url, input.confidence, input.valid_from, input.valid_to, input.contradicts_id]
    );
    return rows[0];
  }

  async listRelationships(tenantId: string, entityId?: string, limit = 100): Promise<GraphRelationshipRecord[]> {
    const { rows } = entityId
      ? await this.pool.query('SELECT * FROM relationships WHERE tenant_id = $1 AND (source_entity_id = $2 OR target_entity_id = $2) ORDER BY created_at DESC LIMIT $3', [tenantId, entityId, limit])
      : await this.pool.query('SELECT * FROM relationships WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2', [tenantId, limit]);
    return rows;
  }

  // --- Tasks ---
  async createTask(input: Omit<TaskRecord, 'id' | 'created_at' | 'updated_at' | 'completed_at'>): Promise<TaskRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO tasks (id, tenant_id, goal, autonomy, priority, status, plan, checkpoint, result, verification, error, budgets, usage, loop_signature_counts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        uuidv4(),
        input.tenant_id,
        input.goal,
        input.autonomy,
        input.priority,
        input.status,
        JSON.stringify(input.plan),
        JSON.stringify(input.checkpoint),
        input.result ? JSON.stringify(input.result) : null,
        input.verification ? JSON.stringify(input.verification) : null,
        input.error,
        JSON.stringify(input.budgets),
        JSON.stringify(input.usage),
        JSON.stringify(input.loop_signature_counts),
      ]
    );
    return rows[0];
  }

  async getTaskById(id: string, tenantId: string): Promise<TaskRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return rows[0] || null;
  }

  async listTasks(tenantId?: string, opts?: { status?: TaskStatus; priority?: TaskPriority; limit?: number }): Promise<TaskRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (tenantId) {
      clauses.push(`tenant_id = $${idx++}`);
      params.push(tenantId);
    }
    if (opts?.status) {
      clauses.push(`status = $${idx++}`);
      params.push(opts.status);
    }
    if (opts?.priority) {
      clauses.push(`priority = $${idx++}`);
      params.push(opts.priority);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(opts?.limit ?? 40);
    const { rows } = await this.pool.query(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT $${idx}`, params);
    return rows;
  }

  async updateTask(id: string, patch: Parameters<NeoDatabase['updateTask']>[1]): Promise<TaskRecord | null> {
    const existingRes = await this.pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (!existingRes.rows[0]) return null;
    const merged = { ...existingRes.rows[0], ...patch };
    const { rows } = await this.pool.query(
      `UPDATE tasks SET status = $1, plan = $2, checkpoint = $3, result = $4, verification = $5, error = $6, usage = $7, loop_signature_counts = $8, updated_at = NOW(), completed_at = $9 WHERE id = $10 RETURNING *`,
      [
        merged.status,
        JSON.stringify(merged.plan),
        JSON.stringify(merged.checkpoint),
        merged.result ? JSON.stringify(merged.result) : null,
        merged.verification ? JSON.stringify(merged.verification) : null,
        merged.error,
        JSON.stringify(merged.usage),
        JSON.stringify(merged.loop_signature_counts),
        merged.completed_at,
        id,
      ]
    );
    return rows[0] || null;
  }

  async updateTaskIfStatus(
    id: string,
    tenantId: string,
    expectedStatuses: TaskStatus[],
    patch: Parameters<NeoDatabase['updateTask']>[1]
  ): Promise<TaskRecord | null> {
    if (expectedStatuses.length === 0) return null;
    const query = buildPostgresUpdateTaskIfStatusQuery(id, tenantId, expectedStatuses, patch);
    if (!query) return Object.keys(patch).length === 0 ? this.getTaskById(id, tenantId) : null;
    const { rows } = await this.pool.query(query.sql, query.values);
    return rows[0] || null;
  }

  async upsertTaskStep(input: Omit<TaskStepRecord, 'id'> & { id?: string }): Promise<TaskStepRecord> {
    const existing = await this.pool.query('SELECT id FROM task_steps WHERE task_id = $1 AND step_index = $2', [input.task_id, input.step_index]);
    if (existing.rows[0]) {
      const { rows } = await this.pool.query(
        `UPDATE task_steps SET title = $1, action_type = $2, tool_id = $3, depends_on = $4, status = $5, input = $6, output = $7, error = $8, attempts = $9, started_at = $10, finished_at = $11 WHERE id = $12 RETURNING *`,
        [input.title, input.action_type, input.tool_id, JSON.stringify(input.depends_on), input.status, JSON.stringify(input.input), input.output ? JSON.stringify(input.output) : null, input.error, input.attempts, input.started_at, input.finished_at, existing.rows[0].id]
      );
      return rows[0];
    }
    const { rows } = await this.pool.query(
      `INSERT INTO task_steps (id, task_id, tenant_id, step_index, title, action_type, tool_id, depends_on, status, input, output, error, attempts, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [input.id || uuidv4(), input.task_id, input.tenant_id, input.step_index, input.title, input.action_type, input.tool_id, JSON.stringify(input.depends_on), input.status, JSON.stringify(input.input), input.output ? JSON.stringify(input.output) : null, input.error, input.attempts, input.started_at, input.finished_at]
    );
    return rows[0];
  }

  async listTaskSteps(taskId: string, tenantId: string): Promise<TaskStepRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM task_steps WHERE task_id = $1 AND tenant_id = $2 ORDER BY step_index ASC', [taskId, tenantId]);
    return rows;
  }

  async appendTaskEvent(input: Omit<TaskEventRecord, 'id' | 'created_at'>): Promise<TaskEventRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO task_events (id, task_id, tenant_id, event_type, payload) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [uuidv4(), input.task_id, input.tenant_id, input.event_type, JSON.stringify(input.payload)]
    );
    return rows[0];
  }

  async listTaskEvents(taskId: string, tenantId: string, limit = 100): Promise<TaskEventRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM task_events WHERE task_id = $1 AND tenant_id = $2 ORDER BY created_at ASC LIMIT $3', [taskId, tenantId, limit]);
    return rows;
  }

  // --- Autonomous Objectives ---
  async createObjective(input: Omit<ObjectiveRecord, 'id' | 'created_at' | 'updated_at'>): Promise<ObjectiveRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO objectives (id, tenant_id, title, description, category, priority_score, value_score, urgency_score, uncertainty_score, progress_pct, status, success_criteria, compute_budget_ms, compute_used_ms, linked_task_ids, linked_research_ids, knowledge_gaps, last_evaluated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        uuidv4(),
        input.tenant_id,
        input.title,
        input.description,
        input.category,
        input.priority_score,
        input.value_score,
        input.urgency_score,
        input.uncertainty_score,
        input.progress_pct,
        input.status,
        input.success_criteria,
        input.compute_budget_ms,
        input.compute_used_ms,
        JSON.stringify(input.linked_task_ids),
        JSON.stringify(input.linked_research_ids),
        JSON.stringify(input.knowledge_gaps),
        input.last_evaluated_at,
      ]
    );
    return rows[0];
  }

  async getObjectiveById(id: string, tenantId: string): Promise<ObjectiveRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM objectives WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return rows[0] || null;
  }

  async listObjectives(tenantId?: string, opts?: { status?: ObjectiveStatus; limit?: number }): Promise<ObjectiveRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (tenantId) {
      clauses.push(`tenant_id = $${idx++}`);
      params.push(tenantId);
    }
    if (opts?.status) {
      clauses.push(`status = $${idx++}`);
      params.push(opts.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(opts?.limit ?? 50);
    const { rows } = await this.pool.query(`SELECT * FROM objectives ${where} ORDER BY priority_score DESC, updated_at DESC LIMIT $${idx}`, params);
    return rows;
  }

  async updateObjective(id: string, tenantId: string, patch: Parameters<NeoDatabase['updateObjective']>[2]): Promise<ObjectiveRecord | null> {
    const existing = await this.getObjectiveById(id, tenantId);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    const { rows } = await this.pool.query(
      `UPDATE objectives SET title = $1, description = $2, priority_score = $3, value_score = $4, urgency_score = $5, uncertainty_score = $6, progress_pct = $7, status = $8, compute_used_ms = $9, linked_task_ids = $10, linked_research_ids = $11, knowledge_gaps = $12, last_evaluated_at = $13, updated_at = NOW() WHERE id = $14 AND tenant_id = $15 RETURNING *`,
      [
        merged.title,
        merged.description,
        merged.priority_score,
        merged.value_score,
        merged.urgency_score,
        merged.uncertainty_score,
        merged.progress_pct,
        merged.status,
        merged.compute_used_ms,
        JSON.stringify(merged.linked_task_ids),
        JSON.stringify(merged.linked_research_ids),
        JSON.stringify(merged.knowledge_gaps),
        merged.last_evaluated_at,
        id,
        tenantId,
      ]
    );
    return rows[0] || null;
  }

  // --- Tools ---
  async listTools(): Promise<ToolRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM tools ORDER BY name ASC');
    return rows;
  }

  async getToolById(id: string): Promise<ToolRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM tools WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async upsertTool(input: Omit<ToolRecord, 'updated_at'>): Promise<ToolRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO tools (id, name, version, description, input_schema, output_schema, risk_level, required_scopes, timeout_ms, execution_env, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, description = EXCLUDED.description, input_schema = EXCLUDED.input_schema, output_schema = EXCLUDED.output_schema, risk_level = EXCLUDED.risk_level, required_scopes = EXCLUDED.required_scopes, timeout_ms = EXCLUDED.timeout_ms, execution_env = EXCLUDED.execution_env, enabled = EXCLUDED.enabled, updated_at = NOW()
       RETURNING *`,
      [input.id, input.name, input.version, input.description, JSON.stringify(input.input_schema), JSON.stringify(input.output_schema), input.risk_level, JSON.stringify(input.required_scopes), input.timeout_ms, input.execution_env, input.enabled]
    );
    return rows[0];
  }

  async recordToolExecution(input: Omit<ToolExecutionRecord, 'id' | 'created_at'>): Promise<ToolExecutionRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO tool_executions (id, tenant_id, task_id, tool_id, actor, input, output, ok, error, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [uuidv4(), input.tenant_id, input.task_id, input.tool_id, input.actor, JSON.stringify(input.input), input.output ? JSON.stringify(input.output) : null, input.ok, input.error, input.duration_ms]
    );
    return rows[0];
  }

  async listToolExecutions(tenantId?: string, limit = 50): Promise<ToolExecutionRecord[]> {
    const { rows } = tenantId
      ? await this.pool.query('SELECT * FROM tool_executions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2', [tenantId, limit])
      : await this.pool.query('SELECT * FROM tool_executions ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  // --- Models ---
  async listModels(): Promise<ModelRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM models ORDER BY created_at ASC');
    return rows;
  }

  async getModelById(id: string): Promise<ModelRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM models WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async upsertModel(input: Omit<ModelRecord, 'created_at'>): Promise<ModelRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO models (id, name, version, runtime, architecture, source_repo, license, weight_location, checksum_sha256, download_status, quantization, context_length, vram_gb, ram_gb, modalities, roles, capabilities, benchmark_results, deployment_status, health_status, performance_metrics, last_validated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version, runtime = EXCLUDED.runtime, download_status = EXCLUDED.download_status, deployment_status = EXCLUDED.deployment_status, health_status = EXCLUDED.health_status, roles = EXCLUDED.roles, benchmark_results = EXCLUDED.benchmark_results, performance_metrics = EXCLUDED.performance_metrics, last_validated_at = EXCLUDED.last_validated_at
       RETURNING *`,
      [
        input.id,
        input.name,
        input.version,
        input.runtime,
        input.architecture,
        input.source_repo,
        input.license,
        input.weight_location,
        input.checksum_sha256,
        input.download_status,
        input.quantization,
        input.context_length,
        input.vram_gb,
        input.ram_gb,
        JSON.stringify(input.modalities),
        JSON.stringify(input.roles),
        JSON.stringify(input.capabilities),
        JSON.stringify(input.benchmark_results),
        input.deployment_status,
        input.health_status,
        JSON.stringify(input.performance_metrics),
        input.last_validated_at,
      ]
    );
    return rows[0];
  }

  async updateModel(id: string, patch: Parameters<NeoDatabase['updateModel']>[1]): Promise<ModelRecord | null> {
    const existing = await this.getModelById(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    const { rows } = await this.pool.query(
      `UPDATE models SET download_status = $1, weight_location = $2, checksum_sha256 = $3, roles = $4, deployment_status = $5, health_status = $6, performance_metrics = $7, benchmark_results = $8, last_validated_at = $9 WHERE id = $10 RETURNING *`,
      [
        merged.download_status,
        merged.weight_location,
        merged.checksum_sha256,
        JSON.stringify(merged.roles),
        merged.deployment_status,
        merged.health_status,
        JSON.stringify(merged.performance_metrics),
        JSON.stringify(merged.benchmark_results),
        merged.last_validated_at,
        id,
      ]
    );
    return rows[0] || null;
  }

  async deleteModel(id: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM models WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async recordModelEvaluation(input: Omit<ModelEvaluationRecord, 'id' | 'created_at'>): Promise<ModelEvaluationRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO model_evaluations (id, model_id, suite_version, overall_score, category_scores, avg_latency_ms, tokens_per_sec, passed_cases, total_cases, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [uuidv4(), input.model_id, input.suite_version, input.overall_score, JSON.stringify(input.category_scores), input.avg_latency_ms, input.tokens_per_sec, input.passed_cases, input.total_cases, JSON.stringify(input.details)]
    );
    return rows[0];
  }

  async listModelEvaluations(modelId?: string, limit = 20): Promise<ModelEvaluationRecord[]> {
    const { rows } = modelId
      ? await this.pool.query('SELECT * FROM model_evaluations WHERE model_id = $1 ORDER BY created_at DESC LIMIT $2', [modelId, limit])
      : await this.pool.query('SELECT * FROM model_evaluations ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  // --- Upgrades, Experiments & Training Jobs ---
  async listUpgrades(): Promise<SelfUpgradeRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM self_upgrades ORDER BY created_at DESC');
    return rows;
  }

  async getUpgradeById(id: string): Promise<SelfUpgradeRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM self_upgrades WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async createUpgrade(input: Omit<SelfUpgradeRecord, 'id' | 'created_at' | 'updated_at'>): Promise<SelfUpgradeRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO self_upgrades (id, title, diagnosis, branch_name, target_files, unified_diff, test_results, benchmark_before, benchmark_after, rollback_plan, status, auto_eligible)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [uuidv4(), input.title, input.diagnosis, input.branch_name, JSON.stringify(input.target_files), input.unified_diff, JSON.stringify(input.test_results), JSON.stringify(input.benchmark_before), JSON.stringify(input.benchmark_after), input.rollback_plan, input.status, input.auto_eligible]
    );
    return rows[0];
  }

  async updateUpgradeStatus(id: string, status: UpgradeStatus): Promise<SelfUpgradeRecord | null> {
    const { rows } = await this.pool.query('UPDATE self_upgrades SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [status, id]);
    return rows[0] || null;
  }

  async recordEvolutionExperiment(input: Omit<EvolutionExperimentRecord, 'id' | 'created_at'>): Promise<EvolutionExperimentRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO evolution_experiments (id, layer, title, hypothesis, config_before, config_after, metrics_before, metrics_after, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [uuidv4(), input.layer, input.title, input.hypothesis, JSON.stringify(input.config_before), JSON.stringify(input.config_after), JSON.stringify(input.metrics_before), JSON.stringify(input.metrics_after), input.status]
    );
    return rows[0];
  }

  async listEvolutionExperiments(limit = 30): Promise<EvolutionExperimentRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM evolution_experiments ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  async createTrainingJob(input: Omit<TrainingJobRecord, 'id' | 'created_at' | 'finished_at'>): Promise<TrainingJobRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO training_jobs (id, tenant_id, base_model_id, method, dataset_size, dataset_path, adapter_version, privacy_filtered, status, metrics)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [uuidv4(), input.tenant_id, input.base_model_id, input.method, input.dataset_size, input.dataset_path, input.adapter_version, input.privacy_filtered, input.status, JSON.stringify(input.metrics)]
    );
    return rows[0];
  }

  async updateTrainingJob(id: string, patch: Parameters<NeoDatabase['updateTrainingJob']>[1]): Promise<TrainingJobRecord | null> {
    const existingRes = await this.pool.query('SELECT * FROM training_jobs WHERE id = $1', [id]);
    if (!existingRes.rows[0]) return null;
    const merged = { ...existingRes.rows[0], ...patch };
    const { rows } = await this.pool.query(
      `UPDATE training_jobs SET status = $1, metrics = $2, dataset_size = $3, dataset_path = $4, adapter_version = $5, finished_at = $6 WHERE id = $7 RETURNING *`,
      [merged.status, JSON.stringify(merged.metrics), merged.dataset_size, merged.dataset_path, merged.adapter_version, merged.finished_at, id]
    );
    return rows[0] || null;
  }

  async listTrainingJobs(tenantId?: string, limit = 20): Promise<TrainingJobRecord[]> {
    const { rows } = tenantId
      ? await this.pool.query('SELECT * FROM training_jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2', [tenantId, limit])
      : await this.pool.query('SELECT * FROM training_jobs ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  // --- Dynamic APIs ---
  async listDynamicApis(tenantId?: string): Promise<DynamicApiRecord[]> {
    const { rows } = tenantId
      ? await this.pool.query('SELECT * FROM dynamic_apis WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId])
      : await this.pool.query('SELECT * FROM dynamic_apis ORDER BY created_at DESC');
    return rows;
  }

  async getDynamicApiBySlug(slug: string, tenantId?: string): Promise<DynamicApiRecord | null> {
    const { rows } = tenantId
      ? await this.pool.query(`SELECT * FROM dynamic_apis WHERE slug = $1 AND (tenant_id = $2 OR tenant_id = 'global')`, [slug, tenantId])
      : await this.pool.query('SELECT * FROM dynamic_apis WHERE slug = $1', [slug]);
    return rows[0] || null;
  }

  async upsertDynamicApi(input: Omit<DynamicApiRecord, 'id' | 'call_count' | 'created_at' | 'updated_at'>): Promise<DynamicApiRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO dynamic_apis (id, tenant_id, slug, name, description, method, input_schema, output_schema, handler_code, test_code, test_report, openapi_spec, rate_limit_rpm, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, method = EXCLUDED.method, input_schema = EXCLUDED.input_schema, output_schema = EXCLUDED.output_schema, handler_code = EXCLUDED.handler_code, test_code = EXCLUDED.test_code, test_report = EXCLUDED.test_report, openapi_spec = EXCLUDED.openapi_spec, rate_limit_rpm = EXCLUDED.rate_limit_rpm, enabled = EXCLUDED.enabled, updated_at = NOW()
       WHERE dynamic_apis.tenant_id = EXCLUDED.tenant_id
       RETURNING *`,
      [uuidv4(), input.tenant_id, input.slug, input.name, input.description, input.method, JSON.stringify(input.input_schema), JSON.stringify(input.output_schema), input.handler_code, input.test_code, JSON.stringify(input.test_report), JSON.stringify(input.openapi_spec), input.rate_limit_rpm, input.enabled]
    );
    if (!rows[0]) throw new Error('This endpoint slug is already reserved by another workspace.');
    return rows[0];
  }

  async incrementDynamicApiCalls(slug: string, tenantId: string): Promise<void> {
    await this.pool.query('UPDATE dynamic_apis SET call_count = call_count + 1 WHERE slug = $1 AND tenant_id = $2', [slug, tenantId]);
  }

  async toggleDynamicApi(slug: string, enabled: boolean, tenantId?: string): Promise<DynamicApiRecord | null> {
    if (tenantId) {
      const { rows } = await this.pool.query('UPDATE dynamic_apis SET enabled = $1, updated_at = NOW() WHERE slug = $2 AND tenant_id = $3 RETURNING *', [enabled, slug, tenantId]);
      return rows[0] || null;
    }
    const { rows } = await this.pool.query('UPDATE dynamic_apis SET enabled = $1, updated_at = NOW() WHERE slug = $2 RETURNING *', [enabled, slug]);
    return rows[0] || null;
  }

  // --- Background Jobs & Scheduled Jobs ---
  async enqueueJob(input: Pick<BackgroundJobRecord, 'queue_name' | 'job_type' | 'payload'>): Promise<BackgroundJobRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO background_jobs (id, queue_name, job_type, payload, status) VALUES ($1, $2, $3, $4, 'queued') RETURNING *`,
      [uuidv4(), input.queue_name, input.job_type, JSON.stringify(input.payload)]
    );
    return rows[0];
  }

  async updateJob(id: string, patch: Partial<Pick<BackgroundJobRecord, 'status' | 'result' | 'error' | 'attempts' | 'finished_at'>>): Promise<void> {
    const { rows } = await this.pool.query('SELECT * FROM background_jobs WHERE id = $1', [id]);
    if (!rows[0]) return;
    const cur = rows[0];
    await this.pool.query(`UPDATE background_jobs SET status = $1, result = $2, error = $3, attempts = $4, finished_at = $5 WHERE id = $6`, [
      patch.status ?? cur.status,
      patch.result !== undefined ? JSON.stringify(patch.result) : cur.result ? JSON.stringify(cur.result) : null,
      patch.error !== undefined ? patch.error : cur.error,
      patch.attempts ?? cur.attempts,
      patch.finished_at !== undefined ? patch.finished_at : cur.finished_at,
      id,
    ]);
  }

  async listJobs(limit = 30): Promise<BackgroundJobRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  async listScheduledJobs(): Promise<ScheduledJobRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM scheduled_jobs ORDER BY id ASC');
    return rows;
  }

  async upsertScheduledJob(input: ScheduledJobRecord): Promise<ScheduledJobRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO scheduled_jobs (id, name, job_kind, priority, interval_ms, enabled, last_run_at, next_run_at, last_status, last_error, run_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, job_kind = EXCLUDED.job_kind, priority = EXCLUDED.priority, interval_ms = EXCLUDED.interval_ms, enabled = EXCLUDED.enabled
       RETURNING *`,
      [input.id, input.name, input.job_kind, input.priority, input.interval_ms, input.enabled, input.last_run_at, input.next_run_at, input.last_status, input.last_error, input.run_count]
    );
    return rows[0];
  }

  async updateScheduledJob(id: string, patch: Parameters<NeoDatabase['updateScheduledJob']>[1]): Promise<ScheduledJobRecord | null> {
    const existingRes = await this.pool.query('SELECT * FROM scheduled_jobs WHERE id = $1', [id]);
    if (!existingRes.rows[0]) return null;
    const merged = { ...existingRes.rows[0], ...patch };
    const { rows } = await this.pool.query(
      `UPDATE scheduled_jobs SET enabled = $1, interval_ms = $2, last_run_at = $3, next_run_at = $4, last_status = $5, last_error = $6, run_count = $7 WHERE id = $8 RETURNING *`,
      [merged.enabled, merged.interval_ms, merged.last_run_at, merged.next_run_at, merged.last_status, merged.last_error, merged.run_count, id]
    );
    return rows[0] || null;
  }

  // --- Telemetry & Audit ---
  async recordTelemetry(input: Omit<LlmTelemetryRecord, 'id' | 'created_at'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_telemetry (id, tenant_id, provider, model, task_type, prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms, success, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv4(), input.tenant_id, input.provider, input.model, input.task_type, input.prompt_tokens, input.completion_tokens, input.estimated_cost_usd, input.latency_ms, input.success, input.error_message]
    );
  }

  async listTelemetry(limit = 50, tenantId?: string): Promise<LlmTelemetryRecord[]> {
    const { rows } = tenantId
      ? await this.pool.query('SELECT * FROM llm_telemetry WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2', [tenantId, limit])
      : await this.pool.query('SELECT * FROM llm_telemetry ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  async getTelemetrySummary(tenantId?: string) {
    const rows = await this.listTelemetry(500, tenantId);
    const totalCalls = rows.length;
    const successes = rows.filter((r) => r.success).length;
    const totalTokens = rows.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0);
    const totalCostUsd = Number(rows.reduce((s, r) => s + Number(r.estimated_cost_usd), 0).toFixed(5));
    const avgLatencyMs = totalCalls ? Math.round(rows.reduce((s, r) => s + r.latency_ms, 0) / totalCalls) : 0;

    const map = new Map<string, { provider: string; model: string; calls: number; tokens: number; costUsd: number; latencySum: number }>();
    for (const r of rows) {
      const k = `${r.provider}:${r.model}`;
      const cur = map.get(k) || { provider: r.provider, model: r.model, calls: 0, tokens: 0, costUsd: 0, latencySum: 0 };
      cur.calls += 1;
      cur.tokens += r.prompt_tokens + r.completion_tokens;
      cur.costUsd += Number(r.estimated_cost_usd);
      cur.latencySum += r.latency_ms;
      map.set(k, cur);
    }

    return {
      totalCalls,
      successRate: totalCalls ? Number(((successes / totalCalls) * 100).toFixed(1)) : 100,
      totalTokens,
      totalCostUsd,
      avgLatencyMs,
      byProvider: Array.from(map.values()).map((v) => ({
        provider: v.provider,
        model: v.model,
        calls: v.calls,
        tokens: v.tokens,
        costUsd: Number(v.costUsd.toFixed(5)),
        avgLatencyMs: Math.round(v.latencySum / v.calls),
      })),
    };
  }

  async recordAuditLog(input: Omit<AuditLogRecord, 'id' | 'created_at'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (id, tenant_id, actor, action, resource, status_code, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv4(), input.tenant_id, input.actor, input.action, input.resource, input.status_code, JSON.stringify(input.metadata)]
    );
  }

  async listAuditLogs(limit = 50, tenantId?: string): Promise<AuditLogRecord[]> {
    const { rows } = tenantId
      ? await this.pool.query('SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2', [tenantId, limit])
      : await this.pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  async getAdminConfig(key: string): Promise<string | null> {
    const { rows } = await this.pool.query('SELECT value FROM admin_config WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  async setAdminConfig(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO admin_config (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  }

  async setAdminConfigIfAbsent(key: string, value: string): Promise<boolean> {
    const result = await this.pool.query(
      'INSERT INTO admin_config (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO NOTHING RETURNING key',
      [key, value]
    );
    return (result.rowCount ?? 0) === 1;
  }
}
