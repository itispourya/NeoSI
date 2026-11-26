import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEmbeddingVector } from './embeddings.ts';

test('embedding normalization accepts finite non-zero vectors and produces unit norm', () => {
  const normalized = normalizeEmbeddingVector([3, 4]);
  assert.ok(normalized);
  assert.equal(normalized.length, 2);
  assert.ok(Math.abs(Math.hypot(...normalized) - 1) < 1e-12);
});

test('embedding normalization rejects empty, zero, non-finite, and oversized vectors', () => {
  assert.equal(normalizeEmbeddingVector([]), null);
  assert.equal(normalizeEmbeddingVector([0, 0, 0]), null);
  assert.equal(normalizeEmbeddingVector([1, Number.NaN]), null);
  assert.equal(normalizeEmbeddingVector([1, Number.POSITIVE_INFINITY]), null);
  assert.equal(normalizeEmbeddingVector(new Array(16_001).fill(1)), null);
});
