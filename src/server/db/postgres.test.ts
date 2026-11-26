import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPostgresLexicalFilter } from './postgres.ts';

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
