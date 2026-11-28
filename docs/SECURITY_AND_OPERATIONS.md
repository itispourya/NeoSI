# Security & Production Operations

## 1. Security Controls

- **Fail-Closed Authentication (`src/server/security/auth.ts`)**:
  - Gateway endpoints require valid SHA-256 hashed scoped API keys (`neos_live_...`, with legacy `neo_live_...` support where configured).
  - Administrative console endpoints require HMAC-signed `neo_adm_...` session tokens backed by scrypt-hashed passcodes (`NEO_ADMIN_PASSCODE`) or explicit one-time claim guarded by `NEO_ADMIN_SETUP_TOKEN` (32+ bytes in production).
  - No fallback secrets are ever allowed when `NODE_ENV=production`.
- **Tenant Isolation & PII Redaction**:
  - Every tenant resource (memories, tasks, API keys, Neos capabilities, Neos approvals, audit logs, training jobs) is scoped by `tenant_id`.
  - When `tenant.pii_redaction` is enabled, emails, phone numbers, SSNs, and API tokens are redacted before storage, external inference, or training export.
- **SSRF & Outbound Fetch Hardening (`src/server/security/crypto.ts`)**:
  - `validateExternalUrlAsync` and `safeExternalFetch` block private RFC1918 ranges, loopback (`127.0.0.1`, `::1`), link-local/cloud metadata (`169.254.169.254`), and unsafe redirects, enforcing response byte limits and timeouts.
- **Prompt Injection Quarantine & Code Scanner**:
  - External URLs, feeds, Neos workspace context, and RAG memories are wrapped with `sanitizeUntrustedContent` before reaching inference prompts.
  - Candidate code modules in Layer C are rejected by `scanCandidateCodeSecurity` if they reference `eval`, `new Function`, `child_process`, `process.env`, prototype pollution vectors, or privileged Node built-ins, and protected core paths (`server.ts`, `migrations/`, `src/server/security/`) cannot be overwritten.

## 2. Deployment & Health Checks

- **Database Modes**:
  - Development / single-node: persistent SQLite WAL (`SQLITE_DB_PATH=./data/neo.db`), applying `migrations/001` through `006_intelligence_upgrade.sql` idempotently.
  - Production: PostgreSQL + `pgvector` (`DATABASE_URL`), with optional Redis/BullMQ (`REDIS_URL`).
- **Health Probes**:
  - `GET /api/v1/health` — Minimal unauthenticated liveness check (`{ status: "ok", service: "neo" }`).
  - `GET /api/v1/ready` — Database connectivity check returning `200` (`ready: true`) or `503` (`degraded`).
- **Validation Commands**:
  ```bash
  bun run lint
  bun run test
  bun run build
  ```
