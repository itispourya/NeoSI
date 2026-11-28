# NeoSI — Complete Intelligence Architecture

## 1. Design Philosophy
NeoSI is a self-hosted, provider-independent cognitive and agent runtime built to serve as the primary AI intelligence engine for **Neos Cloud OS** and compatible external clients. It runs on open-source local inference runtimes (`ollama`, `vllm`, `tensorrt-llm`, `transformers`, `custom-llm`) with a deterministic CPU-native `embedded` fallback, persistent hybrid memory, policy-governed knowledge acquisition, verifiable evolution, and strict multi-tenant security.

## 2. Layered System Architecture

```
+-----------------------------------------------------------------------------+
|                        Clients & Workspaces (Neos / SDK / UI)               |
|  Neos Cloud OS  |  @neo/ai-sdk  |  @neos/ai-sdk  |  OpenAI Clients  | Admin |
+-----------------------------------------------------------------------------+
                                      |
+-----------------------------------------------------------------------------+
|                          Zero-Trust API Gateway                             |
|  Scoped SHA-256 Bearer Keys (neos_live_*)  |  Signed Admin Tokens (neo_adm_) |
|  Per-Tenant Rate Limits  |  Tenant Isolation  |  PII Redaction  |  CORS     |
+-----------------------------------------------------------------------------+
                                      |
+-----------------------------------------------------------------------------+
|                     Deep Neos Integration & Tool Runtime                    |
|  Neos Contract v1.0.0  |  Capability Registry  |  Human Confirmation Queue  |
|  Signed HMAC Webhooks  |  Standardized ToolRegistry  |  MCP JSON-RPC        |
+-----------------------------------------------------------------------------+
                                      |
+-----------------------------------------------------------------------------+
|                         Cognitive & Agent Core                              |
|  ReasoningEngine (Intent, Policy, RAG, Critic)  |  Adaptive TaskPlanner     |
|  Durable AgentRuntime (Checkpoints, Failure Classification, Replanning)     |
|  Priority-Aware AutonomousScheduler (Idle-Only Background Cycles)           |
+-----------------------------------------------------------------------------+
          |                                                   |
+-----------------------------------------+   +-------------------------------+
|     Policy-Governed Memory & Knowledge  |   |   Resilient Neural Compute    |
|  7 Memory Layers + Epistemic Provenance |   |  LlmRouter (Privacy/Cost/SLO) |
|  Hybrid Vector + BM25 + RRF Retrieval   |   |  CircuitBreakers + Retry/429  |
|  RSS/Atom/GitHub Feeds + ETag/SHA Dedup |   |  SSE Stream + Tools + JSON    |
|  Multilingual Normalization (en/fa/ar/nl|   |  ModelRegistry & Discovery    |
+-----------------------------------------+   +-------------------------------+
          |                                                   |
+-----------------------------------------------------------------------------+
|                   Hybrid Persistence & Isolated Execution                   |
|  PostgreSQL + pgvector (Prod) / SQLite WAL (Dev)  |  Optional Redis/BullMQ  |
|  Subprocess / Docker Sandbox  |  System Eval Suite + Layer 3 Policies       |
+-----------------------------------------------------------------------------+
```

## 3. Core Subsystems

1. **Resilient Neural Compute & Routing (`src/server/inference/`, `src/server/llm/`)**
   - Multi-provider adapters (`ollama`, `vllm`, `tensorrt-llm`, `transformers`, `custom-llm`, and deterministic CPU `embedded`) supporting streaming deltas, OpenAI-style tool calls, JSON schema structured outputs, abort-signal cancellation, and live runtime model discovery (`POST /api/v1/models/discover`).
   - `LlmRouter` routes by privacy policy (`local_only` / `hybrid`), tool-calling support, latency SLOs, token-cost estimation, and `CircuitBreakerRegistry` health.
   - `withRetryAndBackoff` respects HTTP `Retry-After` headers on `429` responses and isolates non-transient `4xx`/abort errors.

2. **Cognitive Reasoning, Planning & Durable Agents (`src/server/cognitive/`, `src/server/agent/`)**
   - `ReasoningEngine` loads active **Layer 3 Behavioral Policies**, normalizes multilingual queries (`en`, `fa`, `ar`, `nl`, plus `NEO_EXTRA_LANGUAGES_JSON`), extracts intents, retrieves policy-filtered RAG context with provenance labels, executes bounded tool loops, and verifies responses with `CriticEngine`.
   - `TaskPlanner` supports adaptive model-assisted planning (schema/scope/risk validated) with deterministic fallback and bounded `replanOnFailure` recovery.
   - `AgentRuntime` classifies failures (`transient`, `rate_limited`, `timeout`, `permission_denied`, `invalid_input`, `fatal`), compresses accumulated evidence within token budgets, and checkpoints `tasks`, `task_steps`, and `task_events`.

3. **Policy-Governed Knowledge & Memory (`src/server/knowledge/`, `src/server/search/`)**
   - 7 memory layers (`working`, `episodic`, `semantic`, `procedural`, `personal`, `organizational`, `temporal`) with validity windows, `epistemic_status` (`verified_fact`, `observation`, `opinion`, `prediction`), and supersession tracking.
   - Continuous feed ingestion (`RSS`, `Atom`, `github_releases:owner/repo`) using HTTP `ETag` / `If-Modified-Since` conditional polling, SHA-256 `content_hash` deduplication, DNS-pinned SSRF checks, and domain allow/block policies.

4. **Controlled Self-Evaluation & Evolution (`src/server/evolution/`, `src/server/inference/evaluator.ts`)**
   - Reproducible `SystemEvalSuite` (`sys-eval-v2`) measuring accuracy, ground-truth/citation compliance, policy compliance, and latency across multi-language test cases.
   - **Layer 3 Behavioral Policies** (`behavioral_policies`): candidate policies undergo baseline-vs-candidate evaluation before `candidate` -> `active` promotion or one-click rollback.
   - **Layer C** static security scanning + isolated sandbox verification (`runner.ts`); **Layer D** privacy-redacted JSONL dataset preparation (`dataset_only` boundary — no fabricated live weight training).

5. **Deep Neos Integration (`src/server/neos/`, `src/server/routes/neos.ts`)**
   - Standardized integration contract (`GET /api/v1/neos/contract`) with tenant-scoped capability manifests, schema validation, workspace context ingestion, HMAC-SHA256 webhook callbacks, and mandatory human confirmation gates (`30m` TTL) for financial/destructive capabilities.

See also:
- [Providers & Routing](PROVIDERS_AND_ROUTING.md)
- [OpenAI Compatibility & API Reference](API_AND_OPENAI.md)
- [Knowledge Governance & Continuous Learning](KNOWLEDGE_AND_LEARNING.md)
- [Deep Neos Integration Contract](NEOS_INTEGRATION.md)
- [Security & Operations](SECURITY_AND_OPERATIONS.md)
