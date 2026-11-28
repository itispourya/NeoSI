# NeoSI — Sovereign Cognitive & Neos AI Platform

NeoSI is a self-hosted, provider-independent cognitive and agent runtime for local LLM inference, OpenAI-compatible serving, durable tool execution, policy-governed knowledge acquisition, controlled self-evaluation, and deep integration with **Neos Cloud OS**.

## What is included

- **Resilient multi-runtime inference & routing** — Adapters for `ollama`, `vllm`, `tensorrt-llm`, `transformers`, `custom-llm`, and CPU-native `embedded` fallback with `LlmRouter`, per-runtime circuit breakers, `429 Retry-After` exponential backoff, context-window trimming, live model discovery, and streaming cancellation.
- **Full OpenAI-compatible gateway (`/v1/*` & `/api/v1/*`)** — `/v1/models` and `/v1/chat/completions` supporting streaming SSE chunks, `tools` / `tool_choice`, `response_format` (`json_object` / `json_schema`), multi-turn `tool` roles, connection probe fast-paths, and `en`/`fa`/`ar`/`nl` conversation directives.
- **Cognitive engine & durable agents** — Policy-driven `ReasoningEngine`, adaptive model-assisted + deterministic fallback `TaskPlanner`, failure-classified `AgentRuntime` with evidence compression and replanning, `CriticEngine`, and idle-aware `AutonomousScheduler`.
- **Policy-governed memory & continuous knowledge** — 7-layer memory with `epistemic_status` and provenance tags, multilingual query normalization (`fa`/`ar`/`nl`/`en` + `NEO_EXTRA_LANGUAGES_JSON`), RSS/Atom/GitHub Releases feed polling with `ETag` + SHA-256 deduplication, domain allow/block governance, and RAG retrieval diagnostics.
- **Self-evaluation & Layer 3 Behavioral Policies** — Reproducible `SystemEvalSuite` (`sys-eval-v2`), candidate-vs-baseline Behavioral Policy experiments (`candidate` -> `active` -> rollback), Layer C static security checks, and Layer D privacy-redacted JSONL dataset preparation.
- **Deep Neos Cloud OS integration** — Contract manifest (`/api/v1/neos/contract`), tenant capability sync, schema-validated action dispatch with HMAC-signed webhooks, workspace context ingestion, and mandatory human confirmation queues (`neos_approvals`) for financial/destructive actions.
- **Zero-trust security** — Scoped SHA-256 API keys (`neos_live_...`), HMAC-signed admin console sessions (`neo_adm_...`), strict tenant isolation, PII redaction, DNS-pinned SSRF protection, and prompt-injection wrapping.

## Important capability boundaries

- **Embedded runtime**: Neo's built-in CPU `embedded` runtime is a deterministic symbolic/RAG synthesis core, **not** a neural generative LLM. Connect `ollama`, `vllm`, `tensorrt-llm`, `transformers`, or `custom-llm` for full generative language inference.
- **Layer D training preparation**: Training jobs prepare privacy-filtered JSONL datasets (`dataset_only` execution mode) for external LoRA/QLoRA trainers; NeoSI does not claim to fine-tune neural weights in-process.
- **Sandbox execution**: In production (`NODE_ENV=production`), `NEO_SANDBOX_MODE=subprocess` disables arbitrary dynamic code execution; Docker isolation requires an explicitly configured Docker daemon.

## Documentation

- [System Architecture](docs/ARCHITECTURE.md)
- [Providers, Resilience & Routing](docs/PROVIDERS_AND_ROUTING.md)
- [API & OpenAI Compatibility Reference](docs/API_AND_OPENAI.md)
- [Knowledge Governance & Continuous Learning](docs/KNOWLEDGE_AND_LEARNING.md)
- [Deep Neos Integration Contract](docs/NEOS_INTEGRATION.md)
- [Security & Operations](docs/SECURITY_AND_OPERATIONS.md)

## Quickstart & Validation

```bash
cp .env.example .env
bun install
bun run dev
```

Open `http://localhost:3000`, claim or sign in with your admin passcode, configure a runtime (or test `embedded`), and generate scoped `neos_live_...` keys for Neos or OpenAI clients.

```bash
bun run lint
bun run test
bun run build
```
