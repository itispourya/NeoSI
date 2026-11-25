import assert from 'node:assert/strict';
import vm from 'node:vm';

export interface SandboxExecutionResult<T = unknown> {
  ok: boolean;
  output?: T;
  logs: string[];
  durationMs: number;
  error?: string;
}

export interface SandboxTestReport {
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  details: string[];
}

const FORBIDDEN_PATTERNS = [
  /\bprocess\b/,
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bchild_process\b/,
  /\bglobalThis\b/,
  /\bFunction\s*\(/,
  /\beval\s*\(/,
  /\bfs\b\./,
];

export function checkCodeSafety(code: string): { safe: boolean; violation?: string } {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      return { safe: false, violation: `Disallowed symbol or construct matched: ${pattern.source}` };
    }
  }
  return { safe: true };
}

function createIsolatedContext(logs: string[]) {
  const safeConsole = {
    log: (...args: unknown[]) => {
      if (logs.length < 100) logs.push(args.map((a) => String(a)).join(' '));
    },
    warn: (...args: unknown[]) => {
      if (logs.length < 100) logs.push('[WARN] ' + args.map((a) => String(a)).join(' '));
    },
    error: (...args: unknown[]) => {
      if (logs.length < 100) logs.push('[ERROR] ' + args.map((a) => String(a)).join(' '));
    },
  };

  // Pure standard primitives only — zero host process, env, fs, or network access
  const sandboxGlobals = {
    console: safeConsole,
    Math,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    assert,
  };

  return vm.createContext(sandboxGlobals, {
    codeGeneration: { strings: false, wasm: false },
  });
}

/**
 * Executes a pure handler `function handle(input)` inside an isolated V8 VM context
 * with strict timeout and zero secret/host leakage.
 */
export function executeHandlerInSandbox<T = unknown>(
  handlerCode: string,
  input: unknown,
  timeoutMs = 1200
): SandboxExecutionResult<T> {
  const safety = checkCodeSafety(handlerCode);
  if (!safety.safe) {
    return { ok: false, logs: [], durationMs: 0, error: safety.violation };
  }

  const logs: string[] = [];
  const start = Date.now();
  try {
    const context = createIsolatedContext(logs);
    const wrapped = `
      "use strict";
      ${handlerCode}
      if (typeof handle !== "function") {
        throw new Error("Sandbox handler must define function handle(input)");
      }
      const __input = JSON.parse(${JSON.stringify(JSON.stringify(input ?? {}))});
      const __result = handle(__input);
      JSON.stringify(__result);
    `;
    const script = new vm.Script(wrapped, { filename: 'sandbox-handler.js' });
    const serialized = script.runInContext(context, { timeout: timeoutMs }) as string;
    const output = serialized === undefined ? undefined : (JSON.parse(serialized) as T);
    return {
      ok: true,
      output,
      logs,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      logs,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Runs automated unit tests against `handlerCode` inside the isolated VM sandbox.
 */
export function runTestsInSandbox(
  handlerCode: string,
  testCode: string,
  timeoutMs = 2000
): SandboxTestReport {
  const handlerSafety = checkCodeSafety(handlerCode);
  if (!handlerSafety.safe) {
    return { passed: 0, failed: 1, total: 1, durationMs: 0, details: [`FAIL security check: ${handlerSafety.violation}`] };
  }
  const testSafety = checkCodeSafety(testCode);
  if (!testSafety.safe) {
    return { passed: 0, failed: 1, total: 1, durationMs: 0, details: [`FAIL test security check: ${testSafety.violation}`] };
  }

  const logs: string[] = [];
  const start = Date.now();
  try {
    const context = createIsolatedContext(logs);
    const runnerScript = `
      "use strict";
      const __tests = [];
      function test(name, fn) {
        __tests.push({ name: String(name), fn });
      }
      ${handlerCode}
      ${testCode}
      const __results = [];
      let __passed = 0;
      let __failed = 0;
      for (const t of __tests) {
        try {
          t.fn();
          __passed++;
          __results.push("PASS " + t.name);
        } catch (e) {
          __failed++;
          __results.push("FAIL " + t.name + ": " + (e && e.message ? e.message : String(e)));
        }
      }
      JSON.stringify({ passed: __passed, failed: __failed, total: __tests.length, details: __results });
    `;
    const script = new vm.Script(runnerScript, { filename: 'sandbox-test-suite.js' });
    const raw = script.runInContext(context, { timeout: timeoutMs }) as string;
    const parsed = JSON.parse(raw) as Omit<SandboxTestReport, 'durationMs'>;
    return {
      ...parsed,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      passed: 0,
      failed: 1,
      total: 1,
      durationMs: Date.now() - start,
      details: [`FAIL sandbox runtime: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}
