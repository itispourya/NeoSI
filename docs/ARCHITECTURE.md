# Neo — Independent Autonomous Cognitive Engine Architecture

## 1. Design Philosophy
Neo is an independent, self-hosted cognitive operating system. Its core intelligence, memory, reasoning, planning, verification, tool runtime, knowledge acquisition, and software self-evolution operate without requiring any external cloud AI provider APIs.

## 2. Layered Architecture

```
+-------------------------------------------------------------------------+
|                    Clients & Applications (Neos, SDK, UI)               |
|           @neo/ai-sdk  |  REST + SSE (/api/v1/*)  |  Admin Console      |
+-------------------------------------------------------------------------+
                                    |
+-------------------------------------------------------------------------+
|                        Zero-Trust API Gateway                           |
|   Scoped SHA-256 API Keys  |  Admin Bearer Auth  |  Tenant Isolation    |
|   Rate Limiter  |  Security Headers  |  Request/Correlation IDs         |
+-------------------------------------------------------------------------+
                                    |
+-------------------------------------------------------------------------+
|                      Neo Cognitive Architecture                         |
|  CognitiveOrchestrator -> ReasoningEngine (13 stages) -> CriticEngine   |
|  Persistent DAG TaskPlanner  |  Durable AgentRuntime (Checkpoint/Resume)|
|  Standardized Neo ToolRegistry  |  AutonomousScheduler (Priority-Aware) |
+-------------------------------------------------------------------------+
          |                                       |
+-----------------------------------+   +---------------------------------+
|   Memory, Knowledge & Graph       |   |  Independent Neural Compute     |
|  7 Memory Types + Consolidation   |   |  InferenceEngine + ModelRegistry|
|  Hybrid Vector + BM25 + RRF       |   |  Runtimes: vLLM | Ollama |      |
|  KnowledgeGraph (Entities/Edges)  |   |   TensorRT-LLM | HF | Embedded  |
|  16-Stage Research + Guardrails   |   |  Local Embeddings + Evaluator   |
+-----------------------------------+   +---------------------------------+
          |                                       |
+-------------------------------------------------------------------------+
|                   Persistence & Isolated Execution                      |
|  PostgreSQL + pgvector (Prod) / SQLite WAL (Dev)  |  Redis/BullMQ       |
|  Subprocess / Docker Sandbox  |  Git Worktree Evolution + Benchmarks    |
+-------------------------------------------------------------------------+
```

## 3. Core Subsystems

1. **Independent Neural Compute (`src/server/inference/`)**
   - `ModelRuntime` abstraction supporting `vllm`, `ollama`, `tensorrt-llm`, `transformers`, and `embedded` (CPU-native deterministic & template/RAG synthesis core).
   - `ModelRegistry` & `ModelManager` tracking hardware (CPU, RAM, disk, NVIDIA GPU/VRAM), licenses, quantization, roles, checksums, deployments, and rollback history.
   - `ModelEvaluator` executing a reproducible 12-category intelligence & performance benchmark suite (never hardcoded scores).
   - `EmbeddingEngine` supporting local embedding endpoints plus `neo-embed-local-v2` (768-d multilingual subword + token hashing) and hybrid BM25 + vector RRF reranking.

2. **Cognitive Engine & Durable Agent (`src/server/cognitive/`, `src/server/agent/`, `src/server/tools/`)**
   - 13-stage `ReasoningEngine` with structured internal plans, intermediate analysis, error diagnosis/recovery, and independent `CriticEngine` verification (never exposing raw private chain-of-thought).
   - Persistent `TaskPlanner` & `AgentRuntime` persisting `tasks`, `task_steps`, and `task_events` across restarts, with explicit loop detection, exponential backoff retries, cancellation, and checkpoint recovery.
   - Standardized `ToolRegistry` with input/output Zod validation, risk tiers, scopes, timeouts, and execution audit logs.

3. **Memory, Knowledge Graph & Research (`src/server/knowledge/`)**
   - 7 memory types (`working`, `episodic`, `semantic`, `procedural`, `personal`, `organizational`, `temporal`) with validity windows, importance/confidence scores, temporal decay, contradiction detection, forgetting, and `MemoryConsolidationWorker`.
   - Persistent `KnowledgeGraph` (`entities`, `relationships`) with temporal provenance and BFS traversal.
   - 16-stage `ResearchEngine` with DNS-aware SSRF protection, redirect validation, prompt-injection sanitization, multi-factor source quality rubric, PDF/HTML extraction, and contradiction reporting.

4. **Layered Self-Evolution (`src/server/evolution/`)**
   - **Layer A**: Versioned skill & memory consolidation and skill evaluation.
   - **Layer B**: Controlled cognitive configuration experiments (`evolution_experiments`).
   - **Layer C**: Real Git branch + worktree patch creation, real static checks (`tsc --noEmit`), security policy checks, isolated test execution, and measured baseline-vs-candidate benchmarks with protected path enforcement and rollback.
   - **Layer D**: Privacy-filtered training dataset export and LoRA/QLoRA job tracking (`training_jobs`).
