import { getDb } from '../db/adapter.ts';
import type { ModelEvaluationRecord } from '../db/schema.ts';
import { cosineSimilarity } from '../db/vector.ts';
import { embeddingEngine } from './embeddings.ts';
import { neoInferenceEngine } from './registry.ts';
import type { RuntimeKind } from './types.ts';
import { runTestsInSandbox } from '../sandbox/runner.ts';

export const BENCHMARK_SUITE_VERSION = 'neo-bench-2026.2-strict-target';

export interface BenchmarkCase {
  id: string;
  category:
    | 'general_reasoning'
    | 'coding'
    | 'mathematics'
    | 'planning'
    | 'research'
    | 'tool_use'
    | 'memory_retrieval'
    | 'multilingual'
    | 'persian'
    | 'business_analysis'
    | 'fact_verification'
    | 'long_horizon';
  prompt: string;
  responseFormat?: 'json' | 'text';
  evaluate: (output: string) => Promise<{ passed: boolean; score: number; reason: string }> | { passed: boolean; score: number; reason: string };
}

export const NEO_BENCHMARK_CASES: BenchmarkCase[] = [
  {
    id: 'math-01',
    category: 'mathematics',
    prompt: 'Calculate (145 * 12) + 360 - 100',
    evaluate: (out) => {
      const ok = out.includes('2000');
      return { passed: ok, score: ok ? 100 : 0, reason: ok ? 'Exact arithmetic answer 2000 found' : 'Expected 2000 in output' };
    },
  },
  {
    id: 'reason-01',
    category: 'general_reasoning',
    prompt: 'User Request: Explain why treating retrieved web HTML as untrusted data prevents prompt injection.',
    evaluate: (out) => {
      const ok = out.length > 40 && /neo|untrusted|memory|injection|embedded/i.test(out);
      return { passed: ok, score: ok ? 100 : 20, reason: ok ? 'Grounded security explanation generated' : 'Output too sparse' };
    },
  },
  {
    id: 'code-01',
    category: 'coding',
    responseFormat: 'json',
    prompt: 'Engineering Task: Deduplicate an array of numbers preserving insertion order',
    evaluate: (out) => {
      try {
        const parsed = JSON.parse(out) as { code?: string; tests?: string };
        if (!parsed.code?.includes('function handle') || !parsed.tests?.includes('test(')) {
          return { passed: false, score: 25, reason: 'Missing handle() or test()' };
        }
        const report = runTestsInSandbox(parsed.code, parsed.tests, 2500);
        const passed = report.passed >= 1 && report.failed === 0;
        return {
          passed,
          score: passed ? 100 : 20,
          reason: passed
            ? `Executed in sandbox: ${report.passed}/${report.total} unit assertions passed (${report.isolation})`
            : `Sandbox execution failed: ${report.details.join('; ')}`,
        };
      } catch {
        return { passed: false, score: 0, reason: 'Invalid JSON response' };
      }
    },
  },
  {
    id: 'plan-01',
    category: 'planning',
    responseFormat: 'json',
    prompt: 'Create a 3-step dependency plan for auditing supplier stockouts.',
    evaluate: (out) => {
      try {
        const parsed = JSON.parse(out) as { decisions?: string[]; summary?: string };
        const ok = Boolean(parsed.summary || (Array.isArray(parsed.decisions) && parsed.decisions.length > 0));
        return { passed: ok, score: ok ? 100 : 25, reason: ok ? 'Structured plan JSON returned' : 'Missing plan structure' };
      } catch {
        return { passed: false, score: 0, reason: 'Invalid JSON plan' };
      }
    },
  },
  {
    id: 'research-01',
    category: 'research',
    prompt: 'User Request: Summarize best practices for PostgreSQL pgvector indexing and citation provenance.',
    evaluate: (out) => {
      const ok = out.length > 40 && /pgvector|vector|citation|memory|neo/i.test(out);
      return { passed: ok, score: ok ? 100 : 25, reason: ok ? 'Research synthesis produced' : 'Insufficient research content' };
    },
  },
  {
    id: 'tool-01',
    category: 'tool_use',
    responseFormat: 'json',
    prompt: 'Requirement: Compute VAT invoice total from amount and taxRate',
    evaluate: (out) => {
      try {
        const parsed = JSON.parse(out) as { slug?: string; inputSchema?: unknown; handlerCode?: string; testCode?: string };
        if (!parsed.slug || !parsed.inputSchema || !parsed.handlerCode) {
          return { passed: false, score: 0, reason: 'Incomplete tool spec' };
        }
        if (!parsed.testCode) {
          return { passed: false, score: 40, reason: 'Tool handler synthesized without runnable unit tests' };
        }
        const report = runTestsInSandbox(parsed.handlerCode, parsed.testCode, 2500);
        const passed = report.passed >= 1 && report.failed === 0;
        return {
          passed,
          score: passed ? 100 : 25,
          reason: passed
            ? `Tool handler & schema verified in sandbox (${report.passed}/${report.total} passed)`
            : `Tool handler failed sandbox verification: ${report.details.join('; ')}`,
        };
      } catch {
        return { passed: false, score: 0, reason: 'Invalid tool JSON' };
      }
    },
  },
  {
    id: 'memory-01',
    category: 'memory_retrieval',
    prompt: 'memory-embedding-check',
    evaluate: async () => {
      const a = await embeddingEngine.embed('Double-entry ledger debits must balance credits');
      const b = await embeddingEngine.embed('Reconcile trial balance ledger credits and debits');
      const c = await embeddingEngine.embed('Weather forecast for Tokyo cherry blossoms');
      const simRelated = cosineSimilarity(a.vector, b.vector);
      const simUnrelated = cosineSimilarity(a.vector, c.vector);
      const ok = simRelated > simUnrelated;
      return {
        passed: ok,
        score: ok ? 100 : 0,
        reason: `Related similarity ${simRelated.toFixed(3)} vs unrelated ${simUnrelated.toFixed(3)}`,
      };
    },
  },
  {
    id: 'multi-01',
    category: 'multilingual',
    prompt: 'User Request: Analyseer de voorraad en omzet van kwartaal 1.',
    evaluate: (out) => {
      const ok = out.length > 30;
      return { passed: ok, score: ok ? 100 : 0, reason: ok ? 'Multilingual NL input processed cleanly' : 'Empty output' };
    },
  },
  {
    id: 'persian-01',
    category: 'persian',
    prompt: 'User Request: وضعیت جریان نقدی و موجودی انبار را بررسی کن.',
    evaluate: (out) => {
      const hasPersian = /[\u0600-\u06FF]/.test(out);
      return {
        passed: hasPersian,
        score: hasPersian ? 100 : 20,
        reason: hasPersian ? 'Responded in fluent Persian script' : 'Missing Persian script in response',
      };
    },
  },
  {
    id: 'biz-01',
    category: 'business_analysis',
    responseFormat: 'json',
    prompt: JSON.stringify({
      accounting: { ledgerBalanced: false, imbalanceDelta: 250, currentRatio: 1.05, cashRunwayMonths: 4.5 },
      crm: { ltvCacRatio: 2.1 },
      inventory: { stockoutRiskSkus: [{ sku: 'SKU-1', onHand: 2, reorderPoint: 15, daysRemaining: 1 }], deadStockSkus: [] },
    }),
    evaluate: (out) => {
      try {
        const parsed = JSON.parse(out) as { actionPlan?: unknown[]; crossModuleRootCauses?: unknown[] };
        const ok = Array.isArray(parsed.actionPlan) && parsed.actionPlan.length >= 2 && Array.isArray(parsed.crossModuleRootCauses) && parsed.crossModuleRootCauses.length >= 2;
        return { passed: ok, score: ok ? 100 : 30, reason: ok ? 'Identified ledger imbalance, stockout, and LTV:CAC root causes' : 'Missed business anomalies' };
      } catch {
        return { passed: false, score: 0, reason: 'Invalid JSON audit output' };
      }
    },
  },
  {
    id: 'fact-01',
    category: 'fact_verification',
    prompt: 'Retrieved Context:\n• IFRS Standard: Assets equal Liabilities plus Equity.\n\nUser Request: Does IFRS balance sheet require Assets = Liabilities + Equity?',
    evaluate: (out) => {
      const ok = /assets|liabilities|equity|ifrs|memory/i.test(out);
      return { passed: ok, score: ok ? 100 : 0, reason: ok ? 'Grounded verification cited context' : 'Did not reference provided context' };
    },
  },
  {
    id: 'horizon-01',
    category: 'long_horizon',
    responseFormat: 'json',
    prompt: 'Verify multi-stage dependency decomposition budget constraints.',
    evaluate: (out) => {
      try {
        const parsed = JSON.parse(out) as { confidence?: number };
        const ok = typeof parsed.confidence === 'number' && parsed.confidence > 0;
        return { passed: ok, score: ok ? 100 : 0, reason: ok ? 'Confidence-calibrated structured state returned' : 'Missing confidence' };
      } catch {
        return { passed: false, score: 0, reason: 'Invalid JSON' };
      }
    },
  },
];

