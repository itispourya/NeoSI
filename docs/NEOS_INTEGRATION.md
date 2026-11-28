# Deep Neos Cloud OS Integration Contract

NeoSI integrates with **Neos Cloud OS** at two levels:
1. **Standard OpenAI-Compatible Inference** (`/v1/models`, `/v1/chat/completions`) for Neos System AI and user BYOK selection.
2. **Deep Bidirectional Neos Protocol** (`/api/v1/neos/*`, `src/server/neos/integration.ts`) for module capability registration, workspace state grounding, and confirmation-gated actions.

## 1. Contract & Authentication (`GET /api/v1/neos/contract`)

- Contract version: `1.0.0`
- Authentication: `Authorization: Bearer neos_live_...` (or `X-API-Key: neos_live_...`) bound to a single `tenant_id`.
- Cross-tenant isolation is strictly enforced on all queries, capability mutations, approval lookups, and confirmations.

## 2. Capability Sync & Tool Discovery

- `POST /api/v1/neos/capabilities/sync` (`write`):
  Registers or updates tenant Neos capabilities (`module_name`, `capability_id`, `title`, `description`, `endpoint_url`, `required_scopes`, `risk_level`, `requires_confirmation`, `input_schema`, `output_schema`).
  - Optional `endpoint_url` values are DNS-validated via `validateExternalUrlAsync`; private/loopback/metadata targets are rejected.
- `GET /api/v1/neos/capabilities` (`read`) and `DELETE /api/v1/neos/capabilities/:id` (`write`):
  Inspect or remove registered capabilities for the caller's tenant.
- Built-in agent tools (`neos_discover_capabilities`, `neos_propose_action` in `src/server/tools/registry.ts`) allow Neo's cognitive runtime to inspect and invoke tenant Neos modules safely.

## 3. Workspace Context Ingestion

- `POST /api/v1/neos/context` (`write`):
  Accepts structured Neos workspace snapshots (`moduleName`, `title`, `summary`, `records`), applies tenant PII redaction when `tenant.pii_redaction` is enabled, wraps untrusted content with prompt-injection quarantine (`sanitizeUntrustedContent`), and stores persistent `organizational` memory for subsequent RAG retrieval.

## 4. Schema-Validated Actions & Human Confirmation Gate

- `POST /api/v1/neos/actions/execute` (`write`):
  1. Verifies capability existence and enabled status within the caller's tenant (`404` otherwise).
  2. Verifies caller scopes satisfy `capability.required_scopes` (`403` otherwise).
  3. Validates `payload` against `capability.input_schema` (`400` on schema mismatch).
  4. Checks risk policy (`requires_confirmation === true`, `risk_level === 'high'`, or financial/destructive keywords such as `payment`, `transfer`, `refund`, `payroll`, `ledger.commit`, `invoice.post`, `delete`, `purge`, `wire`).
  5. **High-risk actions** do **not** execute immediately: they create a `pending` record in `neos_approvals` with a 30-minute `expires_at` window and return `202 Accepted` (`status: "confirmation_required"`).
  6. **Low/medium-risk actions** dispatch immediately (via HMAC-SHA256 signed `X-Neo-Signature` webhook if `endpoint_url` is set, or validated local dispatch metadata otherwise).
- `GET /api/v1/neos/approvals` (`read`), `POST /api/v1/neos/approvals/:id/confirm` (`write`), `POST /api/v1/neos/approvals/:id/reject` (`write`):
  Confirming verifies tenant ownership, `pending` status, expiration (`410` if expired), and required scopes (`403` if missing) before dispatching or finalizing the action.
