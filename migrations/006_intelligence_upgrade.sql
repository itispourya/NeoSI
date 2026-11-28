-- NeoSI Complete Intelligence Architecture Upgrade v006 (Additive, Non-Destructive)

-- 1. Incremental HTTP & revalidation metadata on knowledge_sources
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS etag TEXT;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS last_modified TEXT;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS review_at TIMESTAMPTZ;

-- 2. Trusted / blocked domains and RSS/Atom/GitHub Releases feed policies
CREATE TABLE IF NOT EXISTS knowledge_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'global',
  rule_type TEXT NOT NULL CHECK (rule_type IN ('trusted_domain', 'blocked_domain', 'feed_source')),
  pattern TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'domain',
  min_reliability DOUBLE PRECISION NOT NULL DEFAULT 0.55,
  revalidation_hours INTEGER NOT NULL DEFAULT 168,
  etag TEXT,
  last_modified TEXT,
  last_fetched_at TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_policies_tenant_type ON knowledge_policies (tenant_id, rule_type, enabled);

-- 3. Layer 3 Versioned Behavioral Learning Policies
CREATE TABLE IF NOT EXISTS behavioral_policies (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'rolled_back', 'rejected')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  baseline_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidate_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  hypothesis TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_behavioral_policies_status ON behavioral_policies (status, version DESC);

-- 4. Deep Neos Capability & Module Discovery Registry (Tenant-Isolated)
CREATE TABLE IF NOT EXISTS neos_capabilities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  module_name TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  endpoint_url TEXT,
  required_scopes JSONB NOT NULL DEFAULT '["read"]'::jsonb,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  requires_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
  input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  contract_version TEXT NOT NULL DEFAULT '1.0',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, capability_id)
);

CREATE INDEX IF NOT EXISTS idx_neos_capabilities_tenant ON neos_capabilities (tenant_id, module_name, enabled);

-- 5. Neos Human Confirmation Gate for Financial & Destructive Actions
CREATE TABLE IF NOT EXISTS neos_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_scopes JSONB NOT NULL DEFAULT '["write"]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'expired')),
  decision_by TEXT,
  decision_note TEXT,
  execution_result JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_neos_approvals_tenant_status ON neos_approvals (tenant_id, status, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('006_intelligence_upgrade') ON CONFLICT DO NOTHING;
