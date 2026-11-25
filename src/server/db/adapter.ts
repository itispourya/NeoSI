import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config/env.ts';
import type {
  ApiKeyRecord,
  AuditLogRecord,
  BackgroundJobRecord,
  DynamicApiRecord,
  LlmTelemetryRecord,
  MemoryRecord,
  MemoryType,
  SelfUpgradeRecord,
  SkillRecord,
  TenantRecord,
  TopicStreamRecord,
  UpgradeStatus,
} from './schema.ts';
import { cosineSimilarity, deterministicTextEmbedding } from './vector.ts';

export interface NeoDatabase {
  mode: 'postgresql' | 'sqlite';
  init(): Promise<void>;
  // Tenants & Keys
  listTenants(): Promise<TenantRecord[]>;
  getTenantById(id: string): Promise<TenantRecord | null>;
  createTenant(input: Omit<TenantRecord, 'id' | 'created_at'>): Promise<TenantRecord>;
  updateTenant(id: string, patch: Partial<Pick<TenantRecord, 'workspace_language' | 'webhook_url' | 'webhook_secret' | 'pii_redaction' | 'rate_limit_rpm'>>): Promise<TenantRecord | null>;
  listApiKeys(tenantId?: string): Promise<ApiKeyRecord[]>;
  getApiKeyByHash(hash: string): Promise<ApiKeyRecord | null>;
  createApiKey(input: Omit<ApiKeyRecord, 'id' | 'last_used_at' | 'revoked_at' | 'created_at'>): Promise<ApiKeyRecord>;
  touchApiKey(id: string): Promise<void>;
  revokeApiKey(id: string): Promise<boolean>;

  // Memories & Semantic Vector Search
  insertMemory(input: Omit<MemoryRecord, 'id' | 'created_at'>): Promise<MemoryRecord>;
  listMemories(opts?: { memoryType?: MemoryType; tenantId?: string; limit?: number }): Promise<MemoryRecord[]>;
  searchMemories(queryEmbedding: number[], opts?: { memoryType?: MemoryType; tenantId?: string; limit?: number; minScore?: number }): Promise<Array<MemoryRecord & { similarity: number }>>;
  countMemories(): Promise<{ total: number; episodic: number; semantic: number; procedural: number }>;

  // Skill Registry
  listSkills(): Promise<SkillRecord[]>;
  upsertSkill(input: Omit<SkillRecord, 'id' | 'updated_at'>): Promise<SkillRecord>;

  // Topic Streams
  listTopicStreams(): Promise<TopicStreamRecord[]>;
  createTopicStream(input: Pick<TopicStreamRecord, 'topic' | 'category' | 'interval_minutes'>): Promise<TopicStreamRecord>;
  toggleTopicStream(id: string, enabled: boolean): Promise<TopicStreamRecord | null>;
  markTopicCrawled(id: string, addedItems: number): Promise<void>;

  // Self Upgrades
  listUpgrades(): Promise<SelfUpgradeRecord[]>;
  getUpgradeById(id: string): Promise<SelfUpgradeRecord | null>;
  createUpgrade(input: Omit<SelfUpgradeRecord, 'id' | 'created_at' | 'updated_at'>): Promise<SelfUpgradeRecord>;
  updateUpgradeStatus(id: string, status: UpgradeStatus): Promise<SelfUpgradeRecord | null>;

  // Dynamic APIs (Forge)
  listDynamicApis(): Promise<DynamicApiRecord[]>;
  getDynamicApiBySlug(slug: string): Promise<DynamicApiRecord | null>;
  upsertDynamicApi(input: Omit<DynamicApiRecord, 'id' | 'call_count' | 'created_at' | 'updated_at'>): Promise<DynamicApiRecord>;
  incrementDynamicApiCalls(slug: string): Promise<void>;
  toggleDynamicApi(slug: string, enabled: boolean): Promise<DynamicApiRecord | null>;

  // Background Jobs
  enqueueJob(input: Pick<BackgroundJobRecord, 'queue_name' | 'job_type' | 'payload'>): Promise<BackgroundJobRecord>;
  updateJob(id: string, patch: Partial<Pick<BackgroundJobRecord, 'status' | 'result' | 'error' | 'attempts' | 'finished_at'>>): Promise<void>;
  listJobs(limit?: number): Promise<BackgroundJobRecord[]>;

