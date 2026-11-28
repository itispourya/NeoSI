# Knowledge Governance, Multilingual RAG & Controlled Learning

## 1. Policy-Governed Continuous Knowledge (`src/server/knowledge/feeds.ts`)

NeoSI maintains tenant-scoped knowledge governance rules in `knowledge_policies`:
- `trusted_domain`: boosts source corroboration & epistemic confidence (`verified_fact` when corroborated).
- `blocked_domain`: rejects feeds and web research URLs matching the domain pattern before fetch.
- `feed_source`: registers RSS 2.0, Atom, or `github_releases:<owner>/<repo>` sources with `min_reliability` and `revalidation_hours`.

**Feed Ingestion Pipeline (`POST /api/v1/knowledge/feeds/sync` & idle scheduler):**
1. Validates domain policies and executes DNS-pinned SSRF checks (`validateExternalUrlAsync`).
2. Sends conditional HTTP headers (`If-None-Match` / `If-Modified-Since`) and skips unchanged `304 Not Modified` feeds.
3. Sanitizes feed bodies via `sanitizeUntrustedContent` to strip prompt injections.
4. Computes SHA-256 `content_hash` to deduplicate unchanged items before storing `semantic` memories and extracting graph entities/edges.
5. Marks expired sources stale during scheduled revalidation (`revalidateStaleKnowledgeSources`).

## 2. Multilingual Query Normalization & Policy-Filtered RAG

- `normalizeMultilingualQuery` (`src/server/business/language.ts`) converts Persian (`۰-۹`) and Arabic-Indic (`٠-٩`) digits to ASCII, normalizes Arabic `ي`/`ك` to standard Persian `ی`/`ک`, and cleans zero-width non-joiners (`\u200C`) before hybrid vector + BM25 search.
- `NEO_EXTRA_LANGUAGES_JSON` allows operators to define additional target language directives (`[{ code, label, rtl, directive }]`).
- `retrieveRagContext` (`src/server/knowledge/memory.ts`) enforces the active **Layer 3 Behavioral Policy** (`ragTopK`, `minReliability`), filters out `superseded_by` and expired (`valid_to`) entries, and emits provenance tags (`[provenance=public_web_and_docs]`, `[provenance=business_context]`, etc.).
- `GET /api/v1/knowledge/diagnostics?q=...` returns normalized query text, active policy version, vector vs lexical hit counts, filtered counts, and top ranked matches.

## 3. Controlled Self-Evaluation & Evolution (`src/server/evolution/pipeline.ts`)

1. **System Intelligence Evaluation Suite (`POST /api/v1/evolution/evaluate`)**
   Runs deterministic multilingual (`en`, `fa`, `ar`, `nl`), policy-filtering, and reasoning checks (`sys-eval-v2`), recording accuracy, citation compliance, pass counts, and latency in `model_evaluations`.

2. **Layer 3 Behavioral Policy Lifecycle (`behavioral_policies`)**
   - `POST /api/v1/evolution/policies`: creates a new candidate policy (`ragTopK`, `minReliability`, `maxPlanSteps`, `preferLocalForPrivate`, `systemDirectiveSuffix`), runs baseline vs candidate `SystemEvalSuite`, logs a `Layer B` experiment, and marks passing candidates ready (`candidate` or `active` if `autoPromote`).
   - `POST /api/v1/evolution/policies/:id/promote` and `POST /api/v1/evolution/policies/rollback`: safely promote or revert active reasoning/RAG parameters without touching application source code.

3. **Important Boundary on Model Training (Layer D)**
   `POST /api/v1/evolution/training` exports privacy-redacted high-reliability JSONL records to `training_jobs` for external LoRA/QLoRA trainers. NeoSI explicitly marks `dataset_only` execution boundaries and **never claims to train or update neural network weights inside Node.js**.
