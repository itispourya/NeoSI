import crypto from 'node:crypto';

export const EMBEDDING_DIM = 768;

/**
 * Normalize multilingual text (English, Persian, Arabic, Dutch):
 * Unifies Arabic/Persian Yeh/Kaf, strips diacritics/zero-width non-joiner variants cleanly,
 * and folds case while preserving meaningful Unicode letters and digits.
 */
export function normalizeMultilingualText(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '') // Strip Arabic/Persian diacritics
    .replace(/\u064A/g, '\u06CC') // Arabic Yeh -> Persian/Unified Yeh
    .replace(/\u0643/g, '\u06A9') // Arabic Kaf -> Persian/Unified Kaf
    .replace(/\u200c+/g, ' ') // ZWNJ to word boundary
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeMultilingual(text: string): string[] {
  const norm = normalizeMultilingualText(text);
  if (!norm) return [];
  return norm.split(' ').filter((w) => w.length >= 2);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  // Different embedding spaces must never be compared by truncating dimensions.
  if (!a.length || !b.length || a.length !== b.length) return 0;
  if (a.some((v) => !Number.isFinite(v)) || b.some((v) => !Number.isFinite(v))) return 0;
  const len = a.length;
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
 * neo-embed-local-v2: Local multilingual subword + token + bigram feature projection (768-d).
 * Works across EN, FA, AR, and NL without any external cloud AI service.
 * When a local neural embedding server (Ollama / vLLM / HF TEI) is configured,
 * `EmbeddingEngine` invokes it first and uses this engine as offline CPU fallback.
 */
export function localMultilingualEmbedding(text: string, dim = EMBEDDING_DIM): number[] {
  const vec = new Float64Array(dim);
  const tokens = tokenizeMultilingual(text);
  if (tokens.length === 0) return Array.from(vec);

  const addFeature = (feature: string, weight: number) => {
    const h = crypto.createHash('sha256').update(feature).digest();
    const idx1 = h.readUInt16BE(0) % dim;
    const sign1 = (h[2] & 1) === 0 ? 1 : -1;
    const idx2 = h.readUInt16BE(4) % dim;
    const sign2 = (h[6] & 1) === 0 ? 1 : -1;
    vec[idx1] += sign1 * weight;
    vec[idx2] += sign2 * (weight * 0.65);
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    // Whole word unigram
    addFeature(`w:${tok}`, 1.25);

    // Character n-grams (3 and 4) for morphological & cross-lingual similarity
    const padded = `^${tok}$`;
    if (padded.length >= 4) {
      for (let j = 0; j <= padded.length - 3; j++) {
        addFeature(`c3:${padded.slice(j, j + 3)}`, 0.32);
      }
    }
    if (padded.length >= 5) {
      for (let j = 0; j <= padded.length - 4; j++) {
        addFeature(`c4:${padded.slice(j, j + 4)}`, 0.42);
      }
    }

    // Word bigram
    if (i + 1 < tokens.length) {
      addFeature(`b:${tok}_${tokens[i + 1]}`, 0.9);
    }
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => Number((v / norm).toFixed(6)));
}

// Keep backward-compatible alias
export const deterministicTextEmbedding = localMultilingualEmbedding;

/**
 * Compute BM25 lexical relevance scores across candidate documents.
 */
export function computeBm25Scores(query: string, docs: string[]): number[] {
  const queryTerms = Array.from(new Set(tokenizeMultilingual(query)));
  if (queryTerms.length === 0 || docs.length === 0) return docs.map(() => 0);

  const docTokens = docs.map((d) => tokenizeMultilingual(d));
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / Math.max(1, docTokens.length);
  const k1 = 1.5;
  const b = 0.75;

  const docFreq = new Map<string, number>();
  for (const term of queryTerms) {
    let df = 0;
    for (const dt of docTokens) {
      if (dt.includes(term)) df++;
    }
    docFreq.set(term, df);
  }

  const N = docs.length;
  return docTokens.map((tokens) => {
    if (tokens.length === 0) return 0;
    const tfMap = new Map<string, number>();
    for (const t of tokens) tfMap.set(t, (tfMap.get(t) || 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
      const tf = tfMap.get(term) || 0;
      if (tf === 0) continue;
      const df = docFreq.get(term) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const num = tf * (k1 + 1);
      const den = tf + k1 * (1 - b + (b * tokens.length) / Math.max(1, avgLen));
      score += idf * (num / den);
    }
    return score;
  });
}

export function computeTemporalDecay(createdAtIso: string, halfLifeDays = 90): number {
  const createdMs = new Date(createdAtIso).getTime();
  if (!Number.isFinite(createdMs)) return 1.0;
  const ageDays = Math.max(0, (Date.now() - createdMs) / 86_400_000);
  const decay = Math.pow(0.5, ageDays / halfLifeDays);
  return Number(Math.max(0.25, Math.min(1.0, decay)).toFixed(4));
}

export interface HybridRankInput<T> {
  item: T;
  vectorScore: number;
  lexicalScore: number;
  reliability: number;
  importance: number;
  freshness: number;
}

/**
 * Reciprocal Rank Fusion + trust/temporal weighting for hybrid retrieval reranking.
 */
export function hybridRerank<T>(candidates: Array<HybridRankInput<T>>): Array<T & { similarity: number; hybridScore: number }> {
  if (candidates.length === 0) return [];
  const k = 40;

  const byVec = [...candidates]
    .map((c, idx) => ({ idx, score: c.vectorScore }))
    .sort((a, b) => b.score - a.score);
  const byLex = [...candidates]
    .map((c, idx) => ({ idx, score: c.lexicalScore }))
    .sort((a, b) => b.score - a.score);

  const vecRank = new Map<number, number>();
  const lexRank = new Map<number, number>();
  byVec.forEach((entry, rank) => vecRank.set(entry.idx, rank + 1));
  byLex.forEach((entry, rank) => lexRank.set(entry.idx, rank + 1));

  return candidates
    .map((c, idx) => {
      const rrf =
        (c.vectorScore > 0 ? 1 / (k + (vecRank.get(idx) || k)) : 0) +
        (c.lexicalScore > 0 ? 1 / (k + (lexRank.get(idx) || k)) : 0);
      const trust = 0.45 * c.reliability + 0.3 * c.importance + 0.25 * c.freshness;
      const hybridScore = Number((rrf * 20 * (0.65 + 0.35 * trust) + c.vectorScore * 0.35).toFixed(4));
      return {
        ...c.item,
        similarity: Number(c.vectorScore.toFixed(4)),
        hybridScore,
      };
    })
    .sort((a, b) => b.hybridScore - a.hybridScore);
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
