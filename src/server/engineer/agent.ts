import { formatRagContextForPrompt, retrieveRagContext } from '../knowledge/memory.ts';
import { scheduleReflection } from '../knowledge/reflection.ts';
import { routeJsonLlmCall } from '../llm/router.ts';
import { runTestsInSandbox, type SandboxTestReport } from '../sandbox/runner.ts';
import { indexWorkspaceCodebase } from './repoIndex.ts';

export interface EngineeringTaskRequest {
  tenantId?: string;
  task: string;
  stack?: string;
  existingCode?: string;
}

export interface EngineeringTaskResult {
  plan: string[];
  architectureNotes: string;
  code: string;
  tests: string;
  iterations: number;
  testReport: SandboxTestReport;
  verified: boolean;
  repoContextFilesCount: number;
}

interface LlmEngineerOutput {
  plan: string[];
  architectureNotes: string;
  code: string;
  tests: string;
}

export async function runAutonomousEngineeringTask(req: EngineeringTaskRequest): Promise<EngineeringTaskResult> {
  const start = Date.now();
  const tenantId = req.tenantId || 'global';
  const repoMap = indexWorkspaceCodebase();
  const rag = await retrieveRagContext(req.task, tenantId, 3);
  const ragText = formatRagContextForPrompt(rag);

  let currentDraft: LlmEngineerOutput | null = null;
  let lastReport: SandboxTestReport = { passed: 0, failed: 0, total: 0, durationMs: 0, details: [] };
  let iterations = 0;
  const maxIterations = 3;

  while (iterations < maxIterations) {
    iterations++;
    const feedback =
      iterations === 1
        ? ''
        : `\n\nPREVIOUS SANDBOX TEST FAILURES (Iteration ${iterations - 1}):\n${lastReport.details.join('\n')}\nFix the implementation or assertions so 100% of tests pass.`;

    const { data } = await routeJsonLlmCall<LlmEngineerOutput>({
      tenantId,
      taskType: 'autonomous_engineer',
      thinkingLevel: 'MEDIUM',
      systemInstruction: `You are Neo's Principal Autonomous Software Engineer.
Follow the Plan -> Code -> Test -> Fix loop strictly.
Write clean JavaScript ES5/ES2022 compatible pure logic for sandbox verification with an entry function \`function handle(input) { ... }\` (plus any helper functions) and deterministic unit tests using \`test(name, () => { assert.equal(...); })\` (where \`test\` and \`assert\` are provided in the sandbox).
Do NOT reference \`process\`, \`require\`, \`import\`, \`fs\`, or \`globalThis\` inside the sandboxed \`code\` or \`tests\`.
Return strict JSON: { "plan": string[], "architectureNotes": string, "code": string, "tests": string }.`,
      prompt: `Engineering Task: ${req.task}
Target Stack Context: ${req.stack || 'TypeScript / Node.js'}
${req.existingCode ? `Existing Snippet:\n${req.existingCode}\n` : ''}
Repository Modules Indexed (${repoMap.totalFiles} files, ${repoMap.totalLines} LOC):
${repoMap.files.slice(0, 15).map((f) => `- ${f.file} (exports: ${f.exports.join(', ') || 'default'})`).join('\n')}

${ragText}${feedback}`,
    });

    currentDraft = data;
    lastReport = runTestsInSandbox(data.code, data.tests, 2500);
    if (lastReport.failed === 0 && lastReport.passed > 0) {
      break;
    }
  }

  const verified = Boolean(currentDraft && lastReport.failed === 0 && lastReport.passed > 0);

  await scheduleReflection({
    tenantId,
    taskType: 'engineering',
    goal: req.task,
    outcome: verified ? 'success' : 'partial',
    errorTrace: verified ? undefined : lastReport.details.join('; '),
    durationMs: Date.now() - start,
    summary: `Executed ${iterations} sandbox iteration(s); ${lastReport.passed}/${lastReport.total} tests passed.`,
  });

  return {
    plan: currentDraft?.plan || [],
    architectureNotes: currentDraft?.architectureNotes || '',
    code: currentDraft?.code || '',
    tests: currentDraft?.tests || '',
    iterations,
    testReport: lastReport,
    verified,
    repoContextFilesCount: repoMap.totalFiles,
  };
}
