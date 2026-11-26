import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import { computeBm25Scores, computeTemporalDecay, cosineSimilarity, hybridRerank } from './vector.ts';

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class SqliteNeoDatabase implements NeoDatabase {
  public readonly mode = 'sqlite' as const;
  private db: DatabaseSync;

  constructor(dbPath = path.resolve(process.cwd(), 'data', 'neo.db')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private ensureMemoryColumns(): void {
    const cols = this.db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    const additions: Array<[string, string]> = [
      ['importance_score', 'REAL NOT NULL DEFAULT 0.6'],
      ['confidence_score', 'REAL NOT NULL DEFAULT 0.8'],
      ['epistemic_status', `TEXT NOT NULL DEFAULT 'observation'`],
      ['retention_policy', `TEXT NOT NULL DEFAULT 'long_term'`],
      ['valid_from', 'TEXT'],
      ['valid_to', 'TEXT'],
      ['superseded_by', 'TEXT'],
      ['version', 'INTEGER NOT NULL DEFAULT 1'],
      ['deleted_at', 'TEXT'],
      ['last_accessed_at', 'TEXT'],
      ['embedding_model', `TEXT NOT NULL DEFAULT 'neo-embed-local-v2'`],
      ['embedding_dim', 'INTEGER NOT NULL DEFAULT 768'],
    ];
    for (const [col, def] of additions) {
      if (!existing.has(col)) {
        this.db.exec(`ALTER TABLE memories ADD COLUMN ${col} ${def};`);
      }
    }

    const entityCols = this.db.prepare(`PRAGMA table_info(entities)`).all() as Array<{ name: string }>;
    const existingEntity = new Set(entityCols.map((c) => c.name));
    if (!existingEntity.has('embedding_model')) {
      this.db.exec(`ALTER TABLE entities ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'neo-embed-local-v2';`);
    }
    if (!existingEntity.has('embedding_dim')) {
      this.db.exec(`ALTER TABLE entities ADD COLUMN embedding_dim INTEGER NOT NULL DEFAULT 768;`);
    }
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        workspace_language TEXT NOT NULL DEFAULT 'en',
        webhook_url TEXT,
        webhook_secret TEXT,
        pii_redaction INTEGER NOT NULL DEFAULT 0,
        rate_limit_rpm INTEGER NOT NULL DEFAULT 120,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        user_id TEXT,
        title TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'en',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        memory_type TEXT NOT NULL,
        topic TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        structured_facts TEXT NOT NULL,
        source_url TEXT,
        reliability_score REAL NOT NULL DEFAULT 0.8,
        freshness_score REAL NOT NULL DEFAULT 1.0,
        importance_score REAL NOT NULL DEFAULT 0.6,
        confidence_score REAL NOT NULL DEFAULT 0.8,
        epistemic_status TEXT NOT NULL DEFAULT 'observation',
        retention_policy TEXT NOT NULL DEFAULT 'long_term',
        valid_from TEXT,
        valid_to TEXT,
        superseded_by TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        deleted_at TEXT,
        last_accessed_at TEXT,
        embedding TEXT NOT NULL,
        embedding_model TEXT NOT NULL DEFAULT 'neo-embed-local-v2',
        embedding_dim INTEGER NOT NULL DEFAULT 768,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        domain TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        format TEXT NOT NULL DEFAULT 'markdown',
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS topic_streams (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        category TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        last_crawled_at TEXT,
        items_ingested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        source_type TEXT NOT NULL,
        author TEXT,
        published_at TEXT,
        last_verified_at TEXT NOT NULL,
        reliability_score REAL NOT NULL DEFAULT 0.7,
        quality_breakdown TEXT NOT NULL DEFAULT '{}',
        content_hash TEXT NOT NULL,
        injection_flagged INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS research_reports (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        query TEXT NOT NULL,
        sub_questions TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        findings TEXT NOT NULL DEFAULT '[]',
        contradictions TEXT NOT NULL DEFAULT '[]',
        citations TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        name TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        attributes TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0.8,
        embedding TEXT NOT NULL DEFAULT '[]',
        embedding_model TEXT NOT NULL DEFAULT 'neo-embed-local-v2',
        embedding_dim INTEGER NOT NULL DEFAULT 768,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        properties TEXT NOT NULL DEFAULT '{}',
        source_url TEXT,
        confidence REAL NOT NULL DEFAULT 0.8,
        valid_from TEXT,
        valid_to TEXT,
        contradicts_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        goal TEXT NOT NULL,
        autonomy TEXT NOT NULL DEFAULT 'balanced',
        priority TEXT NOT NULL DEFAULT 'user_task',
        status TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT '[]',
        checkpoint TEXT NOT NULL DEFAULT '{}',
        result TEXT,
        verification TEXT,
        error TEXT,
        budgets TEXT NOT NULL DEFAULT '{}',
        usage TEXT NOT NULL DEFAULT '{}',
        loop_signature_counts TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_steps (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        step_index INTEGER NOT NULL,
        title TEXT NOT NULL,
        action_type TEXT NOT NULL,
        tool_id TEXT,
        depends_on TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '{}',
        output TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0.0',
        description TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        output_schema TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        required_scopes TEXT NOT NULL DEFAULT '["read"]',
        timeout_ms INTEGER NOT NULL DEFAULT 5000,
        execution_env TEXT NOT NULL DEFAULT 'host-guarded',
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        task_id TEXT,
        tool_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '{}',
        output TEXT,
        ok INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        runtime TEXT NOT NULL,
        architecture TEXT NOT NULL,
        source_repo TEXT NOT NULL,
        license TEXT NOT NULL,
        weight_location TEXT,
        checksum_sha256 TEXT,
        download_status TEXT NOT NULL DEFAULT 'available',
        quantization TEXT NOT NULL DEFAULT 'none',
        context_length INTEGER NOT NULL DEFAULT 8192,
        vram_gb REAL NOT NULL DEFAULT 0,
        ram_gb REAL NOT NULL DEFAULT 0.5,
        modalities TEXT NOT NULL DEFAULT '["text","code"]',
        roles TEXT NOT NULL DEFAULT '["primary"]',
        capabilities TEXT NOT NULL DEFAULT '{}',
        benchmark_results TEXT NOT NULL DEFAULT '{}',
        deployment_status TEXT NOT NULL DEFAULT 'standby',
        health_status TEXT NOT NULL DEFAULT 'unknown',
        performance_metrics TEXT NOT NULL DEFAULT '{}',
        last_validated_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_evaluations (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        suite_version TEXT NOT NULL,
        overall_score REAL NOT NULL,
        category_scores TEXT NOT NULL,
        avg_latency_ms REAL NOT NULL,
        tokens_per_sec REAL NOT NULL,
        passed_cases INTEGER NOT NULL,
        total_cases INTEGER NOT NULL,
        details TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS self_upgrades (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        diagnosis TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        target_files TEXT NOT NULL,
        unified_diff TEXT NOT NULL,
        test_results TEXT NOT NULL,
        benchmark_before TEXT NOT NULL,
        benchmark_after TEXT NOT NULL,
        rollback_plan TEXT NOT NULL,
        status TEXT NOT NULL,
        auto_eligible INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evolution_experiments (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        title TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        config_before TEXT NOT NULL DEFAULT '{}',
        config_after TEXT NOT NULL DEFAULT '{}',
        metrics_before TEXT NOT NULL DEFAULT '{}',
        metrics_after TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS training_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        base_model_id TEXT NOT NULL,
        method TEXT NOT NULL,
        dataset_size INTEGER NOT NULL DEFAULT 0,
        dataset_path TEXT,
        adapter_version TEXT,
        privacy_filtered INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        metrics TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS dynamic_apis (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'POST',
        input_schema TEXT NOT NULL,
        output_schema TEXT NOT NULL,
        handler_code TEXT NOT NULL,
        test_code TEXT NOT NULL,
        test_report TEXT NOT NULL,
        openapi_spec TEXT NOT NULL,
        rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
        call_count INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS background_jobs (
        id TEXT PRIMARY KEY,
        queue_name TEXT NOT NULL,
        job_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        job_kind TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'internal_improvement',
        interval_ms INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        next_run_at TEXT,
        last_status TEXT,
        last_error TEXT,
        run_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS llm_telemetry (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        task_type TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        status_code INTEGER NOT NULL DEFAULT 200,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS objectives (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'global',
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        priority_score REAL NOT NULL DEFAULT 0.5,
        value_score REAL NOT NULL DEFAULT 0.6,
        urgency_score REAL NOT NULL DEFAULT 0.5,
        uncertainty_score REAL NOT NULL DEFAULT 0.4,
        progress_pct REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        success_criteria TEXT NOT NULL DEFAULT '',
        compute_budget_ms INTEGER NOT NULL DEFAULT 30000,
        compute_used_ms INTEGER NOT NULL DEFAULT 0,
        linked_task_ids TEXT NOT NULL DEFAULT '[]',
        linked_research_ids TEXT NOT NULL DEFAULT '[]',
        knowledge_gaps TEXT NOT NULL DEFAULT '[]',
        last_evaluated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureMemoryColumns();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run('001_init', now);
    this.db.prepare(`INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run('002_neo_cognitive_core', now);
    this.db.prepare(`INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run('003_neo_upgrade', now);
    await seedInitialData(this);
  }

  // --- Tenants & API Keys ---
  async listTenants(): Promise<TenantRecord[]> {
    const rows = this.db.prepare('SELECT * FROM tenants ORDER BY created_at ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as TenantRecord), pii_redaction: Boolean(r.pii_redaction) }));
  }

  async getTenantById(id: string): Promise<TenantRecord | null> {
    const r = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as TenantRecord), pii_redaction: Boolean(r.pii_redaction) } : null;
  }

  async createTenant(input: Omit<TenantRecord, 'id' | 'created_at'>): Promise<TenantRecord> {
    const rec: TenantRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO tenants (id, name, slug, workspace_language, webhook_url, webhook_secret, pii_redaction, rate_limit_rpm, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(rec.id, rec.name, rec.slug, rec.workspace_language, rec.webhook_url, rec.webhook_secret, rec.pii_redaction ? 1 : 0, rec.rate_limit_rpm, rec.created_at);
    return rec;
  }

  async updateTenant(
    id: string,
    patch: Partial<Pick<TenantRecord, 'workspace_language' | 'webhook_url' | 'webhook_secret' | 'pii_redaction' | 'rate_limit_rpm'>>
  ): Promise<TenantRecord | null> {
    const existing = await this.getTenantById(id);
    if (!existing) return null;
    const merged: TenantRecord = { ...existing, ...patch };
    this.db
      .prepare(`UPDATE tenants SET workspace_language = ?, webhook_url = ?, webhook_secret = ?, pii_redaction = ?, rate_limit_rpm = ? WHERE id = ?`)
      .run(merged.workspace_language, merged.webhook_url, merged.webhook_secret, merged.pii_redaction ? 1 : 0, merged.rate_limit_rpm, id);
    return merged;
  }

  async listApiKeys(tenantId?: string): Promise<ApiKeyRecord[]> {
    const rows = tenantId
      ? (this.db.prepare('SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as Record<string, unknown>[]);
    return rows.map((r) => ({ ...(r as unknown as ApiKeyRecord), scopes: parseJson<string[]>(r.scopes, []) }));
  }

  async getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as ApiKeyRecord), scopes: parseJson<string[]>(r.scopes, []) } : null;
  }

  async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as ApiKeyRecord), scopes: parseJson<string[]>(r.scopes, []) } : null;
  }

  async createApiKey(input: Omit<ApiKeyRecord, 'id' | 'last_used_at' | 'revoked_at' | 'created_at'>): Promise<ApiKeyRecord> {
    const rec: ApiKeyRecord = { ...input, id: uuidv4(), last_used_at: null, revoked_at: null, created_at: new Date().toISOString() };
    this.db
      .prepare(`INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes, last_used_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
      .run(rec.id, rec.tenant_id, rec.name, rec.key_prefix, rec.key_hash, JSON.stringify(rec.scopes), rec.created_at);
    return rec;
  }

  async touchApiKey(id: string): Promise<void> {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  async revokeApiKey(id: string): Promise<boolean> {
    const res = this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id);
    return res.changes > 0;
  }

  // --- Conversations & Messages ---
  async listConversations(tenantId: string, limit = 30): Promise<ConversationRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM conversations WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(tenantId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as ConversationRecord), metadata: parseJson(r.metadata, {}) }));
  }

  async getConversationById(id: string, tenantId: string): Promise<ConversationRecord | null> {
    const r = this.db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as ConversationRecord), metadata: parseJson(r.metadata, {}) } : null;
  }

  async createConversation(input: Omit<ConversationRecord, 'id' | 'created_at' | 'updated_at'>): Promise<ConversationRecord> {
    const now = new Date().toISOString();
    const rec: ConversationRecord = { ...input, id: uuidv4(), created_at: now, updated_at: now };
    this.db
      .prepare(`INSERT INTO conversations (id, tenant_id, user_id, title, language, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rec.id, rec.tenant_id, rec.user_id, rec.title, rec.language, JSON.stringify(rec.metadata), rec.created_at, rec.updated_at);
    return rec;
  }

  async listMessages(conversationId: string, tenantId: string, limit = 100): Promise<MessageRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND tenant_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(conversationId, tenantId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as MessageRecord), metadata: parseJson(r.metadata, {}) }));
  }

  async addMessage(input: Omit<MessageRecord, 'id' | 'created_at'>): Promise<MessageRecord> {
    const now = new Date().toISOString();
    const rec: MessageRecord = { ...input, id: uuidv4(), created_at: now };
    this.db
      .prepare(`INSERT INTO messages (id, conversation_id, tenant_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(rec.id, rec.conversation_id, rec.tenant_id, rec.role, rec.content, JSON.stringify(rec.metadata), rec.created_at);
    this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ? AND tenant_id = ?`).run(now, rec.conversation_id, rec.tenant_id);
    return rec;
  }

  // --- Memories ---
  private mapMemoryRow(r: Record<string, unknown>): MemoryRecord {
    const embedding = parseJson<number[]>(r.embedding, []);
    return {
      ...(r as unknown as MemoryRecord),
      structured_facts: parseJson<Record<string, unknown>>(r.structured_facts, {}),
      embedding,
      embedding_model: typeof r.embedding_model === 'string' && r.embedding_model ? r.embedding_model : 'neo-embed-local-v2',
      embedding_dim: Number(r.embedding_dim || embedding.length || 768),
      epistemic_status: (r.epistemic_status as EpistemicStatus) || 'observation',
      retention_policy: (r.retention_policy as RetentionPolicy) || 'long_term',
      importance_score: Number(r.importance_score ?? 0.6),
      confidence_score: Number(r.confidence_score ?? 0.8),
      version: Number(r.version ?? 1),
    };
  }

  async insertMemory(input: Parameters<NeoDatabase['insertMemory']>[0]): Promise<MemoryRecord> {
    const now = new Date().toISOString();
    const embDim = input.embedding_dim ?? input.embedding.length;
    const embModel = input.embedding_model || 'neo-embed-local-v2';
    const rec: MemoryRecord = {
      id: uuidv4(),
      tenant_id: input.tenant_id,
      memory_type: input.memory_type,
      topic: input.topic,
      title: input.title,
      content: input.content,
      structured_facts: input.structured_facts || {},
      source_url: input.source_url ?? null,
      reliability_score: input.reliability_score ?? 0.8,
      freshness_score: input.freshness_score ?? 1.0,
      importance_score: input.importance_score ?? 0.6,
      confidence_score: input.confidence_score ?? 0.8,
      epistemic_status: input.epistemic_status ?? 'observation',
      retention_policy: input.retention_policy ?? 'long_term',
      valid_from: input.valid_from ?? now,
      valid_to: input.valid_to ?? null,
      superseded_by: input.superseded_by ?? null,
      version: input.version ?? 1,
      deleted_at: input.deleted_at ?? null,
      last_accessed_at: input.last_accessed_at ?? null,
      embedding: input.embedding,
      embedding_model: embModel,
      embedding_dim: embDim,
      created_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO memories (id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, importance_score, confidence_score, epistemic_status, retention_policy, valid_from, valid_to, superseded_by, version, deleted_at, last_accessed_at, embedding, embedding_model, embedding_dim, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.tenant_id,
        rec.memory_type,
        rec.topic,
        rec.title,
        rec.content,
        JSON.stringify(rec.structured_facts),
        rec.source_url,
        rec.reliability_score,
        rec.freshness_score,
        rec.importance_score,
        rec.confidence_score,
        rec.epistemic_status,
        rec.retention_policy,
        rec.valid_from,
        rec.valid_to,
        rec.superseded_by,
        rec.version,
        rec.deleted_at,
        rec.last_accessed_at,
        JSON.stringify(rec.embedding),
        rec.embedding_model,
        rec.embedding_dim,
        rec.created_at
      );
    return rec;
  }

  async getMemoryById(id: string, tenantId: string, includeGlobal = false): Promise<MemoryRecord | null> {
    const r = includeGlobal
      ? (this.db.prepare('SELECT * FROM memories WHERE id = ? AND (tenant_id = ? OR tenant_id = ?) AND deleted_at IS NULL').get(id, tenantId, 'global') as Record<string, unknown> | undefined)
      : (this.db.prepare('SELECT * FROM memories WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(id, tenantId) as Record<string, unknown> | undefined);
    return r ? this.mapMemoryRow(r) : null;
  }

  async updateMemory(
    id: string,
    tenantId: string,
    patch: Parameters<NeoDatabase['updateMemory']>[2]
  ): Promise<MemoryRecord | null> {
    const existing = await this.getMemoryById(id, tenantId, false);
    if (!existing) return null;
    const merged: MemoryRecord = {
      ...existing,
      ...patch,
      embedding_dim: patch.embedding_dim ?? (patch.embedding ? patch.embedding.length : existing.embedding_dim),
      version: existing.version + 1,
    };
    this.db
      .prepare(
        `UPDATE memories SET title = ?, content = ?, topic = ?, structured_facts = ?, reliability_score = ?, freshness_score = ?, importance_score = ?, confidence_score = ?, epistemic_status = ?, retention_policy = ?, valid_from = ?, valid_to = ?, superseded_by = ?, version = ?, embedding = ?, embedding_model = ?, embedding_dim = ? WHERE id = ? AND tenant_id = ?`
      )
      .run(
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
        JSON.stringify(merged.embedding),
        merged.embedding_model,
        merged.embedding_dim,
        id,
        tenantId
      );
    return merged;
  }

  async deleteMemory(id: string, tenantId: string, hardDelete = false): Promise<boolean> {
    if (hardDelete) {
      const res = this.db.prepare('DELETE FROM memories WHERE id = ? AND tenant_id = ?').run(id, tenantId);
      return res.changes > 0;
    }
    const res = this.db.prepare('UPDATE memories SET deleted_at = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').run(new Date().toISOString(), id, tenantId);
    return res.changes > 0;
  }

  async listMemories(opts?: MemoryQueryOptions): Promise<MemoryRecord[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (!opts?.includeDeleted) {
      clauses.push('deleted_at IS NULL');
    }
    if (opts?.memoryType) {
      clauses.push('memory_type = ?');
      params.push(opts.memoryType);
    }
    if (opts?.tenantId) {
      if (opts.includeGlobal) {
        clauses.push('(tenant_id = ? OR tenant_id = ?)');
        params.push(opts.tenantId, 'global');
      } else {
        clauses.push('tenant_id = ?');
        params.push(opts.tenantId);
      }
    }
    if (opts?.validAt) {
      clauses.push('(valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)');
      params.push(opts.validAt, opts.validAt);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];
    return rows.map((r) => this.mapMemoryRow(r));
  }

  async searchMemories(queryEmbedding: number[], opts?: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const candidates = await this.listMemories({
      memoryType: opts?.memoryType,
      tenantId: opts?.tenantId,
      includeGlobal: opts?.includeGlobal ?? false,
      validAt: opts?.validAt,
      limit: 500,
    });
    if (candidates.length === 0) return [];
    const minScore = opts?.minScore ?? 0.04;
    const bm25 = opts?.queryText
      ? computeBm25Scores(
          opts.queryText,
          candidates.map((c) => `${c.topic} ${c.title} ${c.content}`)
        )
      : candidates.map(() => 0);

    const queryModel = opts?.queryEmbeddingModel;
    const ranked = hybridRerank(
      candidates.map((m, idx) => {
        const spaceMatches =
          queryEmbedding.length > 0 &&
          m.embedding.length === queryEmbedding.length &&
          (!queryModel || m.embedding_model === queryModel);
        return {
          item: m,
          vectorScore: spaceMatches ? cosineSimilarity(queryEmbedding, m.embedding) : 0,
          lexicalScore: bm25[idx] || 0,
          reliability: m.reliability_score,
          importance: m.importance_score,
          freshness: m.freshness_score * computeTemporalDecay(m.created_at),
        };
      })
    );

    const filtered = ranked.filter((m) => m.similarity >= minScore || m.hybridScore >= minScore + 0.08).slice(0, opts?.limit ?? 8);
    const now = new Date().toISOString();
    for (const hit of filtered) {
      this.db.prepare('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(now, hit.id);
    }
    return filtered;
  }

  async countMemories(tenantId?: string): Promise<MemoryCounts> {
    const where = tenantId ? 'WHERE deleted_at IS NULL AND (tenant_id = ? OR tenant_id = ?)' : 'WHERE deleted_at IS NULL';
    const rows = (
      tenantId
        ? this.db.prepare(`SELECT memory_type, COUNT(*) as cnt FROM memories ${where} GROUP BY memory_type`).all(tenantId, 'global')
        : this.db.prepare(`SELECT memory_type, COUNT(*) as cnt FROM memories ${where} GROUP BY memory_type`).all()
    ) as Array<{ memory_type: string; cnt: number }>;
    const counts: MemoryCounts = {
      total: 0,
      working: 0,
      episodic: 0,
      semantic: 0,
      procedural: 0,
      personal: 0,
      organizational: 0,
      temporal: 0,
    };
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
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as SkillRecord), metadata: parseJson(r.metadata, {}) }));
  }

  async getSkillByIdOrSlug(idOrSlug: string): Promise<SkillRecord | null> {
    const r = this.db.prepare('SELECT * FROM skills WHERE id = ? OR slug = ?').get(idOrSlug, idOrSlug) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as SkillRecord), metadata: parseJson(r.metadata, {}) } : null;
  }

  async upsertSkill(input: Omit<SkillRecord, 'id' | 'updated_at'>): Promise<SkillRecord> {
    const existing = this.db.prepare('SELECT id, version FROM skills WHERE slug = ?').get(input.slug) as { id: string; version: number } | undefined;
    const now = new Date().toISOString();
    if (existing) {
      const nextVersion = Math.max(existing.version + 1, input.version);
      this.db
        .prepare(`UPDATE skills SET title = ?, domain = ?, version = ?, format = ?, content = ?, metadata = ?, updated_at = ? WHERE id = ?`)
        .run(input.title, input.domain, nextVersion, input.format, input.content, JSON.stringify(input.metadata), now, existing.id);
      return { ...input, id: existing.id, version: nextVersion, updated_at: now };
    }
    const rec: SkillRecord = { ...input, id: uuidv4(), updated_at: now };
    this.db
      .prepare(`INSERT INTO skills (id, slug, title, domain, version, format, content, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rec.id, rec.slug, rec.title, rec.domain, rec.version, rec.format, rec.content, JSON.stringify(rec.metadata), rec.updated_at);
    return rec;
  }

  async updateSkillById(id: string, patch: Partial<Pick<SkillRecord, 'title' | 'domain' | 'content' | 'metadata'>>): Promise<SkillRecord | null> {
    const existing = await this.getSkillByIdOrSlug(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const merged: SkillRecord = {
      ...existing,
      ...patch,
      version: existing.version + 1,
      updated_at: now,
    };
    this.db
      .prepare(`UPDATE skills SET title = ?, domain = ?, version = ?, content = ?, metadata = ?, updated_at = ? WHERE id = ?`)
      .run(merged.title, merged.domain, merged.version, merged.content, JSON.stringify(merged.metadata), now, existing.id);
    return merged;
  }

  // --- Topic Streams, Sources & Research Reports ---
  async listTopicStreams(): Promise<TopicStreamRecord[]> {
    const rows = this.db.prepare('SELECT * FROM topic_streams ORDER BY created_at ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as TopicStreamRecord), enabled: Boolean(r.enabled) }));
  }

  async createTopicStream(input: Pick<TopicStreamRecord, 'topic' | 'category' | 'interval_minutes'>): Promise<TopicStreamRecord> {
    const rec: TopicStreamRecord = {
      id: uuidv4(),
      topic: input.topic,
      category: input.category,
      enabled: true,
      interval_minutes: input.interval_minutes,
      last_crawled_at: null,
      items_ingested: 0,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(`INSERT INTO topic_streams (id, topic, category, enabled, interval_minutes, last_crawled_at, items_ingested, created_at) VALUES (?, ?, ?, 1, ?, NULL, 0, ?)`)
      .run(rec.id, rec.topic, rec.category, rec.interval_minutes, rec.created_at);
    return rec;
  }

  async toggleTopicStream(id: string, enabled: boolean): Promise<TopicStreamRecord | null> {
    this.db.prepare('UPDATE topic_streams SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    const r = this.db.prepare('SELECT * FROM topic_streams WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as TopicStreamRecord), enabled: Boolean(r.enabled) } : null;
  }

  async markTopicCrawled(id: string, addedItems: number): Promise<void> {
    this.db.prepare('UPDATE topic_streams SET last_crawled_at = ?, items_ingested = items_ingested + ? WHERE id = ?').run(new Date().toISOString(), addedItems, id);
  }

  async upsertKnowledgeSource(input: Omit<KnowledgeSourceRecord, 'id' | 'created_at'>): Promise<KnowledgeSourceRecord> {
    const existing = this.db
      .prepare('SELECT id, created_at FROM knowledge_sources WHERE url = ? AND tenant_id = ?')
      .get(input.url, input.tenant_id) as { id: string; created_at: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE knowledge_sources SET title = ?, source_type = ?, author = ?, published_at = ?, last_verified_at = ?, reliability_score = ?, quality_breakdown = ?, content_hash = ?, injection_flagged = ? WHERE id = ?`
        )
        .run(
          input.title,
          input.source_type,
          input.author,
          input.published_at,
          input.last_verified_at,
          input.reliability_score,
          JSON.stringify(input.quality_breakdown),
          input.content_hash,
          input.injection_flagged ? 1 : 0,
          existing.id
        );
      return { ...input, id: existing.id, created_at: existing.created_at };
    }
    const rec: KnowledgeSourceRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO knowledge_sources (id, tenant_id, url, title, source_type, author, published_at, last_verified_at, reliability_score, quality_breakdown, content_hash, injection_flagged, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.tenant_id,
        rec.url,
        rec.title,
        rec.source_type,
        rec.author,
        rec.published_at,
        rec.last_verified_at,
        rec.reliability_score,
        JSON.stringify(rec.quality_breakdown),
        rec.content_hash,
        rec.injection_flagged ? 1 : 0,
        rec.created_at
      );
    return rec;
  }

  async listKnowledgeSources(tenantId?: string, limit = 50): Promise<KnowledgeSourceRecord[]> {
    const rows = tenantId
      ? (this.db.prepare('SELECT * FROM knowledge_sources WHERE tenant_id = ? ORDER BY last_verified_at DESC LIMIT ?').all(tenantId, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM knowledge_sources ORDER BY last_verified_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]);
    return rows.map((r) => ({
      ...(r as unknown as KnowledgeSourceRecord),
      quality_breakdown: parseJson(r.quality_breakdown, {
        primarySource: 0,
        authorCredibility: 0,
        evidenceDensity: 0,
        recency: 0,
        methodology: 0,
        corroboration: 0,
        relevance: 0,
      }),
      injection_flagged: Boolean(r.injection_flagged),
    }));
  }

  async createResearchReport(input: Omit<ResearchReportRecord, 'id' | 'created_at'>): Promise<ResearchReportRecord> {
    const rec: ResearchReportRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO research_reports (id, tenant_id, query, sub_questions, status, summary, findings, contradictions, citations, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.tenant_id,
        rec.query,
        JSON.stringify(rec.sub_questions),
        rec.status,
        rec.summary,
        JSON.stringify(rec.findings),
        JSON.stringify(rec.contradictions),
        JSON.stringify(rec.citations),
        rec.confidence,
        rec.created_at
      );
    return rec;
  }

  private mapResearchRow(r: Record<string, unknown>): ResearchReportRecord {
    return {
      ...(r as unknown as ResearchReportRecord),
      sub_questions: parseJson(r.sub_questions, []),
      findings: parseJson(r.findings, []),
      contradictions: parseJson(r.contradictions, []),
      citations: parseJson(r.citations, []),
    };
  }

  async getResearchReportById(id: string, tenantId: string): Promise<ResearchReportRecord | null> {
    const r = this.db.prepare('SELECT * FROM research_reports WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
    return r ? this.mapResearchRow(r) : null;
  }

  async listResearchReports(tenantId: string, limit = 30): Promise<ResearchReportRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM research_reports WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(tenantId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapResearchRow(r));
  }

  // --- Knowledge Graph ---
  async upsertEntity(input: Omit<GraphEntityRecord, 'id' | 'created_at' | 'updated_at'>): Promise<GraphEntityRecord> {
    const now = new Date().toISOString();
    const embModel = input.embedding_model || 'neo-embed-local-v2';
    const embDim = input.embedding_dim ?? input.embedding.length;
    const existing = this.db
      .prepare('SELECT * FROM entities WHERE tenant_id = ? AND lower(name) = lower(?) AND entity_type = ?')
      .get(input.tenant_id, input.name, input.entity_type) as Record<string, unknown> | undefined;
    if (existing) {
      const mergedAliases = Array.from(new Set([...parseJson<string[]>(existing.aliases, []), ...input.aliases]));
      const mergedAttrs = { ...parseJson<Record<string, unknown>>(existing.attributes, {}), ...input.attributes };
      this.db
        .prepare('UPDATE entities SET aliases = ?, attributes = ?, confidence = ?, embedding = ?, embedding_model = ?, embedding_dim = ?, updated_at = ? WHERE id = ?')
        .run(
          JSON.stringify(mergedAliases),
          JSON.stringify(mergedAttrs),
          Math.max(Number(existing.confidence || 0), input.confidence),
          JSON.stringify(input.embedding),
          embModel,
          embDim,
          now,
          String(existing.id)
        );
      return {
        id: String(existing.id),
        tenant_id: input.tenant_id,
        name: String(existing.name),
        entity_type: input.entity_type,
        aliases: mergedAliases,
        attributes: mergedAttrs,
        confidence: Math.max(Number(existing.confidence || 0), input.confidence),
        embedding: input.embedding,
        embedding_model: embModel,
        embedding_dim: embDim,
        created_at: String(existing.created_at),
        updated_at: now,
      };
    }
    const rec: GraphEntityRecord = { ...input, embedding_model: embModel, embedding_dim: embDim, id: uuidv4(), created_at: now, updated_at: now };
    this.db
      .prepare(`INSERT INTO entities (id, tenant_id, name, entity_type, aliases, attributes, confidence, embedding, embedding_model, embedding_dim, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rec.id, rec.tenant_id, rec.name, rec.entity_type, JSON.stringify(rec.aliases), JSON.stringify(rec.attributes), rec.confidence, JSON.stringify(rec.embedding), embModel, embDim, rec.created_at, rec.updated_at);
    return rec;
  }

  async getEntityById(id: string, tenantId: string): Promise<GraphEntityRecord | null> {
    const r = this.db.prepare('SELECT * FROM entities WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      ...(r as unknown as GraphEntityRecord),
      aliases: parseJson<string[]>(r.aliases, []),
      attributes: parseJson<Record<string, unknown>>(r.attributes, {}),
      embedding: parseJson<number[]>(r.embedding, []),
    };
  }

  async listEntities(tenantId: string, opts?: { entityType?: string; query?: string; limit?: number }): Promise<GraphEntityRecord[]> {
    const clauses = ['tenant_id = ?'];
    const params: (string | number)[] = [tenantId];
    if (opts?.entityType) {
      clauses.push('entity_type = ?');
      params.push(opts.entityType);
    }
    if (opts?.query) {
      clauses.push('(lower(name) LIKE ? OR lower(aliases) LIKE ?)');
      const pat = `%${opts.query.toLowerCase()}%`;
      params.push(pat, pat);
    }
    params.push(opts?.limit ?? 50);
    const rows = this.db.prepare(`SELECT * FROM entities WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as GraphEntityRecord),
      aliases: parseJson<string[]>(r.aliases, []),
      attributes: parseJson<Record<string, unknown>>(r.attributes, {}),
      embedding: parseJson<number[]>(r.embedding, []),
    }));
  }

  async addRelationship(input: Omit<GraphRelationshipRecord, 'id' | 'created_at'>): Promise<GraphRelationshipRecord> {
    const rec: GraphRelationshipRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO relationships (id, tenant_id, source_entity_id, target_entity_id, relation_type, properties, source_url, confidence, valid_from, valid_to, contradicts_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.tenant_id,
        rec.source_entity_id,
        rec.target_entity_id,
        rec.relation_type,
        JSON.stringify(rec.properties),
        rec.source_url,
        rec.confidence,
        rec.valid_from,
        rec.valid_to,
        rec.contradicts_id,
        rec.created_at
      );
    return rec;
  }

  async listRelationships(tenantId: string, entityId?: string, limit = 100): Promise<GraphRelationshipRecord[]> {
    const rows = entityId
      ? (this.db
          .prepare('SELECT * FROM relationships WHERE tenant_id = ? AND (source_entity_id = ? OR target_entity_id = ?) ORDER BY created_at DESC LIMIT ?')
          .all(tenantId, entityId, entityId, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM relationships WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, limit) as Record<string, unknown>[]);
    return rows.map((r) => ({
      ...(r as unknown as GraphRelationshipRecord),
      properties: parseJson<Record<string, unknown>>(r.properties, {}),
    }));
  }

  // --- Tasks & Agent Runtime ---
  private mapTaskRow(r: Record<string, unknown>): TaskRecord {
    return {
      ...(r as unknown as TaskRecord),
      plan: parseJson(r.plan, []),
      checkpoint: parseJson(r.checkpoint, {}),
      result: r.result ? parseJson(r.result, null) : null,
      verification: r.verification ? parseJson(r.verification, null) : null,
      budgets: parseJson(r.budgets, { maxSteps: 10, maxToolCalls: 20, maxDurationMs: 60000 }),
      usage: parseJson(r.usage, { stepsExecuted: 0, toolCalls: 0, durationMs: 0, retries: 0 }),
      loop_signature_counts: parseJson(r.loop_signature_counts, {}),
    };
  }

  async createTask(input: Omit<TaskRecord, 'id' | 'created_at' | 'updated_at' | 'completed_at'>): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const rec: TaskRecord = { ...input, id: uuidv4(), created_at: now, updated_at: now, completed_at: null };
    this.db
      .prepare(
        `INSERT INTO tasks (id, tenant_id, goal, autonomy, priority, status, plan, checkpoint, result, verification, error, budgets, usage, loop_signature_counts, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        rec.id,
        rec.tenant_id,
        rec.goal,
        rec.autonomy,
        rec.priority,
        rec.status,
        JSON.stringify(rec.plan),
        JSON.stringify(rec.checkpoint),
        rec.result ? JSON.stringify(rec.result) : null,
        rec.verification ? JSON.stringify(rec.verification) : null,
        rec.error,
        JSON.stringify(rec.budgets),
        JSON.stringify(rec.usage),
        JSON.stringify(rec.loop_signature_counts),
        rec.created_at,
        rec.updated_at
      );
    return rec;
  }

  async getTaskById(id: string, tenantId: string): Promise<TaskRecord | null> {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
    return r ? this.mapTaskRow(r) : null;
  }

  async listTasks(tenantId?: string, opts?: { status?: TaskStatus; priority?: TaskPriority; limit?: number }): Promise<TaskRecord[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (tenantId) {
      clauses.push('tenant_id = ?');
      params.push(tenantId);
    }
    if (opts?.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    if (opts?.priority) {
      clauses.push('priority = ?');
      params.push(opts.priority);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(opts?.limit ?? 40);
    const rows = this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapTaskRow(r));
  }

  async updateTask(
    id: string,
    patch: Partial<
      Pick<TaskRecord, 'status' | 'plan' | 'checkpoint' | 'result' | 'verification' | 'error' | 'usage' | 'loop_signature_counts' | 'completed_at'>
    >
  ): Promise<TaskRecord | null> {
    const raw = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!raw) return null;
    const existing = this.mapTaskRow(raw);
    const merged: TaskRecord = { ...existing, ...patch, updated_at: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, plan = ?, checkpoint = ?, result = ?, verification = ?, error = ?, usage = ?, loop_signature_counts = ?, updated_at = ?, completed_at = ? WHERE id = ?`
      )
      .run(
        merged.status,
        JSON.stringify(merged.plan),
        JSON.stringify(merged.checkpoint),
        merged.result ? JSON.stringify(merged.result) : null,
        merged.verification ? JSON.stringify(merged.verification) : null,
        merged.error,
        JSON.stringify(merged.usage),
        JSON.stringify(merged.loop_signature_counts),
        merged.updated_at,
        merged.completed_at,
        id
      );
    return merged;
  }

  async updateTaskIfStatus(
    id: string,
    tenantId: string,
    expectedStatuses: TaskStatus[],
    patch: Parameters<NeoDatabase['updateTask']>[1]
  ): Promise<TaskRecord | null> {
    if (expectedStatuses.length === 0) return null;
    type SqlValue = null | string | number | bigint | Uint8Array;
    const columns: Record<string, { column: string; serialize: (value: unknown) => SqlValue }> = {
      status: { column: 'status', serialize: (v) => String(v) },
      plan: { column: 'plan', serialize: (v) => JSON.stringify(v) ?? null },
      checkpoint: { column: 'checkpoint', serialize: (v) => JSON.stringify(v) ?? null },
      result: { column: 'result', serialize: (v) => v === null ? null : JSON.stringify(v) ?? null },
      verification: { column: 'verification', serialize: (v) => v === null ? null : JSON.stringify(v) ?? null },
      error: { column: 'error', serialize: (v) => v === null ? null : String(v) },
      usage: { column: 'usage', serialize: (v) => JSON.stringify(v) ?? null },
      loop_signature_counts: { column: 'loop_signature_counts', serialize: (v) => JSON.stringify(v) ?? null },
      completed_at: { column: 'completed_at', serialize: (v) => v === null ? null : String(v) },
    };
    const assignments: string[] = [];
    const values: SqlValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const definition = columns[key];
      if (!definition || value === undefined) continue;
      assignments.push(`${definition.column} = ?`);
      values.push(definition.serialize(value));
    }
    if (assignments.length === 0) return this.getTaskById(id, tenantId);
    assignments.push('updated_at = ?');
    values.push(new Date().toISOString());
    const placeholders = expectedStatuses.map(() => '?').join(', ');
    const result = this.db.prepare(
      `UPDATE tasks SET ${assignments.join(', ')} WHERE id = ? AND tenant_id = ? AND status IN (${placeholders})`
    ).run(...values, id, tenantId, ...expectedStatuses);
    if (Number(result.changes) === 0) return null;
    const raw = this.db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
    return raw ? this.mapTaskRow(raw) : null;
  }

  async upsertTaskStep(input: Omit<TaskStepRecord, 'id'> & { id?: string }): Promise<TaskStepRecord> {
    const existing = input.id
      ? (this.db.prepare('SELECT id FROM task_steps WHERE id = ?').get(input.id) as { id: string } | undefined)
      : (this.db.prepare('SELECT id FROM task_steps WHERE task_id = ? AND step_index = ?').get(input.task_id, input.step_index) as { id: string } | undefined);

    const rec: TaskStepRecord = { ...input, id: existing?.id || input.id || uuidv4() };
    if (existing) {
      this.db
        .prepare(
          `UPDATE task_steps SET title = ?, action_type = ?, tool_id = ?, depends_on = ?, status = ?, input = ?, output = ?, error = ?, attempts = ?, started_at = ?, finished_at = ? WHERE id = ?`
        )
        .run(
          rec.title,
          rec.action_type,
          rec.tool_id,
          JSON.stringify(rec.depends_on),
          rec.status,
          JSON.stringify(rec.input),
          rec.output ? JSON.stringify(rec.output) : null,
          rec.error,
          rec.attempts,
          rec.started_at,
          rec.finished_at,
          rec.id
        );
      return rec;
    }

    this.db
      .prepare(
        `INSERT INTO task_steps (id, task_id, tenant_id, step_index, title, action_type, tool_id, depends_on, status, input, output, error, attempts, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.task_id,
        rec.tenant_id,
        rec.step_index,
        rec.title,
        rec.action_type,
        rec.tool_id,
        JSON.stringify(rec.depends_on),
        rec.status,
        JSON.stringify(rec.input),
        rec.output ? JSON.stringify(rec.output) : null,
        rec.error,
        rec.attempts,
        rec.started_at,
        rec.finished_at
      );
    return rec;
  }

  async listTaskSteps(taskId: string, tenantId: string): Promise<TaskStepRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM task_steps WHERE task_id = ? AND tenant_id = ? ORDER BY step_index ASC')
      .all(taskId, tenantId) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as TaskStepRecord),
      depends_on: parseJson(r.depends_on, []),
      input: parseJson(r.input, {}),
      output: r.output ? parseJson(r.output, null) : null,
    }));
  }

  async appendTaskEvent(input: Omit<TaskEventRecord, 'id' | 'created_at'>): Promise<TaskEventRecord> {
    const rec: TaskEventRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString() };
    this.db
      .prepare(`INSERT INTO task_events (id, task_id, tenant_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(rec.id, rec.task_id, rec.tenant_id, rec.event_type, JSON.stringify(rec.payload), rec.created_at);
    return rec;
  }

  async listTaskEvents(taskId: string, tenantId: string, limit = 100): Promise<TaskEventRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM task_events WHERE task_id = ? AND tenant_id = ? ORDER BY created_at ASC LIMIT ?')
      .all(taskId, tenantId, limit) as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as TaskEventRecord), payload: parseJson(r.payload, {}) }));
  }

  // --- Autonomous Objectives ---
  private mapObjectiveRow(r: Record<string, unknown>): ObjectiveRecord {
    return {
      ...(r as unknown as ObjectiveRecord),
      priority_score: Number(r.priority_score ?? 0.5),
      value_score: Number(r.value_score ?? 0.6),
      urgency_score: Number(r.urgency_score ?? 0.5),
      uncertainty_score: Number(r.uncertainty_score ?? 0.4),
      progress_pct: Number(r.progress_pct ?? 0),
      compute_budget_ms: Number(r.compute_budget_ms ?? 30000),
      compute_used_ms: Number(r.compute_used_ms ?? 0),
      linked_task_ids: parseJson(r.linked_task_ids, []),
      linked_research_ids: parseJson(r.linked_research_ids, []),
      knowledge_gaps: parseJson(r.knowledge_gaps, []),
    };
  }

  async createObjective(input: Omit<ObjectiveRecord, 'id' | 'created_at' | 'updated_at'>): Promise<ObjectiveRecord> {
    const now = new Date().toISOString();
    const rec: ObjectiveRecord = { ...input, id: uuidv4(), created_at: now, updated_at: now };
    this.db
      .prepare(
        `INSERT INTO objectives (id, tenant_id, title, description, category, priority_score, value_score, urgency_score, uncertainty_score, progress_pct, status, success_criteria, compute_budget_ms, compute_used_ms, linked_task_ids, linked_research_ids, knowledge_gaps, last_evaluated_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.tenant_id,
        rec.title,
        rec.description,
        rec.category,
        rec.priority_score,
        rec.value_score,
        rec.urgency_score,
        rec.uncertainty_score,
        rec.progress_pct,
        rec.status,
        rec.success_criteria,
        rec.compute_budget_ms,
        rec.compute_used_ms,
        JSON.stringify(rec.linked_task_ids),
        JSON.stringify(rec.linked_research_ids),
        JSON.stringify(rec.knowledge_gaps),
        rec.last_evaluated_at,
        rec.created_at,
        rec.updated_at
      );
    return rec;
  }

  async getObjectiveById(id: string, tenantId: string): Promise<ObjectiveRecord | null> {
    const r = this.db.prepare('SELECT * FROM objectives WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Record<string, unknown> | undefined;
    return r ? this.mapObjectiveRow(r) : null;
  }

  async listObjectives(tenantId?: string, opts?: { status?: ObjectiveStatus; limit?: number }): Promise<ObjectiveRecord[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (tenantId) {
      clauses.push('tenant_id = ?');
      params.push(tenantId);
    }
    if (opts?.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(opts?.limit ?? 50);
    const rows = this.db
      .prepare(`SELECT * FROM objectives ${where} ORDER BY priority_score DESC, updated_at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapObjectiveRow(r));
  }

  async updateObjective(
    id: string,
    tenantId: string,
    patch: Parameters<NeoDatabase['updateObjective']>[2]
  ): Promise<ObjectiveRecord | null> {
    const existing = await this.getObjectiveById(id, tenantId);
    if (!existing) return null;
    const merged: ObjectiveRecord = { ...existing, ...patch, updated_at: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE objectives SET title = ?, description = ?, priority_score = ?, value_score = ?, urgency_score = ?, uncertainty_score = ?, progress_pct = ?, status = ?, compute_used_ms = ?, linked_task_ids = ?, linked_research_ids = ?, knowledge_gaps = ?, last_evaluated_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`
      )
      .run(
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
        merged.updated_at,
        id,
        tenantId
      );
    return merged;
  }

  // --- Tools Registry & Executions ---
  private mapToolRow(r: Record<string, unknown>): ToolRecord {
    return {
      ...(r as unknown as ToolRecord),
      input_schema: parseJson(r.input_schema, {}),
      output_schema: parseJson(r.output_schema, {}),
      required_scopes: parseJson(r.required_scopes, ['read']),
      enabled: Boolean(r.enabled),
    };
  }

  async listTools(): Promise<ToolRecord[]> {
    const rows = this.db.prepare('SELECT * FROM tools ORDER BY name ASC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapToolRow(r));
  }

  async getToolById(id: string): Promise<ToolRecord | null> {
    const r = this.db.prepare('SELECT * FROM tools WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.mapToolRow(r) : null;
  }

  async upsertTool(input: Omit<ToolRecord, 'updated_at'>): Promise<ToolRecord> {
    const now = new Date().toISOString();
    const rec: ToolRecord = { ...input, updated_at: now };
    this.db
      .prepare(
        `INSERT INTO tools (id, name, version, description, input_schema, output_schema, risk_level, required_scopes, timeout_ms, execution_env, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, description = excluded.description, input_schema = excluded.input_schema, output_schema = excluded.output_schema, risk_level = excluded.risk_level, required_scopes = excluded.required_scopes, timeout_ms = excluded.timeout_ms, execution_env = excluded.execution_env, enabled = excluded.enabled, updated_at = excluded.updated_at`
      )
      .run(
        rec.id,
        rec.name,
        rec.version,
        rec.description,
        JSON.stringify(rec.input_schema),
        JSON.stringify(rec.output_schema),
        rec.risk_level,
        JSON.stringify(rec.required_scopes),
        rec.timeout_ms,
        rec.execution_env,
        rec.enabled ? 1 : 0,
        now
      );
    return rec;
  }

  async recordToolExecution(input: Omit<ToolExecutionRecord, 'id' | 'created_at'>): Promise<ToolExecutionRecord> {
    const rec: ToolExecutionRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO tool_executions (id, tenant_id, task_id, tool_id, actor, input, output, ok, error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.tenant_id,
        rec.task_id,
        rec.tool_id,
        rec.actor,
        JSON.stringify(rec.input),
        rec.output ? JSON.stringify(rec.output) : null,
        rec.ok ? 1 : 0,
        rec.error,
        rec.duration_ms,
        rec.created_at
      );
    return rec;
  }

  async listToolExecutions(tenantId?: string, limit = 50): Promise<ToolExecutionRecord[]> {
    const rows = tenantId
      ? (this.db.prepare('SELECT * FROM tool_executions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM tool_executions ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]);
    return rows.map((r) => ({
      ...(r as unknown as ToolExecutionRecord),
      input: parseJson(r.input, {}),
      output: r.output ? parseJson(r.output, null) : null,
      ok: Boolean(r.ok),
    }));
  }

  // --- Models & Evaluations ---
  private mapModelRow(r: Record<string, unknown>): ModelRecord {
    return {
      ...(r as unknown as ModelRecord),
      modalities: parseJson(r.modalities, ['text']),
      roles: parseJson(r.roles, ['primary']),
      capabilities: parseJson(r.capabilities, { toolCalling: false, reasoning: 0.5, coding: 0.5, multilingual: 0.5, persian: 0.5 }),
      benchmark_results: parseJson(r.benchmark_results, {}),
      performance_metrics: parseJson(r.performance_metrics, {}),
    };
  }

  async listModels(): Promise<ModelRecord[]> {
    const rows = this.db.prepare('SELECT * FROM models ORDER BY created_at ASC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapModelRow(r));
  }

  async getModelById(id: string): Promise<ModelRecord | null> {
    const r = this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.mapModelRow(r) : null;
  }

  async upsertModel(input: Omit<ModelRecord, 'created_at'>): Promise<ModelRecord> {
    const now = new Date().toISOString();
    const rec: ModelRecord = { ...input, created_at: now };
    this.db
      .prepare(
        `INSERT INTO models (id, name, version, runtime, architecture, source_repo, license, weight_location, checksum_sha256, download_status, quantization, context_length, vram_gb, ram_gb, modalities, roles, capabilities, benchmark_results, deployment_status, health_status, performance_metrics, last_validated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, runtime = excluded.runtime, architecture = excluded.architecture, source_repo = excluded.source_repo, license = excluded.license, weight_location = excluded.weight_location, checksum_sha256 = excluded.checksum_sha256, download_status = excluded.download_status, quantization = excluded.quantization, context_length = excluded.context_length, vram_gb = excluded.vram_gb, ram_gb = excluded.ram_gb, modalities = excluded.modalities, roles = excluded.roles, capabilities = excluded.capabilities, benchmark_results = excluded.benchmark_results, deployment_status = excluded.deployment_status, health_status = excluded.health_status, performance_metrics = excluded.performance_metrics, last_validated_at = excluded.last_validated_at`
      )
      .run(
        rec.id,
        rec.name,
        rec.version,
        rec.runtime,
        rec.architecture,
        rec.source_repo,
        rec.license,
        rec.weight_location,
        rec.checksum_sha256,
        rec.download_status,
        rec.quantization,
        rec.context_length,
        rec.vram_gb,
        rec.ram_gb,
        JSON.stringify(rec.modalities),
        JSON.stringify(rec.roles),
        JSON.stringify(rec.capabilities),
        JSON.stringify(rec.benchmark_results),
        rec.deployment_status,
        rec.health_status,
        JSON.stringify(rec.performance_metrics),
        rec.last_validated_at,
        rec.created_at
      );
    return (await this.getModelById(rec.id)) || rec;
  }

  async updateModel(
    id: string,
    patch: Partial<
      Pick<
        ModelRecord,
        'download_status' | 'weight_location' | 'checksum_sha256' | 'roles' | 'deployment_status' | 'health_status' | 'performance_metrics' | 'benchmark_results' | 'last_validated_at'
      >
    >
  ): Promise<ModelRecord | null> {
    const existing = await this.getModelById(id);
    if (!existing) return null;
    const merged: ModelRecord = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE models SET download_status = ?, weight_location = ?, checksum_sha256 = ?, roles = ?, deployment_status = ?, health_status = ?, performance_metrics = ?, benchmark_results = ?, last_validated_at = ? WHERE id = ?`
      )
      .run(
        merged.download_status,
        merged.weight_location,
        merged.checksum_sha256,
        JSON.stringify(merged.roles),
        merged.deployment_status,
        merged.health_status,
        JSON.stringify(merged.performance_metrics),
        JSON.stringify(merged.benchmark_results),
        merged.last_validated_at,
        id
      );
    return merged;
  }

  async deleteModel(id: string): Promise<boolean> {
    const res = this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
    return res.changes > 0;
  }

  async recordModelEvaluation(input: Omit<ModelEvaluationRecord, 'id' | 'created_at'>): Promise<ModelEvaluationRecord> {
    const rec: ModelEvaluationRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO model_evaluations (id, model_id, suite_version, overall_score, category_scores, avg_latency_ms, tokens_per_sec, passed_cases, total_cases, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.model_id,
        rec.suite_version,
        rec.overall_score,
        JSON.stringify(rec.category_scores),
        rec.avg_latency_ms,
        rec.tokens_per_sec,
        rec.passed_cases,
        rec.total_cases,
        JSON.stringify(rec.details),
        rec.created_at
      );
    return rec;
  }

  async listModelEvaluations(modelId?: string, limit = 20): Promise<ModelEvaluationRecord[]> {
    const rows = modelId
      ? (this.db.prepare('SELECT * FROM model_evaluations WHERE model_id = ? ORDER BY created_at DESC LIMIT ?').all(modelId, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM model_evaluations ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]);
    return rows.map((r) => ({
      ...(r as unknown as ModelEvaluationRecord),
      category_scores: parseJson(r.category_scores, {}),
      details: parseJson(r.details, []),
    }));
  }

  // --- Upgrades, Experiments & Training Jobs ---
  private mapUpgradeRow(r: Record<string, unknown>): SelfUpgradeRecord {
    return {
      ...(r as unknown as SelfUpgradeRecord),
      target_files: parseJson(r.target_files, []),
      test_results: parseJson(r.test_results, { passed: 0, failed: 0, total: 0, durationMs: 0, output: '' }),
      benchmark_before: parseJson(r.benchmark_before, { accuracyScore: 0, avgLatencyMs: 0, passRate: 0 }),
      benchmark_after: parseJson(r.benchmark_after, { accuracyScore: 0, avgLatencyMs: 0, passRate: 0 }),
      auto_eligible: Boolean(r.auto_eligible),
    };
  }

  async listUpgrades(): Promise<SelfUpgradeRecord[]> {
    const rows = this.db.prepare('SELECT * FROM self_upgrades ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.mapUpgradeRow(r));
  }

  async getUpgradeById(id: string): Promise<SelfUpgradeRecord | null> {
    const r = this.db.prepare('SELECT * FROM self_upgrades WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? this.mapUpgradeRow(r) : null;
  }

  async createUpgrade(input: Omit<SelfUpgradeRecord, 'id' | 'created_at' | 'updated_at'>): Promise<SelfUpgradeRecord> {
    const now = new Date().toISOString();
    const rec: SelfUpgradeRecord = { ...input, id: uuidv4(), created_at: now, updated_at: now };
    this.db
      .prepare(
        `INSERT INTO self_upgrades (id, title, diagnosis, branch_name, target_files, unified_diff, test_results, benchmark_before, benchmark_after, rollback_plan, status, auto_eligible, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.title,
        rec.diagnosis,
        rec.branch_name,
        JSON.stringify(rec.target_files),
        rec.unified_diff,
        JSON.stringify(rec.test_results),
        JSON.stringify(rec.benchmark_before),
        JSON.stringify(rec.benchmark_after),
        rec.rollback_plan,
        rec.status,
        rec.auto_eligible ? 1 : 0,
        rec.created_at,
        rec.updated_at
      );
    return rec;
  }

  async updateUpgradeStatus(id: string, status: UpgradeStatus): Promise<SelfUpgradeRecord | null> {
    this.db.prepare('UPDATE self_upgrades SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    return this.getUpgradeById(id);
  }

  async recordEvolutionExperiment(input: Omit<EvolutionExperimentRecord, 'id' | 'created_at'>): Promise<EvolutionExperimentRecord> {
    const rec: EvolutionExperimentRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO evolution_experiments (id, layer, title, hypothesis, config_before, config_after, metrics_before, metrics_after, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.layer,
        rec.title,
        rec.hypothesis,
        JSON.stringify(rec.config_before),
        JSON.stringify(rec.config_after),
        JSON.stringify(rec.metrics_before),
        JSON.stringify(rec.metrics_after),
        rec.status,
        rec.created_at
      );
    return rec;
  }

  async listEvolutionExperiments(limit = 30): Promise<EvolutionExperimentRecord[]> {
    const rows = this.db.prepare('SELECT * FROM evolution_experiments ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as EvolutionExperimentRecord),
      config_before: parseJson(r.config_before, {}),
      config_after: parseJson(r.config_after, {}),
      metrics_before: parseJson(r.metrics_before, {}),
      metrics_after: parseJson(r.metrics_after, {}),
    }));
  }

  async createTrainingJob(input: Omit<TrainingJobRecord, 'id' | 'created_at' | 'finished_at'>): Promise<TrainingJobRecord> {
    const rec: TrainingJobRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString(), finished_at: null };
    this.db
      .prepare(
        `INSERT INTO training_jobs (id, tenant_id, base_model_id, method, dataset_size, dataset_path, adapter_version, privacy_filtered, status, metrics, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        rec.id,
        rec.tenant_id,
        rec.base_model_id,
        rec.method,
        rec.dataset_size,
        rec.dataset_path,
        rec.adapter_version,
        rec.privacy_filtered ? 1 : 0,
        rec.status,
        JSON.stringify(rec.metrics),
        rec.created_at
      );
    return rec;
  }

  async updateTrainingJob(
    id: string,
    patch: Partial<Pick<TrainingJobRecord, 'status' | 'metrics' | 'dataset_size' | 'dataset_path' | 'adapter_version' | 'finished_at'>>
  ): Promise<TrainingJobRecord | null> {
    const r = this.db.prepare('SELECT * FROM training_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const merged: TrainingJobRecord = {
      ...(r as unknown as TrainingJobRecord),
      metrics: parseJson(r.metrics, {}),
      privacy_filtered: Boolean(r.privacy_filtered),
      ...patch,
    };
    this.db
      .prepare(`UPDATE training_jobs SET status = ?, metrics = ?, dataset_size = ?, dataset_path = ?, adapter_version = ?, finished_at = ? WHERE id = ?`)
      .run(merged.status, JSON.stringify(merged.metrics), merged.dataset_size, merged.dataset_path, merged.adapter_version, merged.finished_at, id);
    return merged;
  }

  async listTrainingJobs(tenantId?: string, limit = 20): Promise<TrainingJobRecord[]> {
    const rows = tenantId
      ? (this.db.prepare('SELECT * FROM training_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM training_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]);
    return rows.map((r) => ({
      ...(r as unknown as TrainingJobRecord),
      metrics: parseJson(r.metrics, {}),
      privacy_filtered: Boolean(r.privacy_filtered),
    }));
  }

  // --- Dynamic APIs ---
  private mapDynamicApiRow(r: Record<string, unknown>): DynamicApiRecord {
    return {
      ...(r as unknown as DynamicApiRecord),
      input_schema: parseJson(r.input_schema, {}),
      output_schema: parseJson(r.output_schema, {}),
      test_report: parseJson(r.test_report, { passed: 0, failed: 0, total: 0, durationMs: 0, details: [] }),
      openapi_spec: parseJson(r.openapi_spec, {}),
      enabled: Boolean(r.enabled),
    };
  }

  async listDynamicApis(tenantId?: string): Promise<DynamicApiRecord[]> {
    const rows = tenantId
      ? (this.db.prepare('SELECT * FROM dynamic_apis WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM dynamic_apis ORDER BY created_at DESC').all() as Record<string, unknown>[]);
    return rows.map((r) => this.mapDynamicApiRow(r));
  }

  async getDynamicApiBySlug(slug: string, tenantId?: string): Promise<DynamicApiRecord | null> {
    const r = tenantId
      ? (this.db.prepare('SELECT * FROM dynamic_apis WHERE slug = ? AND (tenant_id = ? OR tenant_id = ?)').get(slug, tenantId, 'global') as Record<string, unknown> | undefined)
      : (this.db.prepare('SELECT * FROM dynamic_apis WHERE slug = ?').get(slug) as Record<string, unknown> | undefined);
    return r ? this.mapDynamicApiRow(r) : null;
  }

  async upsertDynamicApi(input: Omit<DynamicApiRecord, 'id' | 'call_count' | 'created_at' | 'updated_at'>): Promise<DynamicApiRecord> {
    const existing = await this.getDynamicApiBySlug(input.slug);
    if (existing && existing.tenant_id !== input.tenant_id) {
      throw new Error('This endpoint slug is already reserved by another workspace.');
    }
    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE dynamic_apis SET name = ?, description = ?, method = ?, input_schema = ?, output_schema = ?, handler_code = ?, test_code = ?, test_report = ?, openapi_spec = ?, rate_limit_rpm = ?, enabled = ?, updated_at = ? WHERE slug = ? AND tenant_id = ?`
        )
        .run(
          input.name,
          input.description,
          input.method,
          JSON.stringify(input.input_schema),
          JSON.stringify(input.output_schema),
          input.handler_code,
          input.test_code,
          JSON.stringify(input.test_report),
          JSON.stringify(input.openapi_spec),
          input.rate_limit_rpm,
          input.enabled ? 1 : 0,
          now,
          input.slug,
          input.tenant_id
        );
      return (await this.getDynamicApiBySlug(input.slug, input.tenant_id))!;
    }
    const rec: DynamicApiRecord = { ...input, id: uuidv4(), call_count: 0, created_at: now, updated_at: now };
    this.db
      .prepare(
        `INSERT INTO dynamic_apis (id, tenant_id, slug, name, description, method, input_schema, output_schema, handler_code, test_code, test_report, openapi_spec, rate_limit_rpm, call_count, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.tenant_id,
        rec.slug,
        rec.name,
        rec.description,
        rec.method,
        JSON.stringify(rec.input_schema),
        JSON.stringify(rec.output_schema),
        rec.handler_code,
        rec.test_code,
        JSON.stringify(rec.test_report),
        JSON.stringify(rec.openapi_spec),
        rec.rate_limit_rpm,
        rec.enabled ? 1 : 0,
        rec.created_at,
        rec.updated_at
      );
    return rec;
  }

  async incrementDynamicApiCalls(slug: string, tenantId: string): Promise<void> {
    this.db.prepare('UPDATE dynamic_apis SET call_count = call_count + 1 WHERE slug = ? AND tenant_id = ?').run(slug, tenantId);
  }

  async toggleDynamicApi(slug: string, enabled: boolean, tenantId?: string): Promise<DynamicApiRecord | null> {
    if (tenantId) {
      this.db.prepare('UPDATE dynamic_apis SET enabled = ?, updated_at = ? WHERE slug = ? AND tenant_id = ?').run(enabled ? 1 : 0, new Date().toISOString(), slug, tenantId);
      return this.getDynamicApiBySlug(slug, tenantId);
    }
    this.db.prepare('UPDATE dynamic_apis SET enabled = ?, updated_at = ? WHERE slug = ?').run(enabled ? 1 : 0, new Date().toISOString(), slug);
    return this.getDynamicApiBySlug(slug);
  }

  // --- Background Jobs & Scheduled Jobs ---
  async enqueueJob(input: Pick<BackgroundJobRecord, 'queue_name' | 'job_type' | 'payload'>): Promise<BackgroundJobRecord> {
    const rec: BackgroundJobRecord = {
      id: uuidv4(),
      queue_name: input.queue_name,
      job_type: input.job_type,
      payload: input.payload,
      status: 'queued',
      result: null,
      error: null,
      attempts: 0,
      created_at: new Date().toISOString(),
      finished_at: null,
    };
    this.db
      .prepare(`INSERT INTO background_jobs (id, queue_name, job_type, payload, status, result, error, attempts, created_at, finished_at) VALUES (?, ?, ?, ?, 'queued', NULL, NULL, 0, ?, NULL)`)
      .run(rec.id, rec.queue_name, rec.job_type, JSON.stringify(rec.payload), rec.created_at);
    return rec;
  }

  async updateJob(id: string, patch: Partial<Pick<BackgroundJobRecord, 'status' | 'result' | 'error' | 'attempts' | 'finished_at'>>): Promise<void> {
    const existing = this.db.prepare('SELECT * FROM background_jobs WHERE id = ?').get(id) as
      | { status: string; result: string | null; error: string | null; attempts: number; finished_at: string | null }
      | undefined;
    if (!existing) return;
    this.db
      .prepare(`UPDATE background_jobs SET status = ?, result = ?, error = ?, attempts = ?, finished_at = ? WHERE id = ?`)
      .run(
        patch.status ?? existing.status,
        patch.result !== undefined ? JSON.stringify(patch.result) : existing.result,
        patch.error !== undefined ? patch.error : existing.error,
        patch.attempts ?? existing.attempts,
        patch.finished_at !== undefined ? patch.finished_at : existing.finished_at,
        id
      );
  }

  async listJobs(limit = 30): Promise<BackgroundJobRecord[]> {
    const rows = this.db.prepare('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as BackgroundJobRecord),
      payload: parseJson(r.payload, {}),
      result: r.result ? parseJson(r.result, null) : null,
    }));
  }

  async listScheduledJobs(): Promise<ScheduledJobRecord[]> {
    const rows = this.db.prepare('SELECT * FROM scheduled_jobs ORDER BY id ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as ScheduledJobRecord), enabled: Boolean(r.enabled) }));
  }

  async upsertScheduledJob(input: ScheduledJobRecord): Promise<ScheduledJobRecord> {
    this.db
      .prepare(
        `INSERT INTO scheduled_jobs (id, name, job_kind, priority, interval_ms, enabled, last_run_at, next_run_at, last_status, last_error, run_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, job_kind = excluded.job_kind, priority = excluded.priority, interval_ms = excluded.interval_ms, enabled = excluded.enabled`
      )
      .run(
        input.id,
        input.name,
        input.job_kind,
        input.priority,
        input.interval_ms,
        input.enabled ? 1 : 0,
        input.last_run_at,
        input.next_run_at,
        input.last_status,
        input.last_error,
        input.run_count
      );
    return input;
  }

  async updateScheduledJob(
    id: string,
    patch: Partial<Pick<ScheduledJobRecord, 'enabled' | 'interval_ms' | 'last_run_at' | 'next_run_at' | 'last_status' | 'last_error' | 'run_count'>>
  ): Promise<ScheduledJobRecord | null> {
    const r = this.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    const existing: ScheduledJobRecord = { ...(r as unknown as ScheduledJobRecord), enabled: Boolean(r.enabled) };
    const merged: ScheduledJobRecord = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE scheduled_jobs SET enabled = ?, interval_ms = ?, last_run_at = ?, next_run_at = ?, last_status = ?, last_error = ?, run_count = ? WHERE id = ?`
      )
      .run(
        merged.enabled ? 1 : 0,
        merged.interval_ms,
        merged.last_run_at,
        merged.next_run_at,
        merged.last_status,
        merged.last_error,
        merged.run_count,
        id
      );
    return merged;
  }

  // --- Telemetry & Audit Logs ---
  async recordTelemetry(input: Omit<LlmTelemetryRecord, 'id' | 'created_at'>): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO llm_telemetry (id, tenant_id, provider, model, task_type, prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms, success, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        uuidv4(),
        input.tenant_id,
        input.provider,
        input.model,
        input.task_type,
        input.prompt_tokens,
        input.completion_tokens,
        input.estimated_cost_usd,
        input.latency_ms,
        input.success ? 1 : 0,
        input.error_message,
        new Date().toISOString()
      );
  }

  async listTelemetry(limit = 50, tenantId?: string): Promise<LlmTelemetryRecord[]> {
    const rows = tenantId
      ? (this.db.prepare('SELECT * FROM llm_telemetry WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM llm_telemetry ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]);
    return rows.map((r) => ({ ...(r as unknown as LlmTelemetryRecord), success: Boolean(r.success) }));
  }

  async getTelemetrySummary(tenantId?: string) {
    const rows = await this.listTelemetry(500, tenantId);
    const totalCalls = rows.length;
    const successes = rows.filter((r) => r.success).length;
    const totalTokens = rows.reduce((s, r) => s + r.prompt_tokens + r.completion_tokens, 0);
    const totalCostUsd = Number(rows.reduce((s, r) => s + r.estimated_cost_usd, 0).toFixed(5));
    const avgLatencyMs = totalCalls ? Math.round(rows.reduce((s, r) => s + r.latency_ms, 0) / totalCalls) : 0;

    const map = new Map<string, { provider: string; model: string; calls: number; tokens: number; costUsd: number; latencySum: number }>();
    for (const r of rows) {
      const k = `${r.provider}:${r.model}`;
      const cur = map.get(k) || { provider: r.provider, model: r.model, calls: 0, tokens: 0, costUsd: 0, latencySum: 0 };
      cur.calls += 1;
      cur.tokens += r.prompt_tokens + r.completion_tokens;
      cur.costUsd += r.estimated_cost_usd;
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
    this.db
      .prepare(`INSERT INTO audit_logs (id, tenant_id, actor, action, resource, status_code, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uuidv4(), input.tenant_id, input.actor, input.action, input.resource, input.status_code, JSON.stringify(input.metadata), new Date().toISOString());
  }

  async listAuditLogs(limit = 50, tenantId?: string): Promise<AuditLogRecord[]> {
    const rows = tenantId
      ? (this.db.prepare('SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, limit) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]);
    return rows.map((r) => ({ ...(r as unknown as AuditLogRecord), metadata: parseJson(r.metadata, {}) }));
  }

  async getAdminConfig(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM admin_config WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  async setAdminConfig(key: string, value: string): Promise<void> {
    this.db
      .prepare(`INSERT INTO admin_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, value, new Date().toISOString());
  }

  async setAdminConfigIfAbsent(key: string, value: string): Promise<boolean> {
    const result = this.db
      .prepare('INSERT INTO admin_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
      .run(key, value, new Date().toISOString());
    return Number(result.changes) === 1;
  }
}
