# Neo — Autonomous Sovereign Cognitive Engine

Neo is a self-hosted cognitive and agent runtime for local inference, tool execution, persistent memory, knowledge acquisition, and integration with Neos. It is designed to operate without a dependency on commercial hosted LLM APIs. Generative inference uses a configured local runtime such as Ollama, vLLM, TensorRT-LLM, or a compatible Transformers endpoint.

## What is included

- **Inference and model registry** — Local runtime adapters, hardware inspection, model registration, installation, runtime readiness probes, activation, rollback, and strict-target benchmarking.
- **Cognitive services** — Request classification, planning, tool routing, reasoning orchestration, and critic-based verification.
- **Agent runtime** — Persistent tasks, checkpoints, cancellation, recovery, permission-preserving resume, and explicit `completed`, `partial`, and `failed` outcomes.
- **Memory and knowledge** — Typed memory, workspace-aware retrieval, temporal metadata, source provenance, consolidation, knowledge research, and tenant-validated graph relationships.
- **Tool and API runtime** — Built-in tools, MCP JSON-RPC, API generation, and OpenAPI metadata.
- **Evolution services** — Skill evaluation, experiments, upgrade proposals, code-generation evaluation, and training-data preparation.
- **Security controls** — Scrypt admin credentials, scoped API keys, rate limits, tenant-scoped data access in the protected paths, DNS-pinned outbound requests, same-origin redirect policy, bounded response streaming, and fail-closed production code execution.

## Important capability boundaries

Neo's embedded CPU runtime is a deterministic symbolic fallback. It is not a general-purpose neural language model. For generative reasoning, connect a local model runtime and verify that the selected model is available there.

Embedding behavior depends on the configured embedding backend. A deterministic CPU fallback is useful for local operation, but should not be represented as equivalent to a trained multilingual embedding model.

The benchmark suite uses a small set of task-specific evaluators. It is useful for regression checks, but its scores are not a substitute for independent, standardized model evaluations. Strict-target execution prevents a benchmark from silently scoring a different fallback model.

The development subprocess runner is not an OS security boundary. In production, dynamic code execution is disabled unless Docker isolation is explicitly selected and a Docker daemon is actually available. If the Docker sandbox is requested but unavailable, Neo refuses execution instead of falling back to a normal subprocess.

Self-evolution features do not imply unrestricted autonomous production changes. Model activation requires runtime verification; proposals and code changes should remain subject to review, tests, and rollback controls.

## Quickstart — local development

Requirements: a recent Bun release and a supported Node.js runtime.

```bash
cp .env.example .env
bun install
bun run dev
```

Open `http://localhost:3000`. On first setup, claim an administrator passcode containing at least 12 characters. In development, Neo can create an ephemeral session secret; sessions signed with an ephemeral secret do not survive process restarts.

To use a generative local model, configure an available runtime endpoint in `.env`. The default embedded runtime is deterministic and does not download a model.

## Production

Set `NODE_ENV=production` and configure `NEO_SESSION_SECRET` with at least 32 bytes of unpredictable random data. For example:

```bash
openssl rand -hex 32
```

Also configure the database credentials, trusted proxy hop count, CORS origins, and model runtime endpoint for the deployment. Production startup fails when the session secret is missing or too short.

The default production Compose setup does not expose PostgreSQL or Redis to the public network; their published ports bind to host loopback. It requires `POSTGRES_PASSWORD` and `NEO_SESSION_SECRET` in the Compose `.env` file.

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD and NEO_SESSION_SECRET in .env before starting.
docker compose --profile gpu-single up -d --build
```

Dynamic code execution remains disabled when `NEO_SANDBOX_MODE=subprocess` in production. Do not enable subprocess mode as a production isolation mechanism. A Docker sandbox requires a separately secured Docker daemon connection; the default Compose file does not mount the host Docker socket.

## Validation

```bash
bun run lint
bun run test
bun run build
```

GitHub Actions runs the typecheck, test suite, and production frontend build on branch pushes and pull requests.
