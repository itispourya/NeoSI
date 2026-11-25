-- Neo Autonomous Intelligence Core Upgrade Migration v003 (Additive, Non-Destructive)

-- 1. Embedding space metadata, epistemic status, and retention policies on memories
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'neo-embed-local-v2';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_dim INTEGER NOT NULL DEFAULT 768;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS epistemic_status TEXT NOT NULL DEFAULT 'observation'
  CHECK (epistemic_status IN ('verified_fact', 'observation', 'assumption', 'prediction', 'opinion', 'uncertain'));
ALTER TABLE memories ADD COLUMN IF NOT EXISTS retention_policy TEXT NOT NULL DEFAULT 'long_term'
  CHECK (retention_policy IN ('permanent', 'long_term', 'session', 'ephemeral'));

-- 2. Embedding space metadata on knowledge graph entities
ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'neo-embed-local-v2';
ALTER TABLE entities ADD COLUMN IF NOT EXISTS embedding_dim INTEGER NOT NULL DEFAULT 768;

-- 3. Allow explicit 'partial' status on tasks when verification fails or dependencies remain incomplete
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending', 'planning', 'running', 'waiting_approval', 'completed', 'partial', 'failed', 'cancelled'));

-- 4. Autonomous Objectives persistence
CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  priority_score DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  value_score DOUBLE PRECISION NOT NULL DEFAULT 0.6,
  urgency_score DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  uncertainty_score DOUBLE PRECISION NOT NULL DEFAULT 0.4,
  progress_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'achieved', 'abandoned', 'blocked')),
  success_criteria TEXT NOT NULL DEFAULT '',
  compute_budget_ms INTEGER NOT NULL DEFAULT 30000,
  compute_used_ms INTEGER NOT NULL DEFAULT 0,
  linked_task_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked_research_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  knowledge_gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_evaluated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_objectives_tenant_status ON objectives (tenant_id, status, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_memories_embedding_space ON memories (tenant_id, embedding_model, embedding_dim);

INSERT INTO schema_migrations (version) VALUES ('003_neo_upgrade') ON CONFLICT DO NOTHING;
