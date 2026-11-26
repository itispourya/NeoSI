import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPostgresLexicalFilter, buildPostgresMemoryFilters } from './postgres.ts';

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
