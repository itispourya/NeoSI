import { env } from '../config/env.ts';
import { EMBEDDING_DIM, localMultilingualEmbedding } from '../db/vector.ts';

export interface EmbeddingResult {
  vector: number[];
  model: string;
  dim: number;
  runtime: 'ollama' | 'vllm' | 'transformers' | 'embedded';
  isNeural: boolean;
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
          const emb = data.embeddings?.[0];
          if (Array.isArray(emb) && emb.length > 0) {
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
            return {
              vector: emb,
              model: env.embeddingModel,
              dim: emb.length,
              runtime: env.vllmBaseUrl ? 'vllm' : 'transformers',
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
