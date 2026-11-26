import test from 'node:test';
import assert from 'node:assert/strict';
import { selectResearchEvidence } from './research.ts';
import type { DiscoveredSource } from '../search/webSearch.ts';

function source(overrides: Partial<DiscoveredSource> = {}): DiscoveredSource {
  return {
    title: 'Example source',
    url: 'https://example.org/research',
    snippet: 'A relevant result',
    content: 'Content with supporting evidence.',
    sourceType: 'web',
    author: null,
    provider: 'direct_fetch',
    reliabilityScore: 0.75,
    qualityBreakdown: {
      primarySource: 0.7, authorCredibility: 0.6, evidenceDensity: 0.7,
      recency: 0.7, methodology: 0.7, corroboration: 0.6, relevance: 0.8,
    },
    injectionFlagged: false,
    contentHash: 'abc123',
    ...overrides,
  };
}

test('research evidence selector accepts valid trusted HTTP(S) source', () => {
  assert.deepEqual(selectResearchEvidence([source()]), [source()]);
});

test('research evidence selector rejects injection-flagged source', () => {
  assert.deepEqual(selectResearchEvidence([source({ injectionFlagged: true })]), []);
});

test('research evidence selector rejects low-reliability source', () => {
  assert.deepEqual(selectResearchEvidence([source({ reliabilityScore: 0.49 })]), []);
});

test('research evidence selector rejects non-http and malformed URLs', () => {
  assert.deepEqual(selectResearchEvidence([source({ url: 'file:///etc/passwd' }), source({ url: 'not a url' })]), []);
});

test('research evidence selector rejects empty content and non-finite scores', () => {
  assert.deepEqual(selectResearchEvidence([source({ content: '  ' }), source({ reliabilityScore: Number.NaN })]), []);
});

test('research evidence selector allows explicit threshold override', () => {
  assert.equal(selectResearchEvidence([source({ reliabilityScore: 0.4 })], 0.35).length, 1);
});
