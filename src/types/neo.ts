export type NavSection =
  | 'overview'
  | 'knowledge'
  | 'upgrades'
  | 'forge'
  | 'workbench'
  | 'security';

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  defaultModel?: string;
}

export interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  workspace_language: 'en' | 'fa' | 'ar' | 'nl';
  webhook_url: string | null;
  webhook_secret: string | null;
  pii_redaction: boolean;
  rate_limit_rpm: number;
  created_at: string;
}

export interface ApiKeyInfo {
  id: string;
  tenant_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface MemoryInfo {
  id: string;
  tenant_id: string;
  memory_type: 'episodic' | 'semantic' | 'procedural';
  topic: string;
  title: string;
  content: string;
  structured_facts: Record<string, unknown>;
  source_url: string | null;
  reliability_score: number;
  freshness_score: number;
  similarity?: number;
  created_at: string;
}

export interface SkillInfo {
  id: string;
  slug: string;
  title: string;
  domain: string;
  version: number;
  format: string;
  content: string;
  updated_at: string;
}

export interface TopicStreamInfo {
  id: string;
  topic: string;
  category: 'engineering' | 'business' | 'custom';
  enabled: boolean;
  interval_minutes: number;
  last_crawled_at: string | null;
  items_ingested: number;
}

export interface SelfUpgradeInfo {
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
  benchmark_before: { accuracyScore: number; avgLatencyMs: number; passRate: number };
  benchmark_after: { accuracyScore: number; avgLatencyMs: number; passRate: number };
  rollback_plan: string;
  status: string;
  auto_eligible: boolean;
  created_at: string;
}

export interface DynamicApiInfo {
  id: string;
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
}

export interface BackgroundJobInfo {
  id: string;
  queue_name: string;
  job_type: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  error: string | null;
  attempts: number;
  created_at: string;
  finished_at: string | null;
}

export interface AuditLogInfo {
  id: string;
  tenant_id: string;
  actor: string;
  action: string;
  resource: string;
  status_code: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface PromotedModuleInfo {
  id: string;
  name: string;
  filePath: string;
  promotedAt: string;
}

export interface AdminOverviewPayload {
  providers: {
    llm: ProviderStatus[];
    search: ProviderStatus[];
    storage: string;
    queue: string;
    localOnlyMode?: boolean;
  };
  lockState: { locked: boolean; source: 'env' | 'claimed' | 'unclaimed' };
  tenants: TenantInfo[];
  apiKeys: ApiKeyInfo[];
  memoryCounts: { total: number; episodic: number; semantic: number; procedural: number };
  recentMemories: MemoryInfo[];
  skills: SkillInfo[];
  streams: TopicStreamInfo[];
  upgrades: SelfUpgradeInfo[];
  promotedModules?: PromotedModuleInfo[];
  dynamicApis: DynamicApiInfo[];
  jobs: BackgroundJobInfo[];
  telemetrySummary: {
    totalCalls: number;
    successRate: number;
    totalTokens: number;
    totalCostUsd: number;
    avgLatencyMs: number;
    byProvider: Array<{
      provider: string;
      model: string;
      calls: number;
      tokens: number;
      costUsd: number;
      avgLatencyMs: number;
    }>;
  };
  auditLogs: AuditLogInfo[];
  repoSummary: {
    totalFiles: number;
    totalLines: number;
    topModules: Array<{ file: string; lines: number; exports: string[] }>;
  };
}
