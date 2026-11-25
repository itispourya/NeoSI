# Neo — Autonomous Cognitive Brain, Self-Upgrading Agent & Dynamic API Forge

**Neo** is an independent, standalone, production-grade AI engine, senior autonomous software engineer, deep business intelligence analyst, and dynamic API generator built to serve as the sovereign cognitive brain for **Neos** (Business Operations OS) and third-party client workspaces.

---

## Core Architecture

- **Orchestration & Gateway (`server.ts`, `src/server/routes/*`)**: TypeScript + Express + Vite/React Observability Console with Server-Sent Events (SSE) streaming, OpenAPI 3.1 auto-documentation (`/api/v1/openapi.json`), and strict Zod input validation.
- **Dual-Mode Database & Vector Memory (`src/server/db/adapter.ts`, `migrations/001_init.sql`)**:
  - **Production**: PostgreSQL + `pgvector` (`768`-dim embeddings) when `DATABASE_URL` is configured.
  - **Embedded Standalone**: Persistent `node:sqlite` (`data/neo.db`) with cosine-similarity vector indexing across **Episodic**, **Semantic**, and **Procedural** memory.
- **Background Queue (`src/server/queue/jobQueue.ts`)**: BullMQ + Redis when `REDIS_URL` is set, with a persistent SQLite-backed async worker queue fallback.
- **Sovereign Standalone Engine (`src/server/neo/sovereignEngine.ts`, `src/server/llm/router.ts`)**: Runs independently in `NEO_LOCAL_ONLY=true` / `sovereign-local` mode (local extractive NLP + 768-d semantic/procedural RAG synthesis + live promoted module VM execution), or connects to self-hosted `NEO_INFERENCE_URL` / Ollama or neural compute accelerators with per-call token/latency telemetry.
- **24/7 Knowledge Daemon & Reflection Worker (`src/server/knowledge/*`)**:
  - Continuous web discovery via Neo GitHub & arXiv Direct Ingestor, SSRF-guarded HTTP extraction, optional SERP connectors (Tavily/Serper/Brave), and neural web indexing.
  - Source reliability scoring, chunking, vector embedding, and versioned **Skill & Pattern Registry** updates.
  - Post-task `ReflectionWorker` storing root causes and reusable procedural lessons.
- **Safe Self-Upgrading Pipeline (`src/server/upgrades/pipeline.ts`)**:
  - Diagnoses telemetry errors/latency and procedural gaps.
  - Strictly blocks edits to immutable security/auth/secret paths (`.env`, `src/server/security/`, `migrations/`, `server.ts`).
  - Runs generated unit tests inside an isolated V8 `node:vm` sandbox, checks before/after benchmark gates, and promotes approved modules to live execution via `POST /api/v1/modules/:id/execute`.
- **Autonomous API Forge (`src/server/forge/generator.ts`)**:
  - Synthesizes typed handlers, Zod schemas, OpenAPI specs, and unit tests from natural language, verifies 100% pass rate in the isolated sandbox, and hot-registers `/api/v1/custom/<slug>`.
- **Multilingual Neos Brain (`src/server/business/analyzer.ts`)**:
  - Deterministic double-entry ledger auditing (`SUM(debits) == SUM(credits)`), cash runway, working capital, LTV/CAC, churn, stockout & dead-stock forecasting, and native executive responses in **English (`en`)**, **Persian (`fa`)**, **Arabic (`ar`)**, and **Dutch (`nl`)**.

---

## Quick Start

### 1. Local / Standalone Mode
```bash
cp .env.example .env
# Set GEMINI_API_KEY in .env (and optionally OPENAI_API_KEY, DATABASE_URL, REDIS_URL)
npm install
npm test
npm run dev
```
Open `http://localhost:3000` for the Admin Observability Console.

### 2. Production Docker Stack (Neo + Postgres/pgvector + Redis)
```bash
cp .env.example .env
docker compose up --build -d
```
Postgres automatically initializes `migrations/001_init.sql` with `pgvector` enabled.

---

## Connecting Neos via `@neos/ai-sdk`

1. Open **Security & Keys** in the Neo console and issue a scoped `neos_live_...` API key for your Neos workspace.
2. Import `@neos/ai-sdk` from `packages/neos-ai-sdk/src/index.ts`:

```ts
import { NeoAiClient } from '@neos/ai-sdk';

const neo = new NeoAiClient({
  baseUrl: 'https://your-neo-ai-host',
  apiKey: process.env.NEOS_AI_API_KEY!,
});

// Stream multilingual chat
for await (const evt of neo.chatStream({
  message: 'تحلیل جریان نقدی و وضعیت موجودی انبار این ماه را ارائه بده',
  language: 'fa',
  workspaceContext: { workspaceId: 'ws_01' },
})) {
  if (evt.event === 'delta') process.stdout.write(String(evt.data.text));
}

// Run multi-module business audit
const audit = await neo.analyzeBusiness({
  workspaceName: 'Neos Europe',
  accounting: { cashBalance: 240000, monthlyRevenue: 65000, monthlyExpenses: 52000 },
});

// Forge a new custom API endpoint on demand
await neo.forgeEndpoint('Score overdue invoices and draft payment reminders');

// Invoke the hot-registered endpoint
const score = await neo.callCustomEndpoint('overdue-invoice-scorer', {
  invoiceId: 'INV-401',
  amount: 12000,
  daysOverdue: 45,
});
```

---

## Core API Endpoints

- `GET /api/v1/health` — Engine status, storage backend, memory count.
- `POST /api/v1/chat/stream` — Context-aware multilingual SSE streaming.
- `POST /api/v1/business/analyze` — Deep accounting, CRM, inventory/POS audit + signed HMAC webhook delivery.
- `POST /api/v1/engineer/task` — Autonomous Plan → Code → Test → Fix engineering loop.
- `POST /api/v1/knowledge/query` & `POST /api/v1/knowledge/learn` — RAG memory search & live web research.
- `GET /api/v1/upgrades`, `POST /api/v1/upgrades/diagnose`, `POST /api/v1/upgrades/:id/approve`, `POST /api/v1/upgrades/:id/rollback`.
- `POST /api/v1/forge/create`, `ALL /api/v1/custom/:slug`, `GET /api/v1/openapi.json`.