  // LLM Telemetry & Audit Logs
  recordTelemetry(input: Omit<LlmTelemetryRecord, 'id' | 'created_at'>): Promise<void>;
  listTelemetry(limit?: number): Promise<LlmTelemetryRecord[]>;
  getTelemetrySummary(): Promise<{
    totalCalls: number;
    successRate: number;
    totalTokens: number;
    totalCostUsd: number;
    avgLatencyMs: number;
    byProvider: Array<{ provider: string; model: string; calls: number; tokens: number; costUsd: number; avgLatencyMs: number }>;
  }>;
  recordAuditLog(input: Omit<AuditLogRecord, 'id' | 'created_at'>): Promise<void>;
  listAuditLogs(limit?: number): Promise<AuditLogRecord[]>;

  // Admin Config
  getAdminConfig(key: string): Promise<string | null>;
  setAdminConfig(key: string, value: string): Promise<void>;
}

class SqliteNeoDatabase implements NeoDatabase {
  public readonly mode = 'sqlite' as const;
  private db: DatabaseSync;

  constructor(dbPath = path.resolve(process.cwd(), 'data', 'neo.db')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }

  async init(): Promise<void> {
    this.db.exec(`
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
        embedding TEXT NOT NULL,
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
    `);
    await seedInitialData(this);
  }

