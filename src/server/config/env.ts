import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

export type RuntimeBackendKind = 'auto' | 'vllm' | 'ollama' | 'tensorrt-llm' | 'transformers' | 'embedded';
export type SandboxModeKind = 'subprocess' | 'docker';

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || process.env.NEO_PORT || 3000),
  appUrl: process.env.APP_URL || process.env.NEO_URL || 'http://localhost:3000',

  // Neo Sovereign Neural Compute Runtimes (zero external cloud AI dependency)
  runtimeDefault: (process.env.NEO_RUNTIME_DEFAULT || 'auto') as RuntimeBackendKind,
  ollamaBaseUrl: process.env.NEO_OLLAMA_URL || process.env.NEO_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  vllmBaseUrl: process.env.NEO_VLLM_URL || process.env.NEO_VLLM_BASE_URL || '',
  trtLlmBaseUrl: process.env.NEO_TRTLLM_URL || process.env.NEO_TENSORRT_LLM_BASE_URL || '',
  hfBaseUrl: process.env.NEO_HF_URL || process.env.NEO_HF_INFERENCE_BASE_URL || '',
  customInferenceUrl: process.env.NEO_INFERENCE_URL || '',
  primaryModel: process.env.NEO_PRIMARY_MODEL || process.env.NEO_INFERENCE_MODEL || 'neo-embedded-core-v1',
  embeddingModel: process.env.NEO_EMBEDDING_MODEL || 'neo-embed-local-v2',
  modelsDir: process.env.NEO_MODELS_DIR || 'data/models',

  // Web Discovery (optional non-AI public search keys; defaults to public GitHub/arXiv/Wikipedia/HTTP)
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
  serperApiKey: process.env.SERPER_API_KEY || '',
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',

  // Persistence & Queue
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',

  // Sandbox & Evolution Controls
  sandboxMode: (process.env.NEO_SANDBOX_MODE || 'subprocess') as SandboxModeKind,
  autoMergeSafeUpgrades: (process.env.AUTO_MERGE_SAFE_UPGRADES || process.env.NEO_AUTO_MERGE_SAFE_UPGRADES) === 'true',
  schedulerEnabled: process.env.NEO_SCHEDULER_ENABLED !== 'false',
  knowledgeDaemonIntervalMs: Number(process.env.KNOWLEDGE_DAEMON_INTERVAL_MS || process.env.NEO_KNOWLEDGE_INTERVAL_MS || 900_000),
  schedulerTickMs: Number(process.env.NEO_SCHEDULER_TICK_MS || 60_000),

  // Security Controls (fail-closed defaults)
  adminPasscode: process.env.NEO_ADMIN_PASSCODE || process.env.ADMIN_PASSCODE || '',
  webhookSecret: process.env.NEOS_WEBHOOK_SECRET || '',
  sessionSecret: process.env.NEO_SESSION_SECRET || EPHEMERAL_SESSION_SECRET,
  corsAllowedOrigins: (process.env.NEO_CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export function getConfiguredSubsystems() {
  return {
    runtimes: [
      {
        id: 'embedded',
        name: 'Neo Embedded Cognitive Core',
        configured: true,
        defaultModel: 'neo-embedded-core-v1',
        endpoint: 'in-process',
      },
      {
        id: 'ollama',
        name: 'Ollama Local Model Runtime',
        configured: Boolean(env.ollamaBaseUrl),
        defaultModel: env.primaryModel,
        endpoint: env.ollamaBaseUrl || null,
      },
      {
        id: 'vllm',
        name: 'vLLM High-Throughput Server',
        configured: Boolean(env.vllmBaseUrl),
        defaultModel: env.primaryModel,
        endpoint: env.vllmBaseUrl || null,
      },
      {
        id: 'tensorrt-llm',
        name: 'NVIDIA TensorRT-LLM Engine',
        configured: Boolean(env.trtLlmBaseUrl),
        defaultModel: env.primaryModel,
        endpoint: env.trtLlmBaseUrl || null,
      },
      {
        id: 'transformers',
        name: 'HuggingFace Transformers Runtime',
        configured: Boolean(env.hfBaseUrl),
        defaultModel: env.primaryModel,
        endpoint: env.hfBaseUrl || null,
      },
    ],
    search: [
      { id: 'github_arxiv', name: 'GitHub & arXiv Direct Ingestor', configured: true },
      { id: 'wikipedia_direct', name: 'Wikipedia & Direct SSRF-Guarded Fetcher', configured: true },
      {
        id: 'optional_serp',
        name: 'Optional Public Search Adapters (Tavily/Serper/Brave)',
        configured: Boolean(env.tavilyApiKey || env.serperApiKey || env.braveSearchApiKey),
      },
    ],
    storage: env.databaseUrl ? 'postgresql+pgvector' : 'sqlite-embedded',
    queue: env.redisUrl ? 'bullmq+redis' : 'persistent-worker-queue',
    sandbox: env.sandboxMode,
    sandboxMode: env.sandboxMode,
    runtimeDefault: env.runtimeDefault,
    independentCore: true,
  };
}
