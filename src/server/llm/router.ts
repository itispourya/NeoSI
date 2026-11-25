import type { SupportedLanguage } from '../db/schema.ts';
import { embeddingEngine } from '../inference/embeddings.ts';
import { neoInferenceEngine } from '../inference/registry.ts';
import type { ModelRole, RuntimeKind } from '../inference/types.ts';

export type LlmProviderName = RuntimeKind;

export interface LlmRequest {
  prompt: string;
  systemInstruction?: string;
  taskType?: string;
  tenantId?: string;
  role?: ModelRole;
  language?: SupportedLanguage;
  preferredProvider?: LlmProviderName;
  preferredModel?: string;
  responseMimeType?: 'application/json' | 'text/plain';
}

export interface LlmResponse {
  text: string;
  provider: LlmProviderName;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
}

/**
 * Sovereign Inference Compatibility Facade:
 * All calls route strictly through NeoInferenceEngine (self-hosted runtimes + embedded CPU core).
 * Zero external cloud AI provider SDKs or API calls exist here.
 */
export async function routeLlmCall(req: LlmRequest): Promise<LlmResponse> {
  const res = await neoInferenceEngine.infer({
    prompt: req.prompt,
    systemInstruction: req.systemInstruction,
    taskType: req.taskType,
    tenantId: req.tenantId,
    role: req.role,
    language: req.language,
    preferredRuntime: req.preferredProvider,
    preferredModelId: req.preferredModel,
    responseFormat: req.responseMimeType === 'application/json' ? 'json' : 'text',
  });

  return {
    text: res.text,
    provider: res.runtime,
    model: res.modelId,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
    estimatedCostUsd: 0,
    latencyMs: res.latencyMs,
  };
}

export async function routeJsonLlmCall<T>(req: LlmRequest): Promise<{ data: T; meta: LlmResponse }> {
  const { data, response } = await neoInferenceEngine.inferJson<T>({
    prompt: req.prompt,
    systemInstruction: req.systemInstruction,
    taskType: req.taskType,
    tenantId: req.tenantId,
    role: req.role,
    language: req.language,
    preferredRuntime: req.preferredProvider,
    preferredModelId: req.preferredModel,
    responseFormat: 'json',
  });

  return {
    data,
    meta: {
      text: response.text,
      provider: response.runtime,
      model: response.modelId,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      estimatedCostUsd: 0,
      latencyMs: response.latencyMs,
    },
  };
}

export async function* streamLlmCall(req: LlmRequest): AsyncGenerator<{ chunk?: string; done?: LlmResponse }> {
  for await (const part of neoInferenceEngine.inferStream({
    prompt: req.prompt,
    systemInstruction: req.systemInstruction,
    taskType: req.taskType,
    tenantId: req.tenantId,
    role: req.role,
    language: req.language,
    preferredRuntime: req.preferredProvider,
    preferredModelId: req.preferredModel,
  })) {
    if (part.type === 'delta') {
      yield { chunk: part.text };
    } else if (part.type === 'done') {
      yield {
        done: {
          text: part.response.text,
          provider: part.response.runtime,
          model: part.response.modelId,
          promptTokens: part.response.promptTokens,
          completionTokens: part.response.completionTokens,
          estimatedCostUsd: 0,
          latencyMs: part.response.latencyMs,
        },
      };
    }
  }
}

export async function embedText(text: string): Promise<number[]> {
  const res = await embeddingEngine.embed(text);
  return res.vector;
}
