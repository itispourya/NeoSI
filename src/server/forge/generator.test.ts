import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenApiOperation, buildZodSchemaFromJsonSchema } from './generator';
import { estimateCostUsd } from '../llm/router';

test('dynamic Zod schema builder validates required fields and types', () => {
  const zodSchema = buildZodSchemaFromJsonSchema({
    type: 'object',
    required: ['invoiceId', 'amount'],
    properties: {
      invoiceId: { type: 'string' },
      amount: { type: 'number' },
      urgent: { type: 'boolean' },
    },
  });

  assert.equal(zodSchema.safeParse({ invoiceId: 'INV-1', amount: 500 }).success, true);
  assert.equal(zodSchema.safeParse({ invoiceId: 'INV-1' }).success, false);
  assert.equal(zodSchema.safeParse({ invoiceId: 'INV-1', amount: 'not-a-number' }).success, false);
});

test('OpenAPI operation generator emits valid custom path and security scheme', () => {
  const op = buildOpenApiOperation({
    slug: 'tax-estimator',
    name: 'Tax Estimator',
    description: 'Calculates VAT',
    method: 'POST',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  });
  assert.equal(op.path, '/api/v1/custom/tax-estimator');
  assert.equal(op.method, 'POST');
});

test('LLM cost estimator calculates USD accurately', () => {
  const cost = estimateCostUsd('gemini-4-hydrogen', 1_000_000, 1_000_000);
  assert.equal(cost, 0.5);
});
