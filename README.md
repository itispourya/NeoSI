# Neo — Autonomous Sovereign Cognitive Engine & API Forge

**Neo** is an independent, self-hosted, continuously learning autonomous cognitive operating system, software engineering agent, multi-module business intelligence engine for **Neos**, and dynamic API Forge.

Neo operates with **zero dependencies on external commercial LLM/AI APIs** (`@google/genai`, OpenAI, Anthropic, or OpenRouter cloud APIs are absent). It boots and executes locally via its CPU-native `neo-embedded-core-v1` + `neo-embed-local-v2` engines and natively integrates self-hosted open-weight model runtimes (**vLLM**, **Ollama**, **TensorRT-LLM**, and **HuggingFace Transformers**).

## Core Architecture
- **Independent Inference & Model Lifecycle (`src/server/inference/`)**: Hardware profiler (CPU/RAM/Disk/GPU VRAM), pluggable open-weight `InferenceEngine`, `NeoModelRegistry` (hardware & open-license compatibility, SHA-256 verification, activation & rollback), and a real 12-category `NEO_BENCHMARK_CASES` suite.
- **13-Stage Cognitive Core (`src/server/cognitive/`)**: Intent & complexity classification, dependency-aware DAG `TaskPlanner`, 11 Zod-validated built-in tools + MCP JSON-RPC (`src/server/tools/registry.ts`), and an independent `CriticEngine` verifying grounding, arithmetic, and safety.
- **Durable Agent Runtime (`src/server/agent/runtime.ts`)**: Persisted state machine (`pending -> planning -> running -> completed | failed | cancelled`) with step checkpointing, loop-signature guard, cancellation, SSE `/api/v1/tasks/:id/events`, and boot-time recovery of interrupted tasks.
- **7-Layer Hybrid Memory & Knowledge Graph (`src/server/knowledge/`)**: `working`, `episodic`, `semantic`, `procedural`, `personal`, `organizational`, and `temporal` memory (with `valid_from`, `valid_to`, `superseded_by`), BM25 + multilingual 768-d cosine RRF retrieval, periodic `consolidation.ts`, entity/relationship graph with contradiction tracking, and a 16-stage `runAutonomousResearch` pipeline.
- **4-Layer Safe Self-Evolution (`src/server/evolution/pipeline.ts`)**: Skill evaluation (Layer A), A/B cognitive config experiments (Layer B), isolated Git branch + subprocess unit test + measured before/after benchmark gating with `PROTECTED_CORE_PATHS` guardrails (Layer C), and privacy-filtered SFT/LoRA JSONL dataset building (Layer D).
- **Security & Isolated Execution (`src/server/security/`, `src/server/sandbox/`)**: Fail-closed scrypt admin auth, scoped `neos_live_*` API keys with rotate/revoke, strict tenant isolation across every table, DNS-aware SSRF protection with manual redirect chain checks, `<untrusted_data>` prompt-injection wrapping, and OS subprocess / Docker container sandboxing (`env: {}`).

## Quickstart (Local Development)

```bash
npm install
npm run dev
```

Open `http://localhost:3000`, claim your initial admin passcode (`>= 6` characters) on the bootstrap screen, and explore the Control Plane.

## Production & Multi-GPU Docker Deployment

```bash
# Single-node production build
npm run build
npm run start

# PostgreSQL + pgvector + Redis + Ollama (dev / single GPU)
docker compose --profile gpu-single up -d --build

# Multi-GPU vLLM high-throughput cluster
docker compose --profile gpu-multi up -d --build
```

## Verification Suite

```bash
npm run lint
npm test
npm run build
```
