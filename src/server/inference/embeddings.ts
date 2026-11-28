import { env } from '../config/env.ts';
import { EMBEDDING_DIM, localMultilingualEmbedding } from '../db/vector.ts';

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dim: number;
  runtime: 'ollama' | 'vllm' | 'transformers' | 'custom-llm' | 'embedded';
  isNeural: boolean;
}

/** Reject malformed model output and normalize valid embeddings into a stable cosine space. */
export function normalizeEmbeddingVector(candidate: unknown): number[] | null {
  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > 16_000) return null;
  if (!candidate.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const vector = candidate as number[];
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  if (!Number.isFinite(squaredNorm) || squaredNorm < 1e-20) return null;
  const norm = Math.sqrt(squaredNorm);
  return vector.map((value) => value / norm);
}

export class LocalEmbeddingEngine {
  async embed(text: string): Promise<EmbeddingResult> {
    const clean = String(text || '').slice(0, 8000);
    if (!clean.trim()) {
      return {
        vector: new Array<number>(EMBEDDING_DIM).fill(0),
        model: 'neo-embed-local-v2',
        dim: EMBEDDING_DIM,
        runtime: 'embedded',
        isNeural: false,
      };
    }

    // 1. Try Ollama local embedding server when an Ollama embedding model is configured
    if (env.ollamaBaseUrl && env.embeddingModel !== 'neo-embed-local-v2') {
      try {
        const base = env.ollamaBaseUrl.replace(/\/+$/, '');
        const res = await fetch(`${base}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: env.embeddingModel, input: clean }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = (await res.json()) as { embeddings?: number[][] };
          const emb = normalizeEmbeddingVector(data.embeddings?.[0]);
          if (emb) {
            return {
              vector: emb,
              model: env.embeddingModel,
              dim: emb.length,
              runtime: 'ollama',
              isNeural: true,
            };
          }
        }
      } catch {
        // Fall through to compatible endpoint or embedded CPU embedder
      }
    }

    // 2. Try vLLM / HuggingFace TEI / Custom OpenAI-compatible local /v1/embeddings endpoint
    const compatBase = (env.vllmBaseUrl || env.hfBaseUrl || env.customInferenceUrl || '').replace(/\/+$/, '');
    if (compatBase && env.embeddingModel !== 'neo-embed-local-v2') {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (!env.vllmBaseUrl && !env.hfBaseUrl && env.customInferenceApiKey) {
          headers.Authorization = `Bearer ${env.customInferenceApiKey}`;
        }
        const res = await fetch(`${compatBase}/v1/embeddings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: env.embeddingModel, input: clean }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
          const emb = normalizeEmbeddingVector(data.data?.[0]?.embedding);
          if (emb) {
            return {
              vector: emb,
              model: env.embeddingModel,
              dim: emb.length,
              runtime: env.vllmBaseUrl ? 'vllm' : env.hfBaseUrl ? 'transformers' : 'custom-llm',
              isNeural: true,
            };
          }
        }
      } catch {
        // Fall through to embedded CPU embedder
      }
    }

    // 3. Always-available CPU-native neo-embed-local-v2 (isolated in its own 768d space)
    const vector = localMultilingualEmbedding(clean, EMBEDDING_DIM);
    return {
      vector,
      model: 'neo-embed-local-v2',
      dim: vector.length,
      runtime: 'embedded',
      isNeural: false,
    };
  }
}

export const embeddingEngine = new LocalEmbeddingEngine();
