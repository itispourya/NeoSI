import { env } from '../config/env.ts';
import { EMBEDDING_DIM, localMultilingualEmbedding } from '../db/vector.ts';

function fitDimension(vec: number[], targetDim = EMBEDDING_DIM): number[] {
  if (vec.length === targetDim) return vec;
  if (vec.length > targetDim) return vec.slice(0, targetDim);
  return [...vec, ...new Array<number>(targetDim - vec.length).fill(0)];
}

export class LocalEmbeddingEngine {
  async embed(text: string): Promise<{ vector: number[]; model: string; runtime: string }> {
    const clean = String(text || '').slice(0, 8000);
    if (!clean.trim()) {
      return { vector: new Array<number>(EMBEDDING_DIM).fill(0), model: env.embeddingModel, runtime: 'embedded' };
    }

    // 1. Try Ollama local embedding server if embeddingModel looks like an Ollama model (e.g. bge-m3:latest, nomic-embed-text)
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
          const emb = data.embeddings?.[0];
          if (Array.isArray(emb) && emb.length > 0) {
            return { vector: fitDimension(emb), model: env.embeddingModel, runtime: 'ollama' };
          }
        }
      } catch {
        // Graceful fallback to CPU-native multilingual embedder
      }
    }

    // 2. Try vLLM / HuggingFace TEI OpenAI-compatible local /v1/embeddings endpoint
    const compatBase = (env.vllmBaseUrl || env.hfBaseUrl || env.customInferenceUrl || '').replace(/\/+$/, '');
    if (compatBase && env.embeddingModel !== 'neo-embed-local-v2') {
      try {
        const res = await fetch(`${compatBase}/v1/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: env.embeddingModel, input: clean }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
          const emb = data.data?.[0]?.embedding;
          if (Array.isArray(emb) && emb.length > 0) {
            return { vector: fitDimension(emb), model: env.embeddingModel, runtime: env.vllmBaseUrl ? 'vllm' : 'transformers' };
          }
        }
      } catch {
        // Fallback below
      }
    }

    // 3. Always-available CPU-native neo-embed-local-v2
    return {
      vector: localMultilingualEmbedding(clean, EMBEDDING_DIM),
      model: 'neo-embed-local-v2',
      runtime: 'embedded',
    };
  }
}

export const embeddingEngine = new LocalEmbeddingEngine();
