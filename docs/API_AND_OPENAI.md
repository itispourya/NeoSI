# API & OpenAI Compatibility Reference

All API endpoints live under `/v1/*` and `/api/v1/*`. Gateway routes require `Authorization: Bearer neos_live_...` or `X-API-Key: neos_live_...` with matching scopes (`read`, `write`, `forge`, or `admin`). Console administrative endpoints (`/api/admin/*`, model activation, knowledge policy writes, evolution promotion) require an `neo_adm_...` admin session token.

## 1. OpenAI-Compatible Endpoints

- `GET /v1/models` and `GET /api/v1/models` (`read`)
  Returns `{ object: "list", data: [{ id, object: "model", created, owned_by }] }` including `neo-ai-v1`, `neo-embedded-core-v1`, and active/ready registered models.
- `POST /v1/chat/completions` and `POST /api/v1/chat/completions` (`write`)
  Supports standard OpenAI request payloads:
  - `messages`: `system`, `developer`, `user`, `assistant`, and `tool` (`tool_call_id`, `name`, `tool_calls`) turns.
  - `stream: true`: emits `chat.completion.chunk` SSE events (`delta.content` and `delta.tool_calls`) terminated by `data: [DONE]`, and aborts upstream inference immediately if the HTTP client disconnects.
  - `tools` & `tool_choice`: passes function schemas directly to tool-capable runtimes and returns OpenAI `tool_calls` (`finish_reason: "tool_calls"`).
  - `response_format`: supports `text`, `json_object`, and `json_schema`.
  - `language` (`en | fa | ar | nl`) and `workspaceContext` (optional Neos workspace metadata sanitized and redacted per tenant `pii_redaction`).
  - Fast-path probes (`Say "OK"`, `ping`) return an immediate `OK` completion for low-latency connection testing.

## 2. Core Cognitive, Agent & Business Routes (`/api/v1/*`)

- `POST /api/v1/chat` & `POST /api/v1/chat/stream` (`write`) — Multi-turn cognitive reasoning with RAG and critic verification.
- `POST /api/v1/tasks`, `GET /api/v1/tasks`, `GET /api/v1/tasks/:id`, `GET /api/v1/tasks/:id/stream`, `POST /api/v1/tasks/:id/cancel`, `POST /api/v1/tasks/:id/resume` — Durable DAG agent tasks with SSE progress streams.
- `POST /api/v1/business/analyze` (`write`) — Structured multilingual financial/operational audit (`en`, `fa`, `ar`, `nl`).
- `GET /api/v1/tools`, `POST /api/v1/tools/:id/execute`, `POST /api/v1/mcp` (`read`/`write`/`forge`) — Tool execution & MCP JSON-RPC.
- `GET /api/v1/openapi.json` — Live OpenAPI 3.1 specification including `/models/*`, `/knowledge/*`, `/evolution/*`, and `/neos/*`.

## 3. Official TypeScript SDKs

- **Neo Engine SDK (`packages/neo-ai-sdk/src/index.ts`)**: `NeoClient` provides `chat()`, `chatCompletions()`, `streamChatCompletions()`, `listModels()`, `createTask()`, `analyzeBusiness()`, and Neos contract/capability helpers.
- **Neos AI Adapter SDK (`packages/neos-ai-sdk/src/index.ts`)**: `NeoAiClient` provides drop-in Neos integration (`chat()`, `chatCompletions()`, `ingestWorkspaceContext()`, `syncCapabilities()`, `executeOrQueueAction()`, `confirmApproval()`, `rejectApproval()`, and `verifyWebhookSignature()`).
