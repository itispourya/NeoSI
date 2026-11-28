export type MemoryType =
  | 'working'
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'personal'
  | 'organizational'
  | 'temporal';

export type TopicCategory = 'engineering' | 'business' | 'custom';
export type UpgradeStatus =
  | 'proposed'
  | 'sandbox_passed'
  | 'approved'
  | 'promoted'
  | 'merged'
  | 'rejected'
  | 'rolled_back';

export type SupportedLanguage = 'en' | 'fa' | 'ar' | 'nl';

export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type TaskPriority =
  | 'urgent_maintenance'
  | 'user_task'
  | 'scheduled_task'
  | 'internal_improvement';

export type EpistemicStatus =
  | 'verified_fact'
  | 'observation'
  | 'assumption'
  | 'prediction'
  | 'opinion'
  | 'uncertain';

export type RetentionPolicy = 'permanent' | 'long_term' | 'session' | 'ephemeral';

export type ObjectiveStatus = 'active' | 'paused' | 'achieved' | 'abandoned' | 'blocked';

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

export interface ConversationRecord {
  id: string;
  tenant_id: string;
  user_id: string | null;
  title: string;
  language: SupportedLanguage;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  tenant_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata: Record<string, unknown>;
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
  importance_score: number;
  confidence_score: number;
  epistemic_status: EpistemicStatus;
  retention_policy: RetentionPolicy;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by: string | null;
  version: number;
  deleted_at: string | null;
  last_accessed_at: string | null;
  embedding: number[];
  embedding_model: string;
  embedding_dim: number;
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

export interface TaskRecord {
  id: string;
  tenant_id: string;
  goal: string;
  autonomy: 'low' | 'balanced' | 'high';
  priority: TaskPriority;
  status: TaskStatus;
  plan: Array<{ stepIndex: number; title: string; actionType: string; toolId?: string; dependsOn: number[] }>;
  checkpoint: Record<string, unknown>;
  result: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  error: string | null;
  budgets: { maxSteps: number; maxToolCalls: number; maxDurationMs: number };
  usage: { stepsExecuted: number; toolCalls: number; durationMs: number; retries: number };
  loop_signature_counts: Record<string, number>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskStepRecord {
  id: string;
  task_id: string;
  tenant_id: string;
  step_index: number;
  title: string;
  action_type: string;
  tool_id: string | null;
  depends_on: number[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface TaskEventRecord {
  id: string;
  task_id: string;
  tenant_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface KnowledgeSourceRecord {
  id: string;
  tenant_id: string;
  url: string;
  title: string;
  source_type: string;
  author: string | null;
  published_at: string | null;
  last_verified_at: string;
  reliability_score: number;
  quality_breakdown: {
    primarySource: number;
    authorCredibility: number;
    evidenceDensity: number;
    recency: number;
    methodology: number;
    corroboration: number;
    relevance: number;
  };
  content_hash: string;
  injection_flagged: boolean;
  created_at: string;
}

export interface ResearchReportRecord {
  id: string;
  tenant_id: string;
  query: string;
  sub_questions: string[];
  status: 'running' | 'completed' | 'failed';
  summary: string;
  findings: Array<{ claim: string; evidence: string; sourceUrl: string; reliability: number }>;
  contradictions: Array<{ topic: string; sourceA: string; sourceB: string; description: string }>;
  citations: Array<{ title: string; url: string; reliability: number; publishedAt?: string | null }>;
  confidence: number;
  created_at: string;
}

export interface GraphEntityRecord {
  id: string;
  tenant_id: string;
  name: string;
  entity_type: string;
  aliases: string[];
  attributes: Record<string, unknown>;
  confidence: number;
  embedding: number[];
  embedding_model?: string;
  embedding_dim?: number;
  created_at: string;
  updated_at: string;
}

export interface GraphRelationshipRecord {
  id: string;
  tenant_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  properties: Record<string, unknown>;
  source_url: string | null;
  confidence: number;
  valid_from: string | null;
  valid_to: string | null;
  contradicts_id: string | null;
  created_at: string;
}

export interface ToolRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  risk_level: 'low' | 'medium' | 'high';
  required_scopes: string[];
  timeout_ms: number;
  execution_env: string;
  enabled: boolean;
  updated_at: string;
}

export interface ToolExecutionRecord {
  id: string;
  tenant_id: string;
  task_id: string | null;
  tool_id: string;
  actor: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  ok: boolean;
  error: string | null;
  duration_ms: number;
  created_at: string;
}

export interface ModelRecord {
  id: string;
  name: string;
  version: string;
  runtime: 'embedded' | 'ollama' | 'vllm' | 'tensorrt-llm' | 'transformers' | 'custom-llm';
  architecture: string;
  source_repo: string;
  license: string;
  weight_location: string | null;
  checksum_sha256: string | null;
  download_status: 'ready' | 'available' | 'downloading' | 'failed';
  quantization: string;
  context_length: number;
  vram_gb: number;
  ram_gb: number;
  modalities: string[];
  roles: string[];
  capabilities: {
    toolCalling: boolean;
    reasoning: number;
    coding: number;
    multilingual: number;
    persian: number;
  };
  benchmark_results: Record<string, unknown>;
  deployment_status: 'active' | 'standby' | 'failed' | 'rolled_back';
  health_status: 'healthy' | 'degraded' | 'offline' | 'unknown';
  performance_metrics: {
    avgLatencyMs?: number;
    tokensPerSec?: number;
    calls?: number;
  };
  last_validated_at: string | null;
  created_at: string;
}

export interface ModelEvaluationRecord {
  id: string;
  model_id: string;
  suite_version: string;
  overall_score: number;
  category_scores: Record<string, number>;
  avg_latency_ms: number;
  tokens_per_sec: number;
  passed_cases: number;
  total_cases: number;
  details: Array<{
    id: string;
    category: string;
    prompt: string;
    passed: boolean;
    score: number;
    latencyMs: number;
    reason: string;
  }>;
  created_at: string;
}

export interface EvolutionExperimentRecord {
  id: string;
  layer: 'A' | 'B' | 'C' | 'D';
  title: string;
  hypothesis: string;
  config_before: Record<string, unknown>;
  config_after: Record<string, unknown>;
  metrics_before: Record<string, unknown>;
  metrics_after: Record<string, unknown>;
  status: string;
  created_at: string;
}

export interface TrainingJobRecord {
  id: string;
  tenant_id: string;
  base_model_id: string;
  method: 'lora' | 'qlora' | 'sft' | 'dataset_only';
  dataset_size: number;
  dataset_path: string | null;
  adapter_version: string | null;
  privacy_filtered: boolean;
  status: string;
  metrics: Record<string, unknown>;
  created_at: string;
  finished_at: string | null;
}

export interface ScheduledJobRecord {
  id: string;
  name: string;
  job_kind: string;
  priority: TaskPriority;
  interval_ms: number;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  run_count: number;
}

export interface ObjectiveRecord {
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
  status: ObjectiveStatus;
  success_criteria: string;
  compute_budget_ms: number;
  compute_used_ms: number;
  linked_task_ids: string[];
  linked_research_ids: string[];
  knowledge_gaps: string[];
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
}
