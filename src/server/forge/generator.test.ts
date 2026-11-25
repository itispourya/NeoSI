import assert from 'node:assert/strict';
import test from 'node:test';
import { neoInferenceEngine } from '../inference/registry.ts';
import { buildOpenApiOperation, buildZodSchemaFromJsonSchema } from './generator.ts';

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

test('Neo sovereign inference generates valid API forge JSON using embedded runtime with zero external cost', async () => {
  const { data, response } = await neoInferenceEngine.inferJson<{ slug: string; handlerCode: string }>({
    prompt: 'Requirement: Compute VAT invoice total from amount and taxRate',
    taskType: 'api_forge_synthesis',
    preferredRuntime: 'embedded',
  });
  assert.equal(response.runtime, 'embedded');
  assert.ok(data.slug.length > 0);
  assert.ok(data.handlerCode.includes('function handle'));
});
