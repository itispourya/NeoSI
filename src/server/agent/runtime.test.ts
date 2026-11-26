import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentRuntime } from './runtime.ts';
import { getDb, resetDbForTests } from '../db/adapter.ts';
import { evaluateSkill, prepareAndRunTrainingJob, runCodeEvolutionProposal } from '../evolution/pipeline.ts';
import { modelRegistry } from '../inference/registry.ts';
import { runMemoryConsolidation } from '../knowledge/consolidation.ts';
import { knowledgeGraph } from '../knowledge/graph.ts';
import { storeMemory } from '../knowledge/memory.ts';
import { autonomousScheduler } from '../scheduler/autonomousScheduler.ts';
import { toolRegistry } from '../tools/registry.ts';

let tempDir = '';

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-runtime-test-'));
  await resetDbForTests(path.join(tempDir, 'neo-test.sqlite'));
  await toolRegistry.syncBuiltInToolsToDb();
});

test.after(async () => {
  await resetDbForTests();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('7-layer memory storage, temporal superseding, and consolidation work persistently', async () => {
  const m1 = await storeMemory({
    tenantId: 'global',
    memoryType: 'temporal',
    topic: 'vat-rate',
    title: 'Active VAT Rate',
    content: 'Standard VAT rate is 9% for Q1 2026.',
  });
  const m2 = await storeMemory({
    tenantId: 'global',
    memoryType: 'temporal',
    topic: 'vat-rate',
    title: 'Active VAT Rate',
    content: 'Standard VAT rate is 10% for Q2 2026.',
  });

  const db = await getDb();
  const prev = await db.getMemoryById(m1.id, 'global', false);
  assert.equal(prev?.superseded_by, m2.id);

  // Store 3 episodic events on same topic and verify consolidation promotes a semantic insight
  for (let i = 1; i <= 3; i++) {
    await storeMemory({
      tenantId: 'global',
      memoryType: 'episodic',
      topic: 'pos-sync',
      title: `POS Sync Episode ${i}`,
      content: `Synchronized batch ${i} from Neos POS ledger successfully.`,
    });
  }
  const summary = await runMemoryConsolidation();
  assert.ok(summary.consolidatedSemantic >= 1);
});

test('hybrid memory search can retrieve exact lexical matches older than the recent vector window', async () => {
  const db = await getDb();
  const vector = new Array<number>(768).fill(1);
  const base = {
    tenant_id: 'global',
    memory_type: 'semantic' as const,
    topic: 'archive',
    title: 'Archived note',
    content: 'Ordinary historical knowledge without the rare lookup phrase.',
    structured_facts: {},
    source_url: null,
    reliability_score: 0.9,
    freshness_score: 1,
    embedding: vector,
    embedding_model: 'test-embedding-space-v1',
    embedding_dim: 768,
  };
  const older = await db.insertMemory({
    ...base,
    title: 'Zebra Quasar Ledger Reconciliation',
    content: 'The zebra quasar ledger phrase identifies the archived reconciliation procedure.',
  });
  for (let i = 0; i < 510; i++) {
    await db.insertMemory({ ...base, title: `Recent noise note ${i}`, content: `Unrelated record ${i} with generic operational details.` });
  }

  const results = await db.searchMemories(vector, {
    tenantId: 'global',
    queryText: 'zebra quasar ledger reconciliation',
    queryEmbeddingModel: 'test-embedding-space-v1',
    limit: 5,
  });
  assert.ok(results.some((memory) => memory.id === older.id));
});

test('Dynamic API slugs and call counters remain isolated by workspace', async () => {
  const db = await getDb();
  const base = {
    tenant_id: 'forge-tenant-a',
    slug: 'tenant-isolated-endpoint',
    name: 'Tenant A Endpoint',
    description: 'Isolation regression test',
    method: 'POST' as const,
    input_schema: { type: 'object' as const },
    output_schema: { type: 'object' as const },
    handler_code: 'function handle(input) { return input; }',
    test_code: "test('identity', () => { assert.equal(handle({ value: 1 }).value, 1); });",
    test_report: { passed: 1, failed: 0, total: 1, durationMs: 1, details: [] },
    openapi_spec: {},
    rate_limit_rpm: 60,
    enabled: true,
  };
  const created = await db.upsertDynamicApi(base);
  assert.equal(created.tenant_id, 'forge-tenant-a');

  await assert.rejects(
    () => db.upsertDynamicApi({ ...base, tenant_id: 'forge-tenant-b', name: 'Tenant B takeover' }),
    /reserved by another workspace/i
  );

  await db.incrementDynamicApiCalls(base.slug, 'forge-tenant-b');
  assert.equal((await db.getDynamicApiBySlug(base.slug, 'forge-tenant-a'))?.call_count, 0);

  await db.incrementDynamicApiCalls(base.slug, 'forge-tenant-a');
  assert.equal((await db.getDynamicApiBySlug(base.slug, 'forge-tenant-a'))?.call_count, 1);
});

test('Knowledge Graph entity resolution, contradiction detection, and BFS traversal', async () => {
  const src = await knowledgeGraph.upsertEntity({ tenantId: 'global', name: 'Neos Core', entityType: 'system' });
  const tgtA = await knowledgeGraph.upsertEntity({ tenantId: 'global', name: 'Ollama Runtime', entityType: 'runtime' });
  const tgtB = await knowledgeGraph.upsertEntity({ tenantId: 'global', name: 'vLLM Cluster', entityType: 'runtime' });

  const r1 = await knowledgeGraph.addRelationship({
    tenantId: 'global',
    sourceEntityId: src.id,
    targetEntityId: tgtA.id,
    relationType: 'primary_backend',
  });
  const r2 = await knowledgeGraph.addRelationship({
    tenantId: 'global',
    sourceEntityId: src.id,
    targetEntityId: tgtB.id,
    relationType: 'primary_backend',
  });
  assert.equal(r2.contradicts_id, r1.id);

  const sub = await knowledgeGraph.traverse('global', src.id, 2);
  assert.ok(sub.nodes.length >= 3);
  assert.ok(sub.edges.length >= 2);

  // Evidence-grounded SVO extraction creates explicit edges without fabricating co-occurrence
  const extracted = await knowledgeGraph.extractFromText(
    'global',
    'Neos Core uses PostgreSQL for persistence. Coffee Mug sits quietly.',
    'https://docs.neo.local/arch'
  );
  assert.ok(extracted.entitiesAdded >= 2);
  assert.ok(extracted.relationshipsAdded >= 1);
  const edges = await (await getDb()).listRelationships('global', undefined, 50);
  assert.ok(edges.some((e) => e.relation_type === 'uses' && typeof e.properties?.evidence === 'string'));
  assert.equal(edges.some((e) => e.relation_type === 'co_occurs_with'), false);
});

test('ToolRegistry validates Zod schemas, enforces scopes, and blocks path traversal/secret files', async () => {
  const mathOk = await toolRegistry.executeTool(
    'math_evaluate',
    { expression: '(10 + 5) * 4' },
    { tenantId: 'global', actor: 'test', scopes: ['read'] }
  );
  assert.equal(mathOk.ok, true);
  assert.equal(mathOk.output?.value, 60);

  // Scope enforcement blocks 'write'-scoped tool for 'read'-only key
  const denied = await toolRegistry.executeTool(
    'sandbox_execute_js',
    { code: 'function handle(i){return i;}', input: {} },
    { tenantId: 'global', actor: 'test', scopes: ['read'] }
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error || '', /Permission denied/);

  // Path traversal & .env protection
  const traversal = await toolRegistry.executeTool(
    'workspace_read_file',
    { filePath: '../../etc/passwd' },
    { tenantId: 'global', actor: 'test', scopes: ['read'] }
  );
  assert.equal(traversal.ok, false);

  const envRead = await toolRegistry.executeTool(
    'workspace_read_file',
    { filePath: '.env.example' },
    { tenantId: 'global', actor: 'test', scopes: ['read'] }
  );
  assert.equal(envRead.ok, false);

  // Symlink parent escape protection for non-existent descendant files
  const escapeLinkPath = path.join(process.cwd(), 'tmp-test-escape-link');
  try {
    fs.symlinkSync(os.tmpdir(), escapeLinkPath);
    const symlinkRead = await toolRegistry.executeTool(
      'workspace_read_file',
      { filePath: 'tmp-test-escape-link/non-existent-file.txt' },
      { tenantId: 'global', actor: 'test', scopes: ['read'] }
    );
    assert.equal(symlinkRead.ok, false);
    assert.match(symlinkRead.error || '', /Symlink escape blocked/i);
  } finally {
    fs.rmSync(escapeLinkPath, { force: true });
  }

  // memory_search tool enforces embedding-space isolation
  const db = await getDb();
  await db.insertMemory({
    tenant_id: 'global',
    memory_type: 'semantic',
    topic: 'foreign-space',
    title: 'Foreign Embedding Note',
    content: 'Foreign space record with identical dummy vector only.',
    structured_facts: {},
    source_url: null,
    reliability_score: 0.9,
    freshness_score: 1,
    embedding: new Array<number>(768).fill(1),
    embedding_model: 'foreign-incompatible-embed-v99',
    embedding_dim: 768,
  });
  const searchToolRes = await toolRegistry.executeTool(
    'memory_search',
    { query: 'unrelated token xyzzy', limit: 10 },
    { tenantId: 'global', actor: 'test', scopes: ['read'] }
  );
  assert.equal(searchToolRes.ok, true);
  const matches = (searchToolRes.output?.matches || []) as Array<{ title: string }>;
  assert.equal(matches.some((m) => m.title === 'Foreign Embedding Note'), false);
});

test('Durable AgentRuntime persists steps, executes tools, cancels cleanly, and recovers interrupted tasks', async () => {
  const task = await agentRuntime.createAndStartTask({
    tenantId: 'global',
    actor: 'test',
    goal: 'Evaluate (100 * 3) + 50 and verify consistency',
    deferExecution: true,
  });

  const finished = await agentRuntime.executeTaskLoop(task.id, 'global', 'test', ['read', 'write']);
  assert.equal(finished?.status, 'completed');
  assert.ok((finished?.usage.stepsExecuted || 0) >= 3);

  // Verify boot-time recovery picks up tasks stuck in 'running' status
  const interrupted = await agentRuntime.createAndStartTask({
    tenantId: 'global',
    actor: 'crash-sim',
    goal: 'Recover interrupted check for 25 + 25',
    deferExecution: true,
  });
  const db = await getDb();
  await db.updateTask(interrupted.id, { status: 'running' });
  const recoveredCount = await agentRuntime.recoverInterruptedTasks();
  assert.ok(recoveredCount >= 1);
  await new Promise((r) => setTimeout(r, 400));
  const afterRecovery = await db.getTaskById(interrupted.id, 'global');
  assert.equal(afterRecovery?.status, 'completed');
});

test('Agent execution never escalates beyond the scopes stored at task creation', async () => {
  const task = await agentRuntime.createAndStartTask({
    tenantId: 'global',
    actor: 'scope-regression',
    goal: 'Inspect code and run the requested workspace operation',
    scopes: ['read'],
    deferExecution: true,
  });
  const db = await getDb();
  const steps = await db.listTaskSteps(task.id, 'global');
  const candidate = steps.find((step) => step.tool_id === 'workspace_list_files');
  assert.ok(candidate, 'deterministic code-inspection plan should contain workspace_list_files');
  await db.upsertTaskStep({
    ...candidate!,
    action_type: 'tool_call',
    tool_id: 'sandbox_execute_js',
    input: { code: 'function handle(input) { return input; }', input: { value: 1 } },
  });

  const finished = await agentRuntime.executeTaskLoop(task.id, 'global', 'scope-regression', ['read', 'write']);
  const finalSteps = await db.listTaskSteps(task.id, 'global');
  const deniedStep = finalSteps.find((step) => step.step_index === candidate!.step_index);
  assert.equal(deniedStep?.status, 'failed');
  assert.match(deniedStep?.error || '', /Permission denied/i);
  assert.notEqual(finished?.status, 'completed');
  assert.deepEqual(finished?.checkpoint.executionScopes, ['read']);
});

test('atomic task transitions prevent late completion from overwriting cancellation', async () => {
  const task = await agentRuntime.createAndStartTask({
    tenantId: 'global',
    actor: 'cancel-race-test',
    goal: 'Check atomic task status transitions',
    deferExecution: true,
  });
  const db = await getDb();
  const claimed = await db.updateTaskIfStatus(task.id, 'global', ['planning'], { status: 'running' });
  assert.equal(claimed?.status, 'running');

  const cancelled = await db.updateTaskIfStatus(task.id, 'global', ['running'], {
    status: 'cancelled',
    completed_at: new Date().toISOString(),
  });
  assert.equal(cancelled?.status, 'cancelled');

  const lateCompletion = await db.updateTaskIfStatus(task.id, 'global', ['running'], {
    status: 'completed',
    result: { answer: 'late' },
  });
  assert.equal(lateCompletion, null);
  assert.equal((await db.getTaskById(task.id, 'global'))?.status, 'cancelled');
});

test('ModelRegistry checks hardware/licenses & Layer A/C/D evolution run end-to-end', async () => {
  await assert.rejects(
    () =>
      modelRegistry.registerCandidateModel({
        id: 'proprietary-bad',
        name: 'Proprietary',
        runtime: 'vllm',
        architecture: 'unknown',
        source_repo: 'example/prop',
        license: 'Proprietary-Commercial',
      }),
    /verified open-weight license/i
  );

  const compat = await modelRegistry.discoverCompatibleModels();
  assert.ok(compat.some((m) => m.id === 'neo-embedded-core-v1' && m.compatible));

  const db = await getDb();
  const skills = await db.listSkills();
  assert.ok(skills.length > 0);
  const skillEval = await evaluateSkill(skills[0].id);
  assert.equal(skillEval.passed, true);

  const proposal = await runCodeEvolutionProposal('unit-test-evolution');
  assert.equal(proposal.status, 'sandbox_passed');
  assert.equal(proposal.auto_eligible, false);
  assert.ok(proposal.test_results.passed >= 2);
  assert.ok(proposal.benchmark_before.accuracyScore > 0);
  assert.ok(proposal.benchmark_after.accuracyScore > 0);

  const trainJob = await prepareAndRunTrainingJob({
    tenantId: 'global',
    baseModelId: 'qwen2.5:3b-instruct',
    method: 'dataset_only',
  });
  assert.ok(trainJob.dataset_size >= 1);
  assert.ok(trainJob.dataset_path && fs.existsSync(trainJob.dataset_path));
  assert.equal(trainJob.status, 'dataset_ready_training_not_started');
  assert.equal(trainJob.metrics.trainingStarted, false);
  assert.equal(trainJob.metrics.adapterProduced, false);

  const objReview = await autonomousScheduler.executeJobKind('objectives_review');
  assert.ok(Number(objReview.objectivesReviewed) >= 1);
});
