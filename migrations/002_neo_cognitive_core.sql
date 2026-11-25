-- Neo Cognitive Core Schema Migration v002 (Additive, Non-Destructive)

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extend memories for 7 memory types, temporal validity, importance/confidence, versioning & soft delete
ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_memory_type_check;
ALTER TABLE memories ADD CONSTRAINT memories_memory_type_check
  CHECK (memory_type IN ('working', 'episodic', 'semantic', 'procedural', 'personal', 'organizational', 'temporal'));
ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance_score DOUBLE PRECISION NOT NULL DEFAULT 0.6;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0.8;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  user_id TEXT,
  title TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  goal TEXT NOT NULL,
  autonomy TEXT NOT NULL DEFAULT 'balanced',
  priority TEXT NOT NULL DEFAULT 'user_task',
  status TEXT NOT NULL CHECK (status IN ('pending', 'planning', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  plan JSONB NOT NULL DEFAULT '[]'::jsonb,
  checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  verification JSONB,
  error TEXT,
  budgets JSONB NOT NULL DEFAULT '{}'::jsonb,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  loop_signature_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  step_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  action_type TEXT NOT NULL,
  tool_id TEXT,
  depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  author TEXT,
  published_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reliability_score DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  quality_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash TEXT NOT NULL,
  injection_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  query TEXT NOT NULL,
  sub_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradictions JSONB NOT NULL DEFAULT '[]'::jsonb,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_url TEXT,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  contradicts_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT NOT NULL,
  input_schema JSONB NOT NULL,
  output_schema JSONB NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  required_scopes JSONB NOT NULL DEFAULT '["read"]'::jsonb,
  timeout_ms INTEGER NOT NULL DEFAULT 5000,
  execution_env TEXT NOT NULL DEFAULT 'host-guarded',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tool_executions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  task_id TEXT,
  tool_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  ok BOOLEAN NOT NULL DEFAULT TRUE,
  error TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  vram_gb DOUBLE PRECISION NOT NULL DEFAULT 0,
  ram_gb DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  modalities JSONB NOT NULL DEFAULT '["text","code"]'::jsonb,
  roles JSONB NOT NULL DEFAULT '["primary"]'::jsonb,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  benchmark_results JSONB NOT NULL DEFAULT '{}'::jsonb,
  deployment_status TEXT NOT NULL DEFAULT 'standby',
  health_status TEXT NOT NULL DEFAULT 'unknown',
  performance_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_validated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS model_deployments (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  runtime TEXT NOT NULL,
  endpoint TEXT,
  status TEXT NOT NULL,
  previous_model_id TEXT,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS model_evaluations (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  overall_score DOUBLE PRECISION NOT NULL,
  category_scores JSONB NOT NULL,
  avg_latency_ms DOUBLE PRECISION NOT NULL,
  tokens_per_sec DOUBLE PRECISION NOT NULL,
  passed_cases INTEGER NOT NULL,
  total_cases INTEGER NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS benchmarks (
  id TEXT PRIMARY KEY,
  suite_version TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metrics JSONB NOT NULL,
  passed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evolution_experiments (
  id TEXT PRIMARY KEY,
  layer TEXT NOT NULL CHECK (layer IN ('A', 'B', 'C', 'D')),
  title TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  config_before JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_after JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics_before JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics_after JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  base_model_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('lora', 'qlora', 'sft', 'dataset_only')),
  dataset_size INTEGER NOT NULL DEFAULT 0,
  dataset_path TEXT,
  adapter_version TEXT,
  privacy_filtered BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'internal_improvement',
  interval_ms INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_status TEXT,
  last_error TEXT,
  run_count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO schema_migrations (version) VALUES ('001_init'), ('002_neo_cognitive_core') ON CONFLICT DO NOTHING;
