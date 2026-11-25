import { z } from 'zod';
import { getDb } from '../db/adapter.ts';
import type { DynamicApiRecord } from '../db/schema.ts';
import { scheduleReflection } from '../knowledge/reflection.ts';
import { routeJsonLlmCall } from '../llm/router.ts';
import { executeHandlerInSandbox, runTestsInSandbox } from '../sandbox/runner.ts';

interface SynthesizedEndpointSpec {
  slug: string;
  name: string;
  description: string;
  method: 'POST';
  inputSchema: {
    type: 'object';
    required: string[];
    properties: Record<string, { type: 'string' | 'number' | 'boolean' | 'array' | 'object'; description?: string }>;
  };
  outputSchema: Record<string, unknown>;
  handlerCode: string;
  testCode: string;
}

export function buildZodSchemaFromJsonSchema(schema: Record<string, unknown>): z.ZodTypeAny {
  const props = (schema.properties || {}) as Record<string, { type?: string }>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, def] of Object.entries(props)) {
    let field: z.ZodTypeAny;
    switch (def?.type) {
      case 'number':
      case 'integer':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      case 'object':
        field = z.record(z.string(), z.unknown());
        break;
      default:
        field = z.string();
    }
    shape[key] = required.has(key) ? field : field.optional();
  }

  return z.object(shape).passthrough();
}

export function buildOpenApiOperation(spec: {
  slug: string;
  name: string;
  description: string;
  method: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}) {
  return {
    path: `/api/v1/custom/${spec.slug}`,
    method: spec.method,
    summary: spec.name,
    description: spec.description,
    security: [{ BearerApiKey: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: spec.inputSchema,
        },
      },
    },
    responses: {
      '200': {
        description: 'Successful dynamic endpoint execution',
        content: {
          'application/json': {
            schema: spec.outputSchema,
          },
        },
      },
    },
  };
}

export async function forgeDynamicEndpoint(requirement: string, tenantId = 'global'): Promise<DynamicApiRecord> {
  const start = Date.now();
  let spec: SynthesizedEndpointSpec | null = null;
  let report = { passed: 0, failed: 1, total: 1, durationMs: 0, details: ['Not run'] };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const feedback =
      attempt === 1
        ? ''
        : `\nPrevious test failure in sandbox:\n${report.details.join('\n')}\nFix handlerCode or testCode so all assertions pass.`;

    const { data } = await routeJsonLlmCall<SynthesizedEndpointSpec>({
      tenantId,
      taskType: 'api_forge_synthesis',
      thinkingLevel: 'LOW',
      systemInstruction: `You are Neo's Autonomous API Forge.
Convert a natural-language endpoint requirement into a production-safe, typed, tested API endpoint.
Rules:
1. \`slug\`: kebab-case URL slug (3-40 chars, lowercase letters, digits, hyphens).
2. \`handlerCode\`: pure JavaScript defining \`function handle(input) { ... }\` returning a JSON-serializable object. NO \`process\`, \`require\`, \`import\`, \`fs\`, or \`globalThis\`.
3. \`testCode\`: at least 2 deterministic unit tests calling \`test(name, () => { assert.equal(...); })\` that verify \`handle(input)\`.
4. \`inputSchema\`: JSON Schema object with \`type: "object"\`, \`required: string[]\`, and \`properties\`.
Return strict JSON matching { "slug", "name", "description", "method": "POST", "inputSchema", "outputSchema", "handlerCode", "testCode" }.`,
      prompt: `Requirement: ${requirement}${feedback}`,
    });

    spec = {
      ...data,
      slug: data.slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48),
      method: 'POST',
    };

    report = runTestsInSandbox(spec.handlerCode, spec.testCode, 2000);
    if (report.failed === 0 && report.passed > 0) break;
  }

  if (!spec || report.failed > 0 || report.passed === 0) {
    throw new Error(`Forged API failed sandbox verification: ${report.details.join('; ')}`);
  }

  const db = await getDb();
  const openapiSpec = buildOpenApiOperation(spec);
  const record = await db.upsertDynamicApi({
    tenant_id: tenantId,
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    method: 'POST',
    input_schema: spec.inputSchema,
    output_schema: spec.outputSchema,
    handler_code: spec.handlerCode,
    test_code: spec.testCode,
    test_report: report,
    openapi_spec: openapiSpec,
    rate_limit_rpm: 60,
    enabled: true,
  });

  await scheduleReflection({
    tenantId,
    taskType: 'api_forge',
    goal: requirement,
    outcome: 'success',
    durationMs: Date.now() - start,
    summary: `Forged /api/v1/custom/${record.slug} (${report.passed}/${report.total} sandbox tests passed).`,
  });

  return record;
}

export async function invokeDynamicEndpoint(slug: string, payload: unknown) {
  const db = await getDb();
  const api = await db.getDynamicApiBySlug(slug);
  if (!api) {
    return { status: 404, body: { error: `Dynamic endpoint '/api/v1/custom/${slug}' not found` } };
  }
  if (!api.enabled) {
    return { status: 403, body: { error: `Dynamic endpoint '/api/v1/custom/${slug}' is disabled` } };
  }

  const zodValidator = buildZodSchemaFromJsonSchema(api.input_schema);
  const parsed = zodValidator.safeParse(payload ?? {});
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: 'Input validation failed', issues: parsed.error.issues },
    };
  }

  const execRes = executeHandlerInSandbox(api.handler_code, parsed.data, 1200);
  if (!execRes.ok) {
    return { status: 500, body: { error: `Sandbox execution error: ${execRes.error}` } };
  }

  await db.incrementDynamicApiCalls(slug);
  return {
    status: 200,
    body: {
      endpoint: `/api/v1/custom/${slug}`,
      durationMs: execRes.durationMs,
      result: execRes.output,
      logs: execRes.logs,
    },
  };
}
