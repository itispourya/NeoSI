import assert from 'node:assert/strict';
import test from 'node:test';
import { criticEngine } from './critic.ts';

test('critic does not pass a current-events request without external evidence', () => {
  const verdict = criticEngine.verify({
    goal: 'Find the latest news about local model releases today',
    draftResponse: 'There have been several recent developments in local model releases.',
  });
  assert.equal(verdict.passed, false);
  assert.ok(verdict.issues.some((issue) => issue.includes('external evidence')));
});

test('critic does not pass when every required tool execution failed', () => {
  const verdict = criticEngine.verify({
    goal: 'Research and compare current model pricing',
    draftResponse: 'The options have different pricing structures and trade-offs.',
    toolOutputs: [{ toolId: 'web_research', ok: false, error: 'network unavailable' }],
  });
  assert.equal(verdict.passed, false);
  assert.ok(verdict.issues.some((issue) => issue.includes('failed')));
});

test('critic requires deterministic tool evidence for arithmetic requests', () => {
  const verdict = criticEngine.verify({
    goal: 'Calculate 19 * 23',
    draftResponse: '19 * 23 = 437.',
  });
  assert.equal(verdict.passed, false);
});

test('critic does not accept successful memory search as external research evidence', () => {
  const verdict = criticEngine.verify({
    goal: 'Research the latest model release and compare current pricing',
    draftResponse: 'The model has a recent release and competitive pricing.',
    evidenceSnippets: ['Prior internal memory about the model.'],
    toolOutputs: [{ toolId: 'memory_search', ok: true, output: { matches: 3 } }],
  });
  assert.equal(verdict.passed, false);
  assert.ok(verdict.issues.some((issue) => issue.includes('external evidence')));
});

test('critic accepts external research only when citations are present', () => {
  const verdict = criticEngine.verify({
    goal: 'Research current model release status and cite sources',
    draftResponse: 'The release status is documented in the retrieved source.',
    toolOutputs: [{
      toolId: 'web_research',
      ok: true,
      output: { citationCount: 1, citations: [{ url: 'https://example.com/source' }] },
    }],
  });
  assert.equal(verdict.passed, true);
});

test('critic can pass a general explanatory response without requiring web sources', () => {
  const verdict = criticEngine.verify({
    goal: 'Explain what a database index does',
    draftResponse: 'A database index is an auxiliary data structure that helps the database locate rows more efficiently.',
  });
  assert.equal(verdict.passed, true);
});
