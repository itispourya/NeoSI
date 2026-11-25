import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',

  // Neo Sovereign Compute & Neural Backends
  neoLocalOnly: process.env.NEO_LOCAL_ONLY === 'true',
  neoInferenceUrl: process.env.NEO_INFERENCE_URL || '',
  neoInferenceModel: process.env.NEO_INFERENCE_MODEL || 'neo-core-instruct',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || '',

  // Web Discovery
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
  serperApiKey: process.env.SERPER_API_KEY || '',
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',

  // Persistence & Queue
  databaseUrl: process.env.DATABASE_URL || '',
  redisUrl: process.env.REDIS_URL || '',

  // Self-upgrade & Security
  autoMergeSafeUpgrades: process.env.AUTO_MERGE_SAFE_UPGRADES === 'true',
  knowledgeDaemonIntervalMs: Number(process.env.KNOWLEDGE_DAEMON_INTERVAL_MS || 900_000),
  adminPasscode: process.env.NEO_ADMIN_PASSCODE || '',
  webhookSecret: process.env.NEOS_WEBHOOK_SECRET || '',
  sessionSecret: process.env.NEO_SESSION_SECRET || EPHEMERAL_SESSION_SECRET,
};

export function getConfiguredProviders() {
  const hasNeuralCompute = Boolean(
    env.neoInferenceUrl ||
      env.ollamaBaseUrl ||
      (env.geminiApiKey && env.geminiApiKey !== 'MY_GEMINI_API_KEY') ||
      env.openaiApiKey ||
      env.anthropicApiKey ||
      env.openrouterApiKey
  );

  return {
    llm: [
      {
        id: 'neo_sovereign',
        name: 'Neo Sovereign Memory & Symbolic Core',
        configured: true,
        defaultModel: 'neo-vector-rag-v1',
      },
      {
        id: 'neo_local_inference',
        name: 'Neo Self-Hosted Inference Node',
        configured: Boolean(env.neoInferenceUrl || env.ollamaBaseUrl),
        defaultModel: env.neoInferenceModel,
      },
      {
        id: 'neo_neural_compute',
        name: 'Neo Neural Compute Accelerator',
        configured: hasNeuralCompute && !env.neoLocalOnly,
        defaultModel: env.neoLocalOnly ? 'disabled (local-only)' : 'neo-neural-4',
      },
      {
        id: 'neo_sandbox_vm',
        name: 'Neo Isolated V8 Execution Sandbox',
        configured: true,
        defaultModel: 'node-vm-strict',
      },
    ],
    search: [
      { id: 'github_arxiv', name: 'Neo GitHub & arXiv Direct Ingestor', configured: true },
      { id: 'direct_http', name: 'Neo SSRF-Guarded Web Fetcher', configured: true },
      { id: 'grounded_web', name: 'Neo Deep Web Discovery Index', configured: hasNeuralCompute && !env.neoLocalOnly },
      { id: 'external_serp', name: 'Optional SERP Connectors (Tavily/Serper/Brave)', configured: Boolean(env.tavilyApiKey || env.serperApiKey || env.braveSearchApiKey) },
    ],
    storage: env.databaseUrl ? 'postgresql+pgvector' : 'sqlite-embedded',
    queue: env.redisUrl ? 'bullmq+redis' : 'persistent-worker-queue',
    localOnlyMode: env.neoLocalOnly,
  };
}
