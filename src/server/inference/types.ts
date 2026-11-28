import type { SupportedLanguage } from '../db/schema.ts';

export type ModelRole =
  | 'primary'
  | 'fast'
  | 'lightweight'
  | 'deep'
  | 'reasoning'
  | 'business'
  | 'coding'
  | 'research'
  | 'classification'
  | 'extraction'
  | 'embeddings'
  | 'embedding'
  | 'reranking'
  | 'multimodal'
  | 'vision'
  | 'speech_recognition'
  | 'speech_generation'
  | 'specialized';

export type RuntimeKind = 'embedded' | 'ollama' | 'vllm' | 'tensorrt-llm' | 'transformers' | 'custom-llm';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolChoiceOption =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export type ResponseFormatSpec =
  | 'json'
  | 'text'
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };

export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerStatus {
  runtime: RuntimeKind;
  state: CircuitBreakerState;
  failures: number;
  successes: number;
  lastFailureAt: string | null;
  nextRetryAt: string | null;
  lastError: string | null;
}

export interface RoutingPolicyHint {
  complexity?: 'simple' | 'standard' | 'complex';
  privacyMode?: 'local_only' | 'hybrid';
  preferSpeed?: boolean;
  maxCostUsd?: number;
  requireToolCalling?: boolean;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  reasoning: number;
  coding: number;
  multilingual: number;
  persian: number;
}

export interface ModelHealth {
  modelId: string;
  runtime: RuntimeKind;
  status: 'healthy' | 'degraded' | 'offline' | 'unknown';
  endpoint: string;
  latencyMs: number;
  message: string;
  checkedAt: string;
}

export interface ModelPerformanceMetrics {
  avgLatencyMs: number;
  tokensPerSec: number;
  calls: number;
  costPer1kInputUsd?: number;
  costPer1kOutputUsd?: number;
  lastError?: string | null;
}

export interface ModelDeployment {
  modelId: string;
  role: ModelRole;
  runtime: RuntimeKind;
  endpoint: string;
  status: 'active' | 'standby' | 'failed' | 'rolled_back';
  previousModelId?: string;
  activatedAt: string;
}

export interface InferenceRequest {
  prompt: string;
  systemInstruction?: string;
  taskType?: string;
  role?: ModelRole;
  tenantId?: string;
  preferredRuntime?: RuntimeKind;
  preferredModelId?: string;
  strictTarget?: boolean;
  tools?: ToolDefinition[];
  toolChoice?: ToolChoiceOption;
  language?: SupportedLanguage;
  responseFormat?: ResponseFormatSpec;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  routingHint?: RoutingPolicyHint;
  context?: Record<string, unknown>;
}

export interface InferenceResponse {
  text: string;
  runtime: RuntimeKind;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  tokensPerSec: number;
  estimatedCostUsd?: number;
  finishReason?: 'stop' | 'tool_calls' | 'length';
  toolCalls?: ToolCallResult[];
  isFallback?: boolean;
}

export type InferenceStreamChunk =
  | { type: 'delta'; text: string; toolCallDelta?: { index: number; id?: string; name?: string; argumentsDelta?: string } }
  | { type: 'done'; response: InferenceResponse };

export type InferenceStream = AsyncGenerator<InferenceStreamChunk>;

export interface ModelRuntime {
  readonly kind: RuntimeKind;
  readonly displayName: string;
  isConfigured(): boolean;
  healthCheck(): Promise<ModelHealth>;
  discoverModels?(): Promise<string[]>;
  probeModelLoaded?(modelId: string): Promise<{ ready: boolean; message: string }>;
  generate(req: InferenceRequest, modelId: string): Promise<InferenceResponse>;
  stream(req: InferenceRequest, modelId: string): InferenceStream;
}

export interface InferenceEngine {
  infer(req: InferenceRequest): Promise<InferenceResponse>;
  inferJson<T>(req: InferenceRequest): Promise<{ data: T; response: InferenceResponse }>;
  inferStream(req: InferenceRequest): InferenceStream;
  listRuntimeHealth(): Promise<ModelHealth[]>;
}

export interface HardwareProfile {
  cpuModel: string;
  cpuCores: number;
  totalRamGb: number;
  freeRamGb: number;
  diskFreeGb: number;
  gpus: Array<{ index: number; name: string; totalVramGb: number; freeVramGb: number; utilizationPct: number }>;
  totalVramGb: number;
  hasGpu: boolean;
  recommendedProfile: 'cpu-development' | 'single-gpu' | 'multi-gpu';
}

export interface ModelRegistry {
  discoverCompatibleModels(): Promise<
    Array<{
      id: string;
      name: string;
      runtime: RuntimeKind;
      license: string;
      vramGb: number;
      ramGb: number;
      compatible: boolean;
      compatibilityReason: string;
      deploymentStatus: string;
      downloadStatus: string;
    }>
  >;
  installModel(modelId: string, options?: { sourceUrl?: string; expectedSha256?: string }): Promise<{ ok: boolean; message: string }>;
  verifyModelReady(modelId: string): Promise<{ ready: boolean; message: string }>;
  activateModel(modelId: string, role?: ModelRole): Promise<ModelDeployment>;
  rollbackModel(role?: ModelRole): Promise<ModelDeployment | null>;
  deleteModel(modelId: string): Promise<boolean>;
  getHealth(): Promise<ModelHealth[]>;
}