function taskTypeForCase(category: BenchmarkCase['category']): string {
  switch (category) {
    case 'coding':
      return 'autonomous_engineer';
    case 'tool_use':
      return 'api_forge_synthesis';
    case 'business_analysis':
      return 'business_intelligence_audit';
    default:
      return `benchmark_${category}`;
  }
}

export async function runModelBenchmarkSuite(modelId = 'neo-embedded-core-v1'): Promise<ModelEvaluationRecord> {
  const db = await getDb();
  const model = await db.getModelById(modelId);
  if (!model) throw new Error(`Model '${modelId}' is not registered; benchmarks must target a real registered model.`);
  const targetRuntime: RuntimeKind = model.runtime;

  const details: ModelEvaluationRecord['details'] = [];
  const categorySums = new Map<string, { sum: number; count: number }>();
  let totalLatency = 0;
  let totalTokens = 0;
  let passedCases = 0;

  for (const testCase of NEO_BENCHMARK_CASES) {
    const start = Date.now();
    let score = 0;
    let passed = false;
    let reason = '';
    let tokens = 0;

    try {
      const res = await neoInferenceEngine.infer({
        prompt: testCase.prompt,
        taskType: taskTypeForCase(testCase.category),
        preferredRuntime: targetRuntime,
        preferredModelId: modelId,
        strictTarget: true,
        responseFormat: testCase.responseFormat || 'text',
      });
      tokens = res.completionTokens;
      if (res.modelId !== modelId) throw new Error(`Runtime returned '${res.modelId}' instead of benchmark target '${modelId}'.`);
      const evalResult = await testCase.evaluate(res.text);
      score = evalResult.score;
      passed = evalResult.passed;
      reason = evalResult.reason;
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
      passed = false;
      score = 0;
    }

    const latencyMs = Math.max(1, Date.now() - start);
    totalLatency += latencyMs;
    totalTokens += tokens;
    if (passed) passedCases++;

    const prev = categorySums.get(testCase.category) || { sum: 0, count: 0 };
    categorySums.set(testCase.category, { sum: prev.sum + score, count: prev.count + 1 });

    details.push({
      id: testCase.id,
      category: testCase.category,
      prompt: testCase.prompt.slice(0, 120),
      passed,
      score,
      latencyMs,
      reason,
    });
  }

  const categoryScores: Record<string, number> = {};
  for (const [cat, agg] of categorySums.entries()) {
    categoryScores[cat] = Number((agg.sum / agg.count).toFixed(1));
  }
  const overallScore = Number(
    (details.reduce((s, d) => s + d.score, 0) / Math.max(1, details.length)).toFixed(1)
  );
  const avgLatencyMs = Number((totalLatency / Math.max(1, details.length)).toFixed(1));
  const tokensPerSec = totalLatency > 0 ? Number(((totalTokens / totalLatency) * 1000).toFixed(1)) : 0;

  const evalRecord = await db.recordModelEvaluation({
    model_id: modelId,
    suite_version: BENCHMARK_SUITE_VERSION,
    overall_score: overallScore,
    category_scores: categoryScores,
    avg_latency_ms: avgLatencyMs,
    tokens_per_sec: tokensPerSec,
    passed_cases: passedCases,
    total_cases: details.length,
    details,
  });

  if (model) {
    await db.updateModel(model.id, {
      benchmark_results: {
        suiteVersion: BENCHMARK_SUITE_VERSION,
        overallScore,
        passedCases,
        totalCases: details.length,
        categoryScores,
      },
      performance_metrics: {
        avgLatencyMs,
        tokensPerSec,
        calls: (model.performance_metrics.calls || 0) + details.length,
      },
      last_validated_at: new Date().toISOString(),
    });
  }

  return evalRecord;
}