  async listTenants(): Promise<TenantRecord[]> {
    const rows = this.db.prepare('SELECT * FROM tenants ORDER BY created_at ASC').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as TenantRecord),
      pii_redaction: Boolean(r.pii_redaction),
    }));
  }

  async getTenantById(id: string): Promise<TenantRecord | null> {
    const r = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { ...(r as unknown as TenantRecord), pii_redaction: Boolean(r.pii_redaction) };
  }

  async createTenant(input: Omit<TenantRecord, 'id' | 'created_at'>): Promise<TenantRecord> {
    const rec: TenantRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO tenants (id, name, slug, workspace_language, webhook_url, webhook_secret, pii_redaction, rate_limit_rpm, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.name,
        rec.slug,
        rec.workspace_language,
        rec.webhook_url,
        rec.webhook_secret,
        rec.pii_redaction ? 1 : 0,
        rec.rate_limit_rpm,
        rec.created_at
      );
    return rec;
  }

  async updateTenant(
    id: string,
    patch: Partial<Pick<TenantRecord, 'workspace_language' | 'webhook_url' | 'webhook_secret' | 'pii_redaction' | 'rate_limit_rpm'>>
  ): Promise<TenantRecord | null> {
    const existing = await this.getTenantById(id);
    if (!existing) return null;
    const merged: TenantRecord = {
      ...existing,
      ...patch,
    };
    this.db
      .prepare(
        `UPDATE tenants SET workspace_language = ?, webhook_url = ?, webhook_secret = ?, pii_redaction = ?, rate_limit_rpm = ? WHERE id = ?`
      )
      .run(
        merged.workspace_language,
        merged.webhook_url,
        merged.webhook_secret,
        merged.pii_redaction ? 1 : 0,
        merged.rate_limit_rpm,
        id
      );
    return merged;
  }

  async listApiKeys(tenantId?: string): Promise<ApiKeyRecord[]> {
    const rows = tenantId
      ? (this.db.prepare('SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as Record<string, unknown>[]);
    return rows.map((r) => ({
      ...(r as unknown as ApiKeyRecord),
      scopes: JSON.parse(String(r.scopes || '[]')),
    }));
  }

  async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { ...(r as unknown as ApiKeyRecord), scopes: JSON.parse(String(r.scopes || '[]')) };
  }

  async createApiKey(input: Omit<ApiKeyRecord, 'id' | 'last_used_at' | 'revoked_at' | 'created_at'>): Promise<ApiKeyRecord> {
    const rec: ApiKeyRecord = {
      ...input,
      id: uuidv4(),
      last_used_at: null,
      revoked_at: null,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes, last_used_at, revoked_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
      )
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

  async insertMemory(input: Omit<MemoryRecord, 'id' | 'created_at'>): Promise<MemoryRecord> {
    const rec: MemoryRecord = { ...input, id: uuidv4(), created_at: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO memories (id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        JSON.stringify(rec.embedding),
        rec.created_at
      );
    return rec;
  }

  async listMemories(opts?: { memoryType?: MemoryType; tenantId?: string; limit?: number }): Promise<MemoryRecord[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts?.memoryType) {
      clauses.push('memory_type = ?');
      params.push(opts.memoryType);
    }
    if (opts?.tenantId) {
      clauses.push('(tenant_id = ? OR tenant_id = ?)');
      params.push(opts.tenantId, 'global');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = opts?.limit ?? 50;
    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as MemoryRecord),
      structured_facts: JSON.parse(String(r.structured_facts || '{}')),
      embedding: JSON.parse(String(r.embedding || '[]')),
    }));
  }

  async searchMemories(
    queryEmbedding: number[],
    opts?: { memoryType?: MemoryType; tenantId?: string; limit?: number; minScore?: number }
  ): Promise<Array<MemoryRecord & { similarity: number }>> {
    const candidates = await this.listMemories({
      memoryType: opts?.memoryType,
      tenantId: opts?.tenantId,
      limit: 500,
    });
    const minScore = opts?.minScore ?? 0.05;
    return candidates
      .map((m) => ({
        ...m,
        similarity: Number(cosineSimilarity(queryEmbedding, m.embedding).toFixed(4)),
      }))
      .filter((m) => m.similarity >= minScore)
      .sort((a, b) => b.similarity * b.reliability_score - a.similarity * a.reliability_score)
      .slice(0, opts?.limit ?? 8);
  }

  async countMemories(): Promise<{ total: number; episodic: number; semantic: number; procedural: number }> {
    const rows = this.db
      .prepare(`SELECT memory_type, COUNT(*) as cnt FROM memories GROUP BY memory_type`)
      .all() as Array<{ memory_type: string; cnt: number }>;
    const counts = { total: 0, episodic: 0, semantic: 0, procedural: 0 };
    for (const r of rows) {
      const c = Number(r.cnt || 0);
      counts.total += c;
      if (r.memory_type === 'episodic') counts.episodic = c;
      if (r.memory_type === 'semantic') counts.semantic = c;
      if (r.memory_type === 'procedural') counts.procedural = c;
    }
    return counts;
  }

  async listSkills(): Promise<SkillRecord[]> {
    const rows = this.db.prepare('SELECT * FROM skills ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as SkillRecord),
      metadata: JSON.parse(String(r.metadata || '{}')),
    }));
  }

  async upsertSkill(input: Omit<SkillRecord, 'id' | 'updated_at'>): Promise<SkillRecord> {
    const existing = this.db.prepare('SELECT id, version FROM skills WHERE slug = ?').get(input.slug) as
      | { id: string; version: number }
      | undefined;
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
      .prepare(
        `INSERT INTO topic_streams (id, topic, category, enabled, interval_minutes, last_crawled_at, items_ingested, created_at)
         VALUES (?, ?, ?, 1, ?, NULL, 0, ?)`
      )
      .run(rec.id, rec.topic, rec.category, rec.interval_minutes, rec.created_at);
    return rec;
  }

  async toggleTopicStream(id: string, enabled: boolean): Promise<TopicStreamRecord | null> {
    this.db.prepare('UPDATE topic_streams SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    const r = this.db.prepare('SELECT * FROM topic_streams WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { ...(r as unknown as TopicStreamRecord), enabled: Boolean(r.enabled) };
  }

  async markTopicCrawled(id: string, addedItems: number): Promise<void> {
    this.db
      .prepare('UPDATE topic_streams SET last_crawled_at = ?, items_ingested = items_ingested + ? WHERE id = ?')
      .run(new Date().toISOString(), addedItems, id);
  }

  async listUpgrades(): Promise<SelfUpgradeRecord[]> {
    const rows = this.db.prepare('SELECT * FROM self_upgrades ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as SelfUpgradeRecord),
      target_files: JSON.parse(String(r.target_files || '[]')),
      test_results: JSON.parse(String(r.test_results || '{}')),
      benchmark_before: JSON.parse(String(r.benchmark_before || '{}')),
      benchmark_after: JSON.parse(String(r.benchmark_after || '{}')),
      auto_eligible: Boolean(r.auto_eligible),
    }));
  }

  async getUpgradeById(id: string): Promise<SelfUpgradeRecord | null> {
    const r = this.db.prepare('SELECT * FROM self_upgrades WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      ...(r as unknown as SelfUpgradeRecord),
      target_files: JSON.parse(String(r.target_files || '[]')),
      test_results: JSON.parse(String(r.test_results || '{}')),
      benchmark_before: JSON.parse(String(r.benchmark_before || '{}')),
      benchmark_after: JSON.parse(String(r.benchmark_after || '{}')),
      auto_eligible: Boolean(r.auto_eligible),
    };
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

  async listDynamicApis(): Promise<DynamicApiRecord[]> {
    const rows = this.db.prepare('SELECT * FROM dynamic_apis ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as DynamicApiRecord),
      input_schema: JSON.parse(String(r.input_schema || '{}')),
      output_schema: JSON.parse(String(r.output_schema || '{}')),
      test_report: JSON.parse(String(r.test_report || '{}')),
      openapi_spec: JSON.parse(String(r.openapi_spec || '{}')),
      enabled: Boolean(r.enabled),
    }));
  }

  async getDynamicApiBySlug(slug: string): Promise<DynamicApiRecord | null> {
    const r = this.db.prepare('SELECT * FROM dynamic_apis WHERE slug = ?').get(slug) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      ...(r as unknown as DynamicApiRecord),
      input_schema: JSON.parse(String(r.input_schema || '{}')),
      output_schema: JSON.parse(String(r.output_schema || '{}')),
      test_report: JSON.parse(String(r.test_report || '{}')),
      openapi_spec: JSON.parse(String(r.openapi_spec || '{}')),
      enabled: Boolean(r.enabled),
    };
  }

  async upsertDynamicApi(input: Omit<DynamicApiRecord, 'id' | 'call_count' | 'created_at' | 'updated_at'>): Promise<DynamicApiRecord> {
    const existing = await this.getDynamicApiBySlug(input.slug);
    const now = new Date().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE dynamic_apis SET name = ?, description = ?, method = ?, input_schema = ?, output_schema = ?, handler_code = ?, test_code = ?, test_report = ?, openapi_spec = ?, rate_limit_rpm = ?, enabled = ?, updated_at = ? WHERE slug = ?`
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
          input.slug
        );
      return (await this.getDynamicApiBySlug(input.slug))!;
    }
    const rec: DynamicApiRecord = {
      ...input,
      id: uuidv4(),
      call_count: 0,
      created_at: now,
      updated_at: now,
    };
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

  async incrementDynamicApiCalls(slug: string): Promise<void> {
    this.db.prepare('UPDATE dynamic_apis SET call_count = call_count + 1 WHERE slug = ?').run(slug);
  }

  async toggleDynamicApi(slug: string, enabled: boolean): Promise<DynamicApiRecord | null> {
    this.db.prepare('UPDATE dynamic_apis SET enabled = ?, updated_at = ? WHERE slug = ?').run(enabled ? 1 : 0, new Date().toISOString(), slug);
    return this.getDynamicApiBySlug(slug);
  }

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
      .prepare(
        `INSERT INTO background_jobs (id, queue_name, job_type, payload, status, result, error, attempts, created_at, finished_at)
         VALUES (?, ?, ?, ?, 'queued', NULL, NULL, 0, ?, NULL)`
      )
      .run(rec.id, rec.queue_name, rec.job_type, JSON.stringify(rec.payload), rec.created_at);
    return rec;
  }

  async updateJob(
    id: string,
    patch: Partial<Pick<BackgroundJobRecord, 'status' | 'result' | 'error' | 'attempts' | 'finished_at'>>
  ): Promise<void> {
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
      payload: JSON.parse(String(r.payload || '{}')),
      result: r.result ? JSON.parse(String(r.result)) : null,
    }));
  }

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

  async listTelemetry(limit = 50): Promise<LlmTelemetryRecord[]> {
    const rows = this.db.prepare('SELECT * FROM llm_telemetry ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as LlmTelemetryRecord), success: Boolean(r.success) }));
  }

  async getTelemetrySummary() {
    const rows = await this.listTelemetry(500);
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
      .prepare(
        `INSERT INTO audit_logs (id, tenant_id, actor, action, resource, status_code, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(uuidv4(), input.tenant_id, input.actor, input.action, input.resource, input.status_code, JSON.stringify(input.metadata), new Date().toISOString());
  }

  async listAuditLogs(limit = 50): Promise<AuditLogRecord[]> {
    const rows = this.db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...(r as unknown as AuditLogRecord),
      metadata: JSON.parse(String(r.metadata || '{}')),
    }));
  }

  async getAdminConfig(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM admin_config WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  async setAdminConfig(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO admin_config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }
}

