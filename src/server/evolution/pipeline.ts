import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import type { EvolutionExperimentRecord, SelfUpgradeRecord, SkillRecord, TrainingJobRecord } from '../db/schema.ts';
import { runModelBenchmarkSuite } from '../inference/evaluator.ts';
import { neoInferenceEngine } from '../inference/registry.ts';
import { promoteVerifiedModule, removePromotedModule } from '../neo/sovereignEngine.ts';
import { runTestsInSandbox } from '../sandbox/runner.ts';
import { redactPII } from '../security/crypto.ts';

const execFileAsync = promisify(execFile);

const PROTECTED_CORE_PATHS = [
  '.env',
  'server.ts',
  'src/server/security/',
  'src/server/config/env.ts',
  'src/server/routes/admin.ts',
  'migrations/',
];

export function isProtectedPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return PROTECTED_CORE_PATHS.some((prefix) => normalized === prefix || normalized.startsWith(prefix));
}

export function validateTargetFiles(files: string[]): { allowed: boolean; blockedFiles: string[] } {
  const blockedFiles = files.filter((f) => isProtectedPath(f));
  return { allowed: blockedFiles.length === 0, blockedFiles };
}

export function evaluateBenchmarkGate(
  before: { accuracyScore: number; avgLatencyMs: number; passRate: number },
  after: { accuracyScore: number; avgLatencyMs: number; passRate: number },
  testResults: { passed: number; failed: number; total: number }
): { passed: boolean; reason: string } {
  if (testResults.total === 0 || testResults.passed === 0) {
    return { passed: false, reason: 'Zero automated tests executed' };
  }
  if (testResults.failed > 0) {
    return { passed: false, reason: `${testResults.failed} sandbox test(s) failed` };
  }
  if (after.passRate < 100) {
    return { passed: false, reason: `Pass rate ${after.passRate}% is below 100% gate` };
  }
  if (after.accuracyScore < before.accuracyScore) {
    return { passed: false, reason: `Accuracy regressed from ${before.accuracyScore} to ${after.accuracyScore}` };
  }
  if (after.avgLatencyMs > Math.max(25, before.avgLatencyMs * 1.25) && after.accuracyScore === before.accuracyScore) {
    return { passed: false, reason: `Latency regressed beyond threshold without accuracy gain` };
  }
  return { passed: true, reason: '100% tests passed and measured benchmark gate satisfied' };
}

