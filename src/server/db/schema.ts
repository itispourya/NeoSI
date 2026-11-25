export type MemoryType = 'episodic' | 'semantic' | 'procedural';
export type TopicCategory = 'engineering' | 'business' | 'custom';
export type UpgradeStatus =
  | 'proposed'
  | 'sandbox_passed'
  | 'approved'
  | 'merged'
  | 'rejected'
  | 'rolled_back';

export type SupportedLanguage = 'en' | 'fa' | 'ar' | 'nl';

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  workspace_language: SupportedLanguage;
  webhook_url: string | null;
  webhook_secret: string | null;
  pii_redaction: boolean;
  rate_limit_rpm: number;
  created_at: string;
}

export interface ApiKeyRecord {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface MemoryRecord {
  id: string;
  tenant_id: string;
  memory_type: MemoryType;
  topic: string;
  title: string;
  content: string;
  structured_facts: Record<string, unknown>;
  source_url: string | null;
  reliability_score: number;
  freshness_score: number;
  embedding: number[];
  created_at: string;
}

export interface SkillRecord {
  id: string;
  slug: string;
  title: string;
  domain: string;
  version: number;
  format: 'markdown' | 'json';
  content: string;
  metadata: Record<string, unknown>;
  updated_at: string;
}

export interface TopicStreamRecord {
  id: string;
  topic: string;
  category: TopicCategory;
  enabled: boolean;
  interval_minutes: number;
  last_crawled_at: string | null;
  items_ingested: number;
  created_at: string;
}

export interface SelfUpgradeRecord {
  id: string;
  title: string;
  diagnosis: string;
  branch_name: string;
  target_files: string[];
  unified_diff: string;
  test_results: {
    passed: number;
    failed: number;
    total: number;
    durationMs: number;
    output: string;
  };
  benchmark_before: {
    accuracyScore: number;
    avgLatencyMs: number;
    passRate: number;
  };
  benchmark_after: {
    accuracyScore: number;
    avgLatencyMs: number;
    passRate: number;
  };
  rollback_plan: string;
  status: UpgradeStatus;
  auto_eligible: boolean;
  created_at: string;
  updated_at: string;
}

export interface DynamicApiRecord {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string;
  method: 'GET' | 'POST';
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  handler_code: string;
  test_code: string;
  test_report: {
    passed: number;
    failed: number;
    total: number;
    durationMs: number;
    details: string[];
  };
  openapi_spec: Record<string, unknown>;
  rate_limit_rpm: number;
  call_count: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface BackgroundJobRecord {
  id: string;
  queue_name: string;
  job_type: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  created_at: string;
  finished_at: string | null;
}

export interface LlmTelemetryRecord {
  id: string;
  tenant_id: string;
  provider: string;
  model: string;
  task_type: string;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost_usd: number;
  latency_ms: number;
  success: boolean;
  error_message: string | null;
  created_at: string;
}

export interface AuditLogRecord {
  id: string;
  tenant_id: string;
  actor: string;
  action: string;
  resource: string;
  status_code: number;
  metadata: Record<string, unknown>;
  created_at: string;
}
