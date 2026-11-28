# Providers, Resilience & Intelligent Routing

## 1. Supported Inference Runtimes

| Runtime | Endpoint Env Vars | Capabilities | Notes |
| --- | --- | --- | --- |
| `ollama` | `NEO_OLLAMA_BASE_URL` | Streaming, Tools, JSON Schema, Discovery (`/api/tags`) | Ideal for single-GPU or CPU local workstations |
| `vllm` | `NEO_VLLM_BASE_URL` | OpenAI Streaming, Tools, JSON Schema, Discovery (`/v1/models`) | High-throughput GPU serving |
| `tensorrt-llm` | `NEO_TENSORRT_LLM_BASE_URL` | Streaming, JSON output, Discovery | High-performance NVIDIA TensorRT deployments |
| `transformers` | `NEO_HF_INFERENCE_BASE_URL` | OpenAI-compatible text/chat generation | Local TGI / Hugging Face inference servers |
| `custom-llm` | `NEO_INFERENCE_URL`, `NEO_INFERENCE_API_KEY` | OpenAI-compatible `/chat/completions`, `/models`, Streaming, Tools, JSON | Any self-hosted or private OpenAI-compatible gateway |
| `embedded` | Built-in CPU | Deterministic arithmetic, RAG synthesis, tool hints, JSON templates | Always-on zero-dependency fallback; **not** a generative neural LLM |

## 2. Resilience Primitives (`src/server/inference/resilience.ts`)

1. **Circuit Breakers (`CircuitBreakerRegistry`)**
   - Tracks per-runtime health across `closed`, `open`, and `half_open` states (default threshold: 3 failures, reset window: 20s).
   - `embedded` remains exempt from tripping so deterministic fallback always stays reachable.
   - Live circuit-breaker state is exposed via `GET /api/v1/models/health` and `GET /api/admin/overview`.

2. **Exponential Backoff & `Retry-After` Compliance (`withRetryAndBackoff`)**
   - Retries transient transport failures (`408`, `429`, `5xx`, `ECONNRESET`, `ETIMEDOUT`) with jittered exponential backoff.
   - Parses numeric seconds or HTTP-date `Retry-After` headers on `429` responses (capped cleanly) and respects caller `AbortSignal` without sleeping after cancellation.
   - Fails fast on non-transient client errors (`400`, `401`, `403`, `404`, `422`) and `AbortError`.

3. **Context Window Compression & Cost Estimation**
   - `trimPromptToContextWindow` preserves leading workspace directives and the trailing user query when total token estimates exceed `maxContextTokens - reserveOutputTokens`.
   - `estimateInferenceCostUsd` computes per-call USD cost from registered `costPer1kInputUsd` / `costPer1kOutputUsd` metadata (returns `0` for local `embedded`).

## 3. Policy-Aware Model Routing (`src/server/llm/router.ts`)

`LlmRouter.selectCandidates` ranks registered ready models plus fallback options using:
- **Explicit target**: `preferredModelId` / `preferredRuntime` (with `strictTarget: true` forbidding silent fallback during benchmarks).
- **Privacy mode**: `local_only` excludes remote/custom gateways when workspace PII rules forbid external dispatch.
- **Capability filters**: `requireToolCalling` and `requireJsonSchema` prioritize runtimes supporting structured function calls/JSON output.
- **Health & Cost**: penalizes open circuit breakers, factors measured latency (`avgLatencyMs`), and applies per-1k token cost weights when configured.

## 4. Runtime Discovery & Diagnostics API

- `POST /api/v1/models/runtimes/test` (Admin): Probes a runtime (`baseUrl`, optional `apiKey`, optional `modelId`), returning latency and discovered model IDs (`safeExternalFetch` protects against unsafe targets when non-loopback or disallowed).
- `POST /api/v1/models/discover` (Admin): Queries healthy configured runtimes and registers/updates ready models in the persistent `models` table without wiping existing active deployments.
- `GET /api/v1/models/health`: Returns runtime health, hardware specs (`inspectHardware`), and `circuitBreakers` snapshots.