class PostgresNeoDatabase implements NeoDatabase {
  public readonly mode = 'postgresql' as const;
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    const migrationPath = path.resolve(process.cwd(), 'migrations', '001_init.sql');
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf8');
      await this.pool.query(sql);
    }
    await seedInitialData(this);
  }

  async listTenants(): Promise<TenantRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM tenants ORDER BY created_at ASC');
    return rows;
  }

  async getTenantById(id: string): Promise<TenantRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM tenants WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async createTenant(input: Omit<TenantRecord, 'id' | 'created_at'>): Promise<TenantRecord> {
    const id = uuidv4();
    const { rows } = await this.pool.query(
      `INSERT INTO tenants (id, name, slug, workspace_language, webhook_url, webhook_secret, pii_redaction, rate_limit_rpm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, input.name, input.slug, input.workspace_language, input.webhook_url, input.webhook_secret, input.pii_redaction, input.rate_limit_rpm]
    );
    return rows[0];
  }

  async updateTenant(id: string, patch: Partial<Pick<TenantRecord, 'workspace_language' | 'webhook_url' | 'webhook_secret' | 'pii_redaction' | 'rate_limit_rpm'>>): Promise<TenantRecord | null> {
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

  async getApiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM api_keys WHERE key_hash = $1', [hash]);
    return rows[0] || null;
  }

  async createApiKey(input: Omit<ApiKeyRecord, 'id' | 'last_used_at' | 'revoked_at' | 'created_at'>): Promise<ApiKeyRecord> {
    const id = uuidv4();
    const { rows } = await this.pool.query(
      `INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, input.tenant_id, input.name, input.key_prefix, input.key_hash, JSON.stringify(input.scopes)]
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

  async insertMemory(input: Omit<MemoryRecord, 'id' | 'created_at'>): Promise<MemoryRecord> {
    const id = uuidv4();
    const vecLiteral = `[${input.embedding.join(',')}]`;
    const { rows } = await this.pool.query(
      `INSERT INTO memories (id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, NOW()) RETURNING *`,
      [
        id,
        input.tenant_id,
        input.memory_type,
        input.topic,
        input.title,
        input.content,
        JSON.stringify(input.structured_facts),
        input.source_url,
        input.reliability_score,
        input.freshness_score,
        vecLiteral,
      ]
    );
    return { ...rows[0], embedding: input.embedding };
  }

  async listMemories(opts?: { memoryType?: MemoryType; tenantId?: string; limit?: number }): Promise<MemoryRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (opts?.memoryType) {
      clauses.push(`memory_type = $${idx++}`);
      params.push(opts.memoryType);
    }
    if (opts?.tenantId) {
      clauses.push(`(tenant_id = $${idx++} OR tenant_id = $${idx++})`);
      params.push(opts.tenantId, 'global');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(opts?.limit ?? 50);
    const { rows } = await this.pool.query(`SELECT id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, created_at FROM memories ${where} ORDER BY created_at DESC LIMIT $${idx}`, params);
    return rows.map((r) => ({ ...r, embedding: [] }));
  }

  async searchMemories(queryEmbedding: number[], opts?: { memoryType?: MemoryType; tenantId?: string; limit?: number; minScore?: number }): Promise<Array<MemoryRecord & { similarity: number }>> {
    const vecLiteral = `[${queryEmbedding.join(',')}]`;
    const clauses: string[] = ['embedding IS NOT NULL'];
    const params: unknown[] = [vecLiteral];
    let idx = 2;
    if (opts?.memoryType) {
      clauses.push(`memory_type = $${idx++}`);
      params.push(opts.memoryType);
    }
    if (opts?.tenantId) {
      clauses.push(`(tenant_id = $${idx++} OR tenant_id = $${idx++})`);
      params.push(opts.tenantId, 'global');
    }
    params.push(opts?.limit ?? 8);
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id, memory_type, topic, title, content, structured_facts, source_url, reliability_score, freshness_score, created_at,
       1 - (embedding <=> $1::vector) AS similarity
       FROM memories WHERE ${clauses.join(' AND ')}
       ORDER BY similarity DESC LIMIT $${idx}`,
      params
    );
    return rows
      .filter((r) => Number(r.similarity) >= (opts?.minScore ?? 0.05))
      .map((r) => ({ ...r, embedding: [], similarity: Number(Number(r.similarity).toFixed(4)) }));
  }

  async countMemories() {
    const { rows } = await this.pool.query('SELECT memory_type, COUNT(*)::int as cnt FROM memories GROUP BY memory_type');
    const counts = { total: 0, episodic: 0, semantic: 0, procedural: 0 };
    for (const r of rows) {
      counts.total += r.cnt;
      if (r.memory_type === 'episodic') counts.episodic = r.cnt;
      if (r.memory_type === 'semantic') counts.semantic = r.cnt;
      if (r.memory_type === 'procedural') counts.procedural = r.cnt;
    }
    return counts;
  }

  async listSkills(): Promise<SkillRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM skills ORDER BY updated_at DESC');
    return rows;
  }

  async upsertSkill(input: Omit<SkillRecord, 'id' | 'updated_at'>): Promise<SkillRecord> {
    const id = uuidv4();
    const { rows } = await this.pool.query(
      `INSERT INTO skills (id, slug, title, domain, version, format, content, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, domain = EXCLUDED.domain, version = skills.version + 1, format = EXCLUDED.format, content = EXCLUDED.content, metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING *`,
      [id, input.slug, input.title, input.domain, input.version, input.format, input.content, JSON.stringify(input.metadata)]
    );
    return rows[0];
  }

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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        uuidv4(),
        input.title,
        input.diagnosis,
        input.branch_name,
        JSON.stringify(input.target_files),
        input.unified_diff,
        JSON.stringify(input.test_results),
        JSON.stringify(input.benchmark_before),
        JSON.stringify(input.benchmark_after),
        input.rollback_plan,
        input.status,
        input.auto_eligible,
      ]
    );
    return rows[0];
  }

  async updateUpgradeStatus(id: string, status: UpgradeStatus): Promise<SelfUpgradeRecord | null> {
    const { rows } = await this.pool.query('UPDATE self_upgrades SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [status, id]);
    return rows[0] || null;
  }

  async listDynamicApis(): Promise<DynamicApiRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM dynamic_apis ORDER BY created_at DESC');
    return rows;
  }

  async getDynamicApiBySlug(slug: string): Promise<DynamicApiRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM dynamic_apis WHERE slug = $1', [slug]);
    return rows[0] || null;
  }

  async upsertDynamicApi(input: Omit<DynamicApiRecord, 'id' | 'call_count' | 'created_at' | 'updated_at'>): Promise<DynamicApiRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO dynamic_apis (id, tenant_id, slug, name, description, method, input_schema, output_schema, handler_code, test_code, test_report, openapi_spec, rate_limit_rpm, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, method = EXCLUDED.method, input_schema = EXCLUDED.input_schema, output_schema = EXCLUDED.output_schema, handler_code = EXCLUDED.handler_code, test_code = EXCLUDED.test_code, test_report = EXCLUDED.test_report, openapi_spec = EXCLUDED.openapi_spec, rate_limit_rpm = EXCLUDED.rate_limit_rpm, enabled = EXCLUDED.enabled, updated_at = NOW()
       RETURNING *`,
      [
        uuidv4(),
        input.tenant_id,
        input.slug,
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
        input.enabled,
      ]
    );
    return rows[0];
  }

  async incrementDynamicApiCalls(slug: string): Promise<void> {
    await this.pool.query('UPDATE dynamic_apis SET call_count = call_count + 1 WHERE slug = $1', [slug]);
  }

  async toggleDynamicApi(slug: string, enabled: boolean): Promise<DynamicApiRecord | null> {
    const { rows } = await this.pool.query('UPDATE dynamic_apis SET enabled = $1, updated_at = NOW() WHERE slug = $2 RETURNING *', [enabled, slug]);
    return rows[0] || null;
  }

  async enqueueJob(input: Pick<BackgroundJobRecord, 'queue_name' | 'job_type' | 'payload'>): Promise<BackgroundJobRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO background_jobs (id, queue_name, job_type, payload, status) VALUES ($1, $2, $3, $4, 'queued') RETURNING *`,
      [uuidv4(), input.queue_name, input.job_type, JSON.stringify(input.payload)]
    );
    return rows[0];
  }

  async updateJob(id: string, patch: Partial<Pick<BackgroundJobRecord, 'status' | 'result' | 'error' | 'attempts' | 'finished_at'>>): Promise<void> {
    await this.pool.query(
      `UPDATE background_jobs SET status = COALESCE($1, status), result = COALESCE($2, result), error = COALESCE($3, error), attempts = COALESCE($4, attempts), finished_at = COALESCE($5, finished_at) WHERE id = $6`,
      [patch.status ?? null, patch.result ? JSON.stringify(patch.result) : null, patch.error ?? null, patch.attempts ?? null, patch.finished_at ?? null, id]
    );
  }

  async listJobs(limit = 30): Promise<BackgroundJobRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM background_jobs ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  async recordTelemetry(input: Omit<LlmTelemetryRecord, 'id' | 'created_at'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO llm_telemetry (id, tenant_id, provider, model, task_type, prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [uuidv4(), input.tenant_id, input.provider, input.model, input.task_type, input.prompt_tokens, input.completion_tokens, input.estimated_cost_usd, input.latency_ms, input.success, input.error_message]
    );
  }

  async listTelemetry(limit = 50): Promise<LlmTelemetryRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM llm_telemetry ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  async getTelemetrySummary() {
    const rows = await this.listTelemetry(500);
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
    await this.pool.query(
      `INSERT INTO audit_logs (id, tenant_id, actor, action, resource, status_code, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv4(), input.tenant_id, input.actor, input.action, input.resource, input.status_code, JSON.stringify(input.metadata)]
    );
  }

  async listAuditLogs(limit = 50): Promise<AuditLogRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1', [limit]);
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
}

