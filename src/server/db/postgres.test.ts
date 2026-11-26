import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresNeoDatabase } from './postgres.ts';
import {
  buildPostgresLexicalFilter,
  buildPostgresMemoryFilters,
  buildPostgresUpdateTaskIfStatusQuery,
  toPgVectorLiteral,
} from './postgres.ts';

test('PostgreSQL memory filters bind tenant and valid-time parameters', () => {
  const filters = buildPostgresMemoryFilters({
    memoryType: 'semantic',
    tenantId: 'tenant-42',
    includeGlobal: true,
    validAt: '2026-11-26T00:00:00.000Z',
  });
  assert.deepEqual(filters.clauses, [
    'deleted_at IS NULL',
    'memory_type = $1',
    '(tenant_id = $2 OR tenant_id = $3)',
    '(valid_from IS NULL OR valid_from <= $4) AND (valid_to IS NULL OR valid_to >= $4)',
  ]);
  assert.deepEqual(filters.params, ['semantic', 'tenant-42', 'global', '2026-11-26T00:00:00.000Z']);
  assert.equal(filters.nextParameterIndex, 5);
});

test('PostgreSQL memory filters do not add tenant or date conditions when omitted', () => {
  const filters = buildPostgresMemoryFilters();
  assert.deepEqual(filters.clauses, ['deleted_at IS NULL']);
  assert.deepEqual(filters.params, []);
  assert.equal(filters.nextParameterIndex, 1);
});

test('PostgreSQL lexical filter uses positional bind placeholders', () => {
  const filter = buildPostgresLexicalFilter(['zebra', 'quasar'], 3);
  assert.equal(
    filter.sql,
    '((topic ILIKE $3 OR title ILIKE $3 OR content ILIKE $3) OR (topic ILIKE $4 OR title ILIKE $4 OR content ILIKE $4))'
  );
  assert.deepEqual(filter.params, ['%zebra%', '%quasar%']);
  assert.equal(filter.nextParameterIndex, 5);
});

test('PostgreSQL lexical filter handles duplicate and empty terms safely', () => {
  const filter = buildPostgresLexicalFilter(['zebra', 'zebra', '   '], 1);
  assert.equal(filter.sql, '((topic ILIKE $1 OR title ILIKE $1 OR content ILIKE $1))');
  assert.deepEqual(filter.params, ['%zebra%']);
  assert.equal(filter.nextParameterIndex, 2);
});

test('PostgreSQL lexical filter rejects invalid parameter indices', () => {
  assert.throws(() => buildPostgresLexicalFilter(['term'], 0), /start at 1/);
});

test('PostgreSQL updateTaskIfStatus emits valid $N positional placeholders', () => {
  const query = buildPostgresUpdateTaskIfStatusQuery(
    'task-1',
    'tenant-1',
    ['planning', 'running'],
    {
      status: 'completed',
      error: null,
      result: { answer: 'done' },
    }
  );
  assert.ok(query);
  assert.equal(
    query.sql,
    'UPDATE tasks SET status = $1, error = $2, result = $3, updated_at = NOW() WHERE id = $4 AND tenant_id = $5 AND status = ANY($6::text[]) RETURNING *'
  );
  assert.deepEqual(query.values, ['completed', null, JSON.stringify({ answer: 'done' }), 'task-1', 'tenant-1', ['planning', 'running']]);
});

test('toPgVectorLiteral formats valid vectors and rejects non-finite or empty vectors', () => {
  assert.equal(toPgVectorLiteral([0.1, -2.5, 3]), '[0.1,-2.5,3]');
  assert.equal(toPgVectorLiteral([]), null);
  assert.throws(() => toPgVectorLiteral([0.1, Number.NaN]), /finite numeric dimensions/);
  assert.throws(() => toPgVectorLiteral([Number.POSITIVE_INFINITY]), /finite numeric dimensions/);
});


test('PostgreSQL migrations and tenant-scoped vector/lexical memory operations work against a real server', { skip: !process.env.NEO_TEST_POSTGRES_URL }, async () => {
  const db = new PostgresNeoDatabase(process.env.NEO_TEST_POSTGRES_URL!);
  try {
    await db.init();
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const tenant = await db.createTenant({
      name: 'Postgres Integration ' + suffix,
      slug: 'pg-test-' + suffix,
      workspace_language: 'en',
      webhook_url: null,
      webhook_secret: null,
      pii_redaction: true,
      rate_limit_rpm: 120,
    });
    const memory = await db.insertMemory({
      tenant_id: tenant.id,
      memory_type: 'semantic',
      topic: 'integration',
      title: 'Postgres Vector Integration Probe',
      content: 'pgvector integration phrase confirms PostgreSQL memory persistence.',
      structured_facts: {},
      source_url: null,
      reliability_score: 0.9,
      freshness_score: 1,
      embedding: [0.1, 0.2, 0.3],
      embedding_model: 'integration-test-vector-v1',
      embedding_dim: 3,
    });
    const fetched = await db.getMemoryById(memory.id, tenant.id);
    assert.equal(fetched?.content, memory.content);
    const matches = await db.searchMemories([0.1, 0.2, 0.3], {
      tenantId: tenant.id,
      queryEmbeddingModel: 'integration-test-vector-v1',
      queryText: 'pgvector integration phrase',
      limit: 5,
      minScore: 0,
    });
    assert.ok(matches.some((item) => item.id === memory.id), 'Inserted memory should be found by hybrid search');
    assert.equal(await db.getMemoryById(memory.id, 'different-tenant'), null, 'Memory must not cross tenant boundary');
    await db.deleteMemory(memory.id, tenant.id, true);
  } finally {
    await db.close();
  }
});
