import assert from 'node:assert/strict';
import test from 'node:test';
import { taskPlanner } from './planner.ts';

test('deterministic planning always respects step and tool-call budgets', () => {
  const plan = taskPlanner.buildPlan(
    'Research the latest Neos accounting code in the repo and calculate 12 * 19, then audit CRM inventory runway.',
    'low'
  );

  assert.equal(plan.valid, true);
  assert.ok(plan.steps.length <= plan.budgets.maxSteps);
  assert.ok(plan.steps.filter((step) => step.toolId).length <= plan.budgets.maxToolCalls);
  assert.equal(plan.steps[0].actionType, 'memory_search');
  assert.equal(plan.steps.at(-2)?.actionType, 'reason');
  assert.equal(plan.steps.at(-1)?.actionType, 'verify');

  for (const step of plan.steps) {
    assert.ok(step.dependsOn.every((dependency) => dependency >= 0 && dependency < step.stepIndex));
  }
});

test('plan validation rejects duplicate, forward, and missing dependencies', () => {
  const validation = taskPlanner.validatePlan([
    { stepIndex: 0, title: 'Memory', actionType: 'memory_search', toolId: 'memory_search', dependsOn: [] },
    { stepIndex: 1, title: 'Synthesize', actionType: 'reason', dependsOn: [2] },
    { stepIndex: 1, title: 'Verify', actionType: 'verify', dependsOn: [9] },
  ], { maxSteps: 6, maxToolCalls: 4, maxDurationMs: 10_000 });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('Duplicate step index')));
  assert.ok(validation.errors.some((error) => error.includes('forward dependency')));
  assert.ok(validation.errors.some((error) => error.includes('missing or invalid step')));
});

test('plan validation rejects tool calls that exceed the declared budget', () => {
  const validation = taskPlanner.validatePlan([
    { stepIndex: 0, title: 'Memory', actionType: 'memory_search', toolId: 'memory_search', dependsOn: [] },
    { stepIndex: 1, title: 'Tool one', actionType: 'tool_call', toolId: 'math_evaluate', dependsOn: [0] },
    { stepIndex: 2, title: 'Tool two', actionType: 'tool_call', toolId: 'workspace_list_files', dependsOn: [0] },
    { stepIndex: 3, title: 'Synthesize', actionType: 'reason', dependsOn: [0, 1, 2] },
    { stepIndex: 4, title: 'Verify', actionType: 'verify', dependsOn: [3] },
  ], { maxSteps: 6, maxToolCalls: 2, maxDurationMs: 10_000 });

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('exceeds maxToolCalls')));
});
