import crypto from 'node:crypto';

export const EMBEDDING_DIM = 768;

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Deterministic hashed n-gram projection embedding fallback (768-dim)
 * used only when an external embedding API is unreachable or in offline tests.
 */
export function deterministicTextEmbedding(text: string, dim = EMBEDDING_DIM): number[] {
  const vec = new Float64Array(dim);
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const unigramHash = crypto.createHash('sha256').update(tok).digest();
    const idx1 = unigramHash.readUInt16BE(0) % dim;
    const sign1 = (unigramHash[2] & 1) === 0 ? 1 : -1;
    vec[idx1] += sign1 * 1.0;

    if (i + 1 < tokens.length) {
      const bigramHash = crypto.createHash('sha256').update(`${tok}_${tokens[i + 1]}`).digest();
      const idx2 = bigramHash.readUInt16BE(0) % dim;
      const sign2 = (bigramHash[2] & 1) === 0 ? 1 : -1;
      vec[idx2] += sign2 * 0.7;
    }
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => Number((v / norm).toFixed(6)));
}

export function chunkText(text: string, maxChars = 1400, overlap = 180): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      const lastNewline = clean.lastIndexOf('\n', end);
      const lastPeriod = clean.lastIndexOf('. ', end);
      const breakPoint = Math.max(lastNewline, lastPeriod);
      if (breakPoint > start + Math.floor(maxChars * 0.5)) {
        end = breakPoint + 1;
      }
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
