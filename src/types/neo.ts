export type NavSection =
  | 'overview'
  | 'chat'
  | 'tasks'
  | 'workbench'
  | 'memory'
  | 'models'
  | 'tools'
  | 'evolution'
  | 'security';

export interface ConversationInfo {
  id: string;
  tenant_id: string;
  user_id: string | null;
  title: string;
  language: 'en' | 'fa' | 'ar' | 'nl';
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageInfo {
  id: string;
  conversation_id: string;
  tenant_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface HardwareProfileInfo {
  cpuModel: string;
  cpuCores: number;
  totalRamGb: number;
  freeRamGb: number;
  diskFreeGb: number;
  gpus: Array<{ index: number; name: string; totalVramGb: number; freeVramGb: number; utilizationPct: number }>;
  totalVramGb: number;
  hasGpu: boolean;
  recommendedProfile: 'cpu-development' | 'single-gpu' | 'multi-gpu';
}

export interface RuntimeHealthInfo {
  modelId: string;
  runtime: string;
  status: 'healthy' | 'degraded' | 'offline' | 'unknown';
  endpoint: string;
  latencyMs: number;
  message: string;
  checkedAt: string;
}

export interface CapabilityInfo {
  modality: string;
  supported: boolean;
  engine: string;
  notes: string;
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

export type MemoryLayerType =
  | 'working'
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'personal'
  | 'organizational'
  | 'temporal';

export interface MemoryInfo {
  id: string;
  tenant_id: string;
  memory_type: MemoryLayerType;
  topic: string;
  title: string;
  content: string;
  structured_facts: Record<string, unknown>;
  source_url: string | null;
  reliability_score: number;
  freshness_score: number;
  importance_score: number;
  confidence_score: number;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by?: string | null;
  epistemic_status?: string;
  version: number;
  similarity?: number;
  hybridScore?: number;
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
  metadata?: Record<string, unknown>;
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

export interface TaskInfo {
  id: string;
  tenant_id: string;
  goal: string;
  autonomy: 'low' | 'balanced' | 'high';
  priority: string;
  status: 'pending' | 'planning' | 'running' | 'waiting_approval' | 'completed' | 'partial' | 'failed' | 'cancelled';
  plan: Array<{ stepIndex: number; title: string; actionType: string; toolId?: string; dependsOn: number[] }>;
  checkpoint: Record<string, unknown>;
  result: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  error: string | null;
  budgets: { maxSteps: number; maxToolCalls: number; maxDurationMs: number };
  usage: { stepsExecuted: number; toolCalls: number; durationMs: number; retries: number };
  created_at: string;
  completed_at: string | null;
}

export interface ObjectiveInfo {
  id: string;
  tenant_id: string;
  title: string;
  description: string;
  category: string;
  priority_score: number;
  value_score: number;
  urgency_score: number;
  uncertainty_score: number;
  progress_pct: number;
  status: 'active' | 'paused' | 'achieved' | 'abandoned' | 'blocked';
  success_criteria: string;
  created_at: string;
  updated_at: string;
}

export interface ToolInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk_level: 'low' | 'medium' | 'high';
  required_scopes: string[];
  timeout_ms: number;
  execution_env: string;
  enabled: boolean;
}

export interface ToolExecutionInfo {
  id: string;
  tenant_id: string;
  task_id: string | null;
  tool_id: string;
  actor: string;
  ok: boolean;
  error: string | null;
  duration_ms: number;
  created_at: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  version: string;
  runtime: string;
  architecture: string;
  source_repo: string;
  license: string;
  quantization: string;
  context_length: number;
  vram_gb: number;
  ram_gb: number;
  roles: string[];
  download_status: string;
  deployment_status: string;
  health_status: string;
  benchmark_results: Record<string, unknown>;
  performance_metrics: { avgLatencyMs?: number; tokensPerSec?: number; calls?: number };
  last_validated_at: string | null;
}

export interface ModelEvaluationInfo {
  id: string;
  model_id: string;
  suite_version: string;
  overall_score: number;
  category_scores: Record<string, number>;
  avg_latency_ms: number;
  tokens_per_sec: number;
  passed_cases: number;
  total_cases: number;
  details: Array<{ id: string; category: string; passed: boolean; score: number; latencyMs: number; reason: string }>;
  created_at: string;
}

export interface ResearchReportInfo {
  id: string;
  query: string;
  sub_questions: string[];
  status: string;
  summary: string;
  findings: Array<{ claim: string; evidence: string; sourceUrl: string; reliability: number }>;
  contradictions: Array<{ topic: string; sourceA: string; sourceB: string; description: string }>;
  citations: Array<{ title: string; url: string; reliability: number; publishedAt?: string | null }>;
  confidence: number;
  created_at: string;
}

export interface KnowledgeSourceInfo {
  id: string;
  url: string;
  title: string;
  source_type: string;
  reliability_score: number;
  injection_flagged: boolean;
  last_verified_at: string;
}

export interface GraphEntityInfo {
  id: string;
  name: string;
  entity_type: string;
  aliases: string[];
  confidence: number;
}

export interface GraphRelationshipInfo {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  confidence: number;
  contradicts_id: string | null;
}

export interface SelfUpgradeInfo {
  id: string;
  title: string;
  diagnosis: string;
  branch_name: string;
  target_files: string[];
  unified_diff: string;
  test_results: { passed: number; failed: number; total: number; durationMs: number; output: string };
  benchmark_before: { accuracyScore: number; avgLatencyMs: number; passRate: number };
  benchmark_after: { accuracyScore: number; avgLatencyMs: number; passRate: number };
  rollback_plan: string;
  status: string;
  auto_eligible: boolean;
  created_at: string;
}

export interface ScheduledJobInfo {
  id: string;
  name: string;
  job_kind: string;
  priority: string;
  interval_ms: number;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  run_count: number;
}

export interface EvolutionExperimentInfo {
  id: string;
  layer: string;
  title: string;
  hypothesis: string;
  metrics_before: Record<string, unknown>;
  metrics_after: Record<string, unknown>;
  status: string;
  created_at: string;
}

export interface TrainingJobInfo {
  id: string;
  base_model_id: string;
  method: string;
  dataset_size: number;
  dataset_path: string | null;
  adapter_version: string | null;
  privacy_filtered: boolean;
  status: string;
  metrics: Record<string, unknown>;
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
  test_report: { passed: number; failed: number; total: number; durationMs: number; details: string[] };
  openapi_spec: Record<string, unknown>;
  rate_limit_rpm: number;
  call_count: number;
  enabled: boolean;
  created_at: string;
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

export interface AdminOverviewPayload {
  subsystems: {
    runtimes: Array<{ id: string; name: string; configured: boolean; endpoint: string }>;
    search: Array<{ id: string; name: string; configured: boolean }>;
    storage: string;
    queue: string;
    sandbox: string;
    runtimeDefault: string;
  };
  capabilities: CapabilityInfo[];
  hardware: HardwareProfileInfo;
  runtimeHealth: RuntimeHealthInfo[];
  lockState: { locked: boolean; source: 'env' | 'claimed' | 'unclaimed' };
  tenants: TenantInfo[];
  apiKeys: ApiKeyInfo[];
  memoryCounts: Record<MemoryLayerType | 'total', number>;
  recentMemories: MemoryInfo[];
  skills: SkillInfo[];
  streams: TopicStreamInfo[];
  upgrades: SelfUpgradeInfo[];
  experiments: EvolutionExperimentInfo[];
  trainingJobs: TrainingJobInfo[];
  promotedModules: Array<{ id: string; name: string; filePath: string; promotedAt: string }>;
  dynamicApis: DynamicApiInfo[];
  jobs: Array<{ id: string; job_type: string; status: string; attempts: number; created_at: string; error: string | null }>;
  scheduledJobs: ScheduledJobInfo[];
  tasks: TaskInfo[];
  objectives?: ObjectiveInfo[];
  tools: ToolInfo[];
  toolExecutions: ToolExecutionInfo[];
  models: ModelInfo[];
  modelCompatibility: Array<{
    id: string;
    name: string;
    runtime: string;
    license: string;
    vramGb: number;
    ramGb: number;
    compatible: boolean;
    compatibilityReason: string;
    deploymentStatus: string;
    downloadStatus: string;
  }>;
  evaluations: ModelEvaluationInfo[];
  researchReports: ResearchReportInfo[];
  knowledgeSources: KnowledgeSourceInfo[];
  graph: { entities: GraphEntityInfo[]; relationships: GraphRelationshipInfo[] };
  telemetrySummary: {
    totalCalls: number;
    successRate: number;
    totalTokens: number;
    totalCostUsd: number;
    avgLatencyMs: number;
    byProvider: Array<{ provider: string; model: string; calls: number; tokens: number; costUsd: number; avgLatencyMs: number }>;
  };
  auditLogs: AuditLogInfo[];
  repoSummary: {
    totalFiles: number;
    totalLines: number;
    topModules: Array<{ file: string; lines: number; exports: string[] }>;
  };
}