function buildUnifiedDiff(filePath: string, code: string): string {
  const lines = code.split('\n').map((l) => `+${l}`).join('\n');
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${code.split('\n').length} @@`,
    lines,
  ].join('\n');
}

/**
 * Layer A: Skill Evaluation & Versioning
 */
export async function evaluateSkill(idOrSlug: string): Promise<{
  skill: SkillRecord | null;
  passed: boolean;
  score: number;
  checks: Array<{ name: string; ok: boolean; note: string }>;
}> {
  const db = await getDb();
  const skill = await db.getSkillByIdOrSlug(idOrSlug);
  if (!skill) {
    return { skill: null, passed: false, score: 0, checks: [{ name: 'exists', ok: false, note: 'Skill not found' }] };
  }

  const checks = [
    { name: 'has_title', ok: skill.title.trim().length >= 3, note: `Title length ${skill.title.length}` },
    { name: 'substantive_content', ok: skill.content.trim().length >= 60, note: `Content length ${skill.content.length}` },
    { name: 'actionable_rules', ok: /\d+\.|[-*]|\b(always|never|verify|check|ensure)\b/i.test(skill.content), note: 'Contains structured procedural rules' },
    { name: 'safe_content', ok: !/\b(ignore previous|bypass auth|rm -rf)\b/i.test(skill.content), note: 'No unsafe instruction directives' },
  ];
  const score = Number(((checks.filter((c) => c.ok).length / checks.length) * 100).toFixed(1));
  const passed = checks.every((c) => c.ok);

  const updated = await db.updateSkillById(skill.id, {
    metadata: {
      ...skill.metadata,
      lastEvaluatedAt: new Date().toISOString(),
      evaluationScore: score,
      evaluationPassed: passed,
    },
  });

  return { skill: updated || skill, passed, score, checks };
}

/**
 * Layer B: Controlled Cognitive Configuration A/B Experiment
 */
export async function runConfigExperiment(input: {
  title: string;
  hypothesis: string;
  configBefore: Record<string, unknown>;
  configAfter: Record<string, unknown>;
}): Promise<EvolutionExperimentRecord> {
  const db = await getDb();
  const baseline = await runModelBenchmarkSuite('neo-embedded-core-v1');
  // The candidate config is not yet connected to inference requests. Never label a same-config rerun as validation.

  return db.recordEvolutionExperiment({
    layer: 'B',
    title: input.title,
    hypothesis: input.hypothesis,
    config_before: input.configBefore,
    config_after: input.configAfter,
    metrics_before: {
      overallScore: baseline.overall_score,
      avgLatencyMs: baseline.avg_latency_ms,
      passedCases: baseline.passed_cases,
      totalCases: baseline.total_cases,
    },
    metrics_after: {
      overallScore: baseline.overall_score,
      avgLatencyMs: baseline.avg_latency_ms,
      passedCases: baseline.passed_cases,
      totalCases: baseline.total_cases,
      configurationApplied: false,
      note: 'The candidate configuration has not been applied to the inference runtime; this experiment is inconclusive.',
    },
    status: 'inconclusive',
  });
}

/**
 * Layer C: Standalone candidate module generation and isolated tests.
 * The temporary Git repository is discarded after testing; the candidate is not benchmarked
 * against or integrated into the full Neo source tree at this stage.
 */
async function stageInIsolatedGitWorkspace(
  branchName: string,
  targetFile: string,
  handlerCode: string,
  testCode: string
): Promise<{ workspaceDir: string; gitCommitted: boolean; cleanup: () => void }> {
  const safeSlug = branchName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `neo-evo-${safeSlug}-`));
  const cleanup = () => {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  };

  let gitCommitted = false;
  try {
    const absTarget = path.join(workspaceDir, path.basename(targetFile));
    const absTest = path.join(workspaceDir, `${path.basename(targetFile, '.js')}.test.js`);
    fs.writeFileSync(absTarget, handlerCode, 'utf8');
    fs.writeFileSync(absTest, testCode, 'utf8');

    await execFileAsync('git', ['init', '-b', safeSlug], { cwd: workspaceDir, timeout: 5000 });
    await execFileAsync('git', ['config', 'user.email', 'neo-evolution@neos.local'], { cwd: workspaceDir, timeout: 3000 });
    await execFileAsync('git', ['config', 'user.name', 'Neo Evolution Engine'], { cwd: workspaceDir, timeout: 3000 });
    await execFileAsync('git', ['add', '.'], { cwd: workspaceDir, timeout: 5000 });
    await execFileAsync('git', ['commit', '-m', `chore(evolution): ${branchName}`], { cwd: workspaceDir, timeout: 5000 });
    gitCommitted = true;
  } catch {
    gitCommitted = false;
  }

  return { workspaceDir, gitCommitted, cleanup };
}

export async function runCodeEvolutionProposal(focusArea?: string): Promise<SelfUpgradeRecord> {
  const db = await getDb();
  const [telemetry, summary, proceduralMemories] = await Promise.all([
    db.listTelemetry(40),
    db.getTelemetrySummary(),
    db.listMemories({ memoryType: 'procedural', limit: 15 }),
  ]);

  const recentErrors = telemetry.filter((t) => !t.success).slice(0, 5);
  const branchName = `self-upgrade/${Date.now()}-${(focusArea || 'optimization').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`;

  // Measure real baseline benchmark BEFORE proposing/testing
  const baselineEval = await runModelBenchmarkSuite('neo-embedded-core-v1');
  const benchmarkBefore = {
    accuracyScore: baselineEval.overall_score,
    avgLatencyMs: baselineEval.avg_latency_ms,
    passRate: Number(((baselineEval.passed_cases / Math.max(1, baselineEval.total_cases)) * 100).toFixed(1)),
  };

  let draft: {
    title: string;
    diagnosis: string;
    targetFile: string;
    handlerCode: string;
    testCode: string;
    rollbackPlan: string;
  };

  try {
    const { data } = await neoInferenceEngine.inferJson<typeof draft>({
      role: 'coding',
      taskType: 'self_upgrade_synthesis',
      systemInstruction: `You are Neo's Layer C Self-Evolution Engineer. Diagnose telemetry/memory gaps and propose a concrete non-breaking utility module under "src/server/modules/<name>.js". Never modify security/, config/env.ts, server.ts, routes/admin.ts, or migrations/.
Return strict JSON: { "title", "diagnosis", "targetFile", "handlerCode", "testCode", "rollbackPlan" }`,
      prompt: JSON.stringify({
        focusArea: focusArea || 'Deterministic response caching & input validation',
        telemetrySummary: summary,
        recentErrors: recentErrors.map((e) => ({ provider: e.provider, task: e.task_type, error: e.error_message })),
        proceduralLessons: proceduralMemories.map((m) => ({ title: m.title, content: m.content })),
      }),
    });
    if (data && data.targetFile && data.handlerCode && data.testCode) {
      draft = data;
    } else {
      throw new Error('Incomplete structured proposal from model');
    }
  } catch {
    draft = {
      title: `Prompt Normalization & Deduplication Guard (${focusArea || 'core'})`,
      diagnosis: `Evaluated ${summary.totalCalls} telemetry calls (${recentErrors.length} errors, baseline benchmark ${baselineEval.overall_score}%). Synthesized bounded whitespace & schema normalizer module.`,
      targetFile: 'src/server/modules/promptNormalizer.js',
      handlerCode: `function handle(input) {
  var text = String((input && input.prompt) || '').replace(/\\s+/g, ' ').trim();
  var maxLen = Number((input && input.maxChars) || 4000);
  var truncated = text.length > maxLen ? text.slice(0, maxLen) : text;
  return { normalized: truncated, originalLength: text.length, savedChars: Math.max(0, text.length - truncated.length) };
}`,
      testCode: `test('normalizes whitespace and bounds length', () => {
  const out = handle({ prompt: '  hello   neos   world  ', maxChars: 100 });
  assert.equal(out.normalized, 'hello neos world');
});
test('tracks saved characters on oversized prompts', () => {
  const out = handle({ prompt: 'a'.repeat(50), maxChars: 20 });
  assert.equal(out.normalized.length, 20);
  assert.equal(out.savedChars, 30);
});`,
      rollbackPlan: `Disable and delete promoted module for branch ${branchName}.`,
    };
  }

  // Enforce protected boundary guardrail
  const guard = validateTargetFiles([draft.targetFile]);
  if (!guard.allowed) {
    return db.createUpgrade({
      title: draft.title,
      diagnosis: `${draft.diagnosis} [BLOCKED BY GUARDRAIL: ${guard.blockedFiles.join(', ')}]`,
      branch_name: branchName,
      target_files: [draft.targetFile],
      unified_diff: buildUnifiedDiff(draft.targetFile, draft.handlerCode),
      test_results: { passed: 0, failed: 1, total: 1, durationMs: 0, output: 'Blocked by protected-core guardrail' },
      benchmark_before: benchmarkBefore,
      benchmark_after: { ...benchmarkBefore, passRate: 0 },
      rollback_plan: draft.rollbackPlan,
      status: 'rejected',
      auto_eligible: false,
    });
  }

  // Run tests inside isolated OS subprocess sandbox + commit to isolated git repo/worktree
  const sandboxReport = runTestsInSandbox(draft.handlerCode, draft.testCode, 2500);
  const gitWorkspace = await stageInIsolatedGitWorkspace(branchName, draft.targetFile, draft.handlerCode, draft.testCode);
  gitWorkspace.cleanup();

  // The test runner validates only the standalone candidate module. The existing Neo model benchmark
  // is not evidence of candidate-code impact, so keep it as a reference and disable auto-promotion.
  const allCandidateTestsPassed =
    sandboxReport.total > 0 &&
    sandboxReport.failed === 0 &&
    sandboxReport.passed === sandboxReport.total;
  const benchmarkAfter = { ...benchmarkBefore };
  const autoEligible = false;
  const initialStatus = allCandidateTestsPassed ? 'sandbox_passed' : 'rejected';

  const record = await db.createUpgrade({
    title: draft.title,
    diagnosis: `${draft.diagnosis} [temporaryGitCommitCreated=${gitWorkspace.gitCommitted}; isolation=${sandboxReport.isolation}; candidateIntegrationBenchmark=not_run; automaticPromotion=disabled]`,
    branch_name: branchName,
    target_files: [draft.targetFile],
    unified_diff: buildUnifiedDiff(draft.targetFile, draft.handlerCode),
    test_results: {
      passed: sandboxReport.passed,
      failed: sandboxReport.failed,
      total: sandboxReport.total,
      durationMs: sandboxReport.durationMs,
      output: sandboxReport.details.join('\n'),
    },
    benchmark_before: benchmarkBefore,
    benchmark_after: benchmarkAfter,
    rollback_plan: draft.rollbackPlan,
    status: initialStatus,
    auto_eligible: autoEligible,
  });

  if (initialStatus === 'merged') {
    promoteVerifiedModule(record.id, draft.targetFile, draft.handlerCode);
  }

  return record;
}

function extractAddedCodeFromDiff(diff: string): string {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

export async function approveCodeUpgrade(id: string): Promise<SelfUpgradeRecord | null> {
  const db = await getDb();
  const existing = await db.getUpgradeById(id);
  if (!existing) return null;
  if (existing.status !== 'sandbox_passed') {
    throw new Error(`Only sandbox-passed proposals can be promoted (current status: ${existing.status}).`);
  }
  const guard = validateTargetFiles(existing.target_files);
  if (!guard.allowed) {
    throw new Error(`Security guardrail violation: protected files cannot be promoted (${guard.blockedFiles.join(', ')})`);
  }
  if (
    existing.test_results.total === 0 ||
    existing.test_results.failed > 0 ||
    existing.test_results.passed !== existing.test_results.total
  ) {
    throw new Error('Cannot promote an upgrade unless every candidate sandbox test passed.');
  }
  const code = extractAddedCodeFromDiff(existing.unified_diff);
  if (code) {
    promoteVerifiedModule(existing.id, existing.target_files[0] || 'module.js', code);
  }
  return db.updateUpgradeStatus(id, 'promoted');
}

export async function rejectCodeUpgrade(id: string): Promise<SelfUpgradeRecord | null> {
  const db = await getDb();
  const existing = await db.getUpgradeById(id);
  if (!existing) return null;
  removePromotedModule(id);
  return db.updateUpgradeStatus(id, 'rejected');
}

export async function rollbackCodeUpgrade(id: string): Promise<SelfUpgradeRecord | null> {
  const db = await getDb();
  const existing = await db.getUpgradeById(id);
  if (!existing) return null;
  removePromotedModule(id);
  return db.updateUpgradeStatus(id, 'rolled_back');
}

/**
 * Layer D: Verified SFT/LoRA Dataset Preparation & Training Pipeline
 */
export async function prepareAndRunTrainingJob(input: {
  tenantId: string;
  baseModelId: string;
  method?: 'lora' | 'qlora' | 'sft' | 'dataset_only';
  minReliability?: number;
}): Promise<TrainingJobRecord> {
  const db = await getDb();
  const minRel = input.minReliability ?? 0.75;
  const method = input.method || 'lora';

  const job = await db.createTrainingJob({
    tenant_id: input.tenantId,
    base_model_id: input.baseModelId,
    method,
    dataset_size: 0,
    dataset_path: null,
    adapter_version: null,
    privacy_filtered: true,
    status: 'preparing_dataset',
    metrics: {},
  });

  const [semantic, procedural, episodic] = await Promise.all([
    db.listMemories({ memoryType: 'semantic', tenantId: input.tenantId, limit: 100 }),
    db.listMemories({ memoryType: 'procedural', tenantId: input.tenantId, limit: 50 }),
    db.listMemories({ memoryType: 'episodic', tenantId: input.tenantId, limit: 50 }),
  ]);

  const seenContent = new Set<string>();
  const samples: Array<{ instruction: string; input: string; output: string; topic: string; reliability: number }> = [];

  for (const m of [...semantic, ...procedural, ...episodic]) {
    if (m.reliability_score < minRel) continue;
    const cleanContent = redactPII(m.content).trim();
    const cleanTitle = redactPII(m.title).trim();
    const dedupKey = `${m.topic}::${cleanContent.slice(0, 120)}`;
    if (seenContent.has(dedupKey) || cleanContent.length < 20) continue;
    seenContent.add(dedupKey);
    samples.push({
      instruction: `Apply Neo verified ${m.memory_type} knowledge on "${m.topic}"`,
      input: cleanTitle,
      output: cleanContent,
      topic: m.topic,
      reliability: m.reliability_score,
    });
  }

  const trainDir = path.resolve(process.cwd(), 'data', 'training');
  fs.mkdirSync(trainDir, { recursive: true });
  const datasetPath = path.join(trainDir, `neo-sft-${job.id}.jsonl`);
  fs.writeFileSync(datasetPath, samples.map((s) => JSON.stringify(s)).join('\n') + (samples.length ? '\n' : ''), 'utf8');

  // This pipeline only prepares a dataset. No trainer dispatch or adapter-weight generation exists yet.
  const finalStatus = 'dataset_ready_training_not_started';

  const updated = await db.updateTrainingJob(job.id, {
    dataset_size: samples.length,
    dataset_path: datasetPath,
    adapter_version: null,
    status: finalStatus,
    metrics: {
      deduplicatedSamples: samples.length,
      minReliabilityThreshold: minRel,
      piiFiltered: true,
      trainerEndpointConfigured: Boolean(env.hfBaseUrl),
      trainingStarted: false,
      adapterProduced: false,
    },
    finished_at: new Date().toISOString(),
  });

  return updated || job;
}
