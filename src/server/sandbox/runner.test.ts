import test from 'node:test';
import assert from 'node:assert/strict';
import { executeHandlerInSandbox, runTestsInSandbox } from './runner';

test('sandbox executes pure handler and returns structured JSON', () => {
  const code = `function handle(input) { return { doubled: input.n * 2 }; }`;
  const res = executeHandlerInSandbox<{ doubled: number }>(code, { n: 21 });
  assert.equal(res.ok, true);
  assert.equal(res.output?.doubled, 42);
});

test('sandbox blocks access to process, require, fs, and globalThis', () => {
  const evil = `function handle() { return process.env; }`;
  const res = executeHandlerInSandbox(evil, {});
  assert.equal(res.ok, false);
  assert.match(res.error || '', /Disallowed symbol/);
});

test('sandbox enforces wall-clock timeout against infinite loops', () => {
  const infinite = `function handle() { while (true) {} }`;
  const res = executeHandlerInSandbox(infinite, {}, 100);
  assert.equal(res.ok, false);
  assert.match(res.error || '', /timed out/i);
});

test('sandbox unit test runner accurately counts passed and failed assertions', () => {
  const code = `function handle(input) { return input.a + input.b; }`;
  const tests = `
    test('adds positive numbers', () => { assert.equal(handle({ a: 2, b: 3 }), 5); });
    test('adds negative numbers', () => { assert.equal(handle({ a: -1, b: 4 }), 3); });
  `;
  const report = runTestsInSandbox(code, tests);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.total, 2);
});
