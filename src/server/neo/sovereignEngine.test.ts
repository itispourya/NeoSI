import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distillTextLocally,
  executePromotedModule,
  listPromotedModules,
  promoteVerifiedModule,
  removePromotedModule,
} from './sovereignEngine';

test('distillTextLocally extracts topic-relevant facts without external AI', () => {
  const sample =
    'Random filler sentence about weather today. TypeScript 5.8 improves startup speed by 18% through isolated declarations. Another unrelated note. Always run unit tests inside a sandbox before merging.';
  const res = distillTextLocally('TypeScript 5.8 startup', 'TS Performance', sample);
  assert.equal(res.title, 'TS Performance');
  assert.ok(res.distilledSummary.includes('18%'));
  assert.equal(res.structuredFacts.engine, 'neo-local-extractive');
});

test('promoted modules can be saved, listed, executed in sandbox, and rolled back', () => {
  const id = 'test-mod-1';
  promoteVerifiedModule(id, 'src/server/modules/adder.js', 'function handle(i) { return { sum: i.a + i.b }; }');
  const listed = listPromotedModules();
  assert.ok(listed.some((m) => m.id === id));

  const exec = executePromotedModule(id, { a: 7, b: 8 });
  assert.equal(exec.ok, true);
  assert.deepEqual(exec.output, { sum: 15 });

  assert.equal(removePromotedModule(id), true);
});