async function seedInitialData(db: NeoDatabase): Promise<void> {
  const tenants = await db.listTenants();
  let defaultTenantId: string;
  if (tenants.length === 0) {
    const created = await db.createTenant({
      name: 'Neos Production Workspace',
      slug: 'neos-prod',
      workspace_language: 'en',
      webhook_url: null,
      webhook_secret: null,
      pii_redaction: false,
      rate_limit_rpm: 180,
    });
    defaultTenantId = created.id;
  } else {
    defaultTenantId = tenants[0].id;
  }

  const streams = await db.listTopicStreams();
  if (streams.length === 0) {
    const defaults: Array<{ topic: string; category: 'engineering' | 'business' | 'custom'; interval_minutes: number }> = [
      { topic: 'TypeScript 5 & Node.js 22 runtime optimization', category: 'engineering', interval_minutes: 60 },
      { topic: 'OWASP API Security Top 10 & Zero-Trust Gateways', category: 'engineering', interval_minutes: 120 },
      { topic: 'IFRS Double-Entry Accounting & SaaS Cash Runway KPIs', category: 'business', interval_minutes: 180 },
      { topic: 'Inventory Reorder Forecasting & Dead-Stock Analytics', category: 'business', interval_minutes: 180 },
    ];
    for (const s of defaults) {
      await db.createTopicStream(s);
    }
  }

  const skills = await db.listSkills();
  if (skills.length === 0) {
    await db.upsertSkill({
      slug: 'double-entry-ledger-audit',
      title: 'Double-Entry Ledger Reconciliation & Anomaly Audit',
      domain: 'business-finance',
      version: 1,
      format: 'markdown',
      content: `# Double-Entry Ledger Audit Skill\n1. Verify sum(debits) === sum(credits) across all journal batches.\n2. Compute Working Capital = Current Assets - Current Liabilities.\n3. Compute Cash Runway = Cash Balance / Monthly Net Burn.\n4. Flag out-of-balance entries, duplicate invoice hashes, and >3sigma expense spikes.`,
      metadata: { source: 'core-neos-playbook', verified: true },
    });
    await db.upsertSkill({
      slug: 'typescript-sandbox-testing',
      title: 'Plan-Code-Test-Fix Autonomous Verification Loop',
      domain: 'software-engineering',
      version: 1,
      format: 'markdown',
      content: `# Engineering Verification Loop\n1. Map symbol dependencies and affected interfaces before editing.\n2. Write deterministic node:test assertions covering edge cases and boundary inputs.\n3. Execute inside isolated VM/worktree sandbox.\n4. Inspect stack traces and iterate until 100% test pass rate.`,
      metadata: { source: 'core-engineering-playbook', verified: true },
    });
    await db.upsertSkill({
      slug: 'multilingual-neos-protocol',
      title: 'Multilingual Executive Response Protocol (EN/FA/AR/NL)',
      domain: 'neos-operations',
      version: 1,
      format: 'markdown',
      content: `# Multilingual Response Protocol\nDetect workspace language across English (en), Persian (fa), Arabic (ar), and Dutch (nl). Preserve financial figures, SKU codes, and JSON field keys verbatim while delivering executive narratives natively.`,
      metadata: { source: 'core-neos-playbook', verified: true },
    });
  }

  const memories = await db.listMemories({ limit: 1 });
  if (memories.length === 0) {
    const seedContent =
      'Double-entry accounting invariant: Every balanced journal entry must satisfy Total Debits == Total Credits. Discrepancies indicate unposted accruals, FX rounding drift, or partial batch ingestion.';
    await db.insertMemory({
      tenant_id: 'global',
      memory_type: 'semantic',
      topic: 'IFRS Double-Entry Accounting',
      title: 'Double-Entry Accounting Balance Invariant',
      content: seedContent,
      structured_facts: { rule: 'SUM(debits) == SUM(credits)', tolerance: 0.01 },
      source_url: 'https://www.ifrs.org/',
      reliability_score: 0.98,
      freshness_score: 0.96,
      embedding: deterministicTextEmbedding(seedContent),
    });

    const procContent =
      'Procedural lesson: Always validate dynamic custom API handler code inside an isolated VM context with strict wall-clock timeout and zero access to process.env before registering the HTTP route.';
    await db.insertMemory({
      tenant_id: 'global',
      memory_type: 'procedural',
      topic: 'API Forge Security',
      title: 'Sandboxed Validation Gate Before Dynamic Route Registration',
      content: procContent,
      structured_facts: { gate: 'vm_sandbox_100pct_test_pass', timeoutMs: 1500 },
      source_url: null,
      reliability_score: 1.0,
      freshness_score: 1.0,
      embedding: deterministicTextEmbedding(procContent),
    });
  }

  const apis = await db.listDynamicApis();
  if (apis.length === 0) {
    const handlerCode = `function handle(input) {
  const daysOverdue = Number(input.daysOverdue || 0);
  const amount = Number(input.amount || 0);
  const priorDefaults = Number(input.priorDefaults || 0);
  const score = Math.min(100, Math.round(daysOverdue * 1.4 + priorDefaults * 22 + Math.log10(Math.max(amount, 10)) * 8));
  const riskTier = score >= 75 ? 'critical' : score >= 45 ? 'elevated' : 'low';
  const action = riskTier === 'critical' ? 'escalate_collections_and_pause_credit' : riskTier === 'elevated' ? 'send_firm_reminder' : 'send_courtesy_reminder';
  return { invoiceId: input.invoiceId, riskScore: score, riskTier, recommendedAction: action, reminderDraft: 'Invoice ' + input.invoiceId + ' (' + amount + ' ' + (input.currency || 'USD') + ') is ' + daysOverdue + ' days overdue. Action: ' + action };
}`;
    const testCode = `test('scores overdue invoice accurately', () => {
  const res = handle({ invoiceId: 'INV-401', amount: 12000, currency: 'USD', daysOverdue: 45, priorDefaults: 1 });
  assert.equal(res.invoiceId, 'INV-401');
  assert.equal(res.riskTier, 'critical');
  assert.ok(res.riskScore >= 75);
});
test('low risk invoice stays low tier', () => {
  const res = handle({ invoiceId: 'INV-402', amount: 250, currency: 'USD', daysOverdue: 5, priorDefaults: 0 });
  assert.equal(res.riskTier, 'low');
});`;
    const inputSchema = {
      type: 'object',
      required: ['invoiceId', 'amount', 'daysOverdue'],
      properties: {
        invoiceId: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        daysOverdue: { type: 'number' },
        priorDefaults: { type: 'number' },
      },
    };
    const outputSchema = {
      type: 'object',
      properties: {
        invoiceId: { type: 'string' },
        riskScore: { type: 'number' },
        riskTier: { type: 'string' },
        recommendedAction: { type: 'string' },
        reminderDraft: { type: 'string' },
      },
    };
    await db.upsertDynamicApi({
      tenant_id: defaultTenantId,
      slug: 'overdue-invoice-scorer',
      name: 'Overdue Invoice Risk Scorer',
      description: 'Scores overdue Neos AR invoices and generates a prioritized reminder action.',
      method: 'POST',
      input_schema: inputSchema,
      output_schema: outputSchema,
      handler_code: handlerCode,
      test_code: testCode,
      test_report: {
        passed: 2,
        failed: 0,
        total: 2,
        durationMs: 4,
        details: ['PASS scores overdue invoice accurately', 'PASS low risk invoice stays low tier'],
      },
      openapi_spec: {
        path: '/api/v1/custom/overdue-invoice-scorer',
        method: 'POST',
        summary: 'Overdue Invoice Risk Scorer',
        requestBodySchema: inputSchema,
        responseSchema: outputSchema,
      },
      rate_limit_rpm: 120,
      enabled: true,
    });
  }
}

let dbInstance: NeoDatabase | null = null;

export async function getDb(): Promise<NeoDatabase> {
  if (dbInstance) return dbInstance;
  const db = env.databaseUrl ? new PostgresNeoDatabase(env.databaseUrl) : new SqliteNeoDatabase();
  await db.init();
  dbInstance = db;
  return db;
}
