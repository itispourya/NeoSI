import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env.ts';

export interface SandboxExecutionResult<T = unknown> {
  ok: boolean;
  output?: T;
  logs: string[];
  durationMs: number;
  isolation: 'subprocess' | 'docker';
  error?: string;
}

export interface SandboxTestReport {
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  isolation: 'subprocess' | 'docker';
  details: string[];
}

const FORBIDDEN_PATTERNS = [
  /\bprocess\b/,
  /\brequire\s*\(/,
  /\bimport\b/,
  /\bchild_process\b/,
  /\bglobalThis\b/,
  /\bFunction\s*\(/,
  /\beval\s*\(/,
  /\bfs\b\./,
  /\bfetch\s*\(/,
  /\bWebAssembly\b/,
  /\bconstructor\s*\.\s*constructor\b/,
  /\b__proto__\b/,
  /\bProxy\b/,
];

export function checkCodeSafety(code: string): { safe: boolean; violation?: string } {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      return { safe: false, violation: `Disallowed symbol or construct matched: ${pattern.source}` };
    }
  }
  return { safe: true };
}

function isDockerAvailable(): boolean {
  if (env.sandboxMode !== 'docker') return false;
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore', timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

function runInIsolatedSubprocess(
  runnerSource: string,
  timeoutMs: number
): { ok: boolean; stdout: string; stderr: string; isolation: 'subprocess' | 'docker'; timedOut: boolean } {
  const dockerConfigured = env.sandboxMode === 'docker';
  const dockerAvailable = isDockerAvailable();
  if (env.nodeEnv === 'production' && !dockerConfigured) {
    return {
      ok: false,
      stdout: '',
      stderr: 'Dynamic code execution is disabled in production unless the Docker sandbox is explicitly configured.',
      isolation: 'subprocess',
      timedOut: false,
    };
  }
  if (dockerConfigured && !dockerAvailable) {
    return {
      ok: false,
      stdout: '',
      stderr: 'Docker sandbox was required but the Docker daemon is unavailable. Refusing to fall back to subprocess execution.',
      isolation: 'docker',
      timedOut: false,
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-sandbox-'));
  const entryPath = path.join(tempDir, 'run.cjs');

  try {
    fs.writeFileSync(entryPath, runnerSource, { encoding: 'utf8', mode: 0o400 });

    if (isDockerAvailable()) {
      const dockerArgs = [
        'run',
        '--rm',
        '--network=none',
        '--read-only',
        '--memory=128m',
        '--cpus=0.5',
        '--pids-limit=32',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=65534:65534',
        '-v',
        `${tempDir}:/sandbox:ro`,
        'node:22-alpine',
        'node',
        '--max-old-space-size=64',
        '/sandbox/run.cjs',
      ];
      const res = spawnSync('docker', dockerArgs, {
        env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
        timeout: timeoutMs + 2000,
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
      });
      return {
        ok: res.status === 0 && !res.error,
        stdout: res.stdout || '',
        stderr: res.stderr || (res.error ? res.error.message : ''),
        isolation: 'docker',
        timedOut: Boolean(res.error && 'code' in res.error && res.error.code === 'ETIMEDOUT'),
      };
    }

    // Isolated OS subprocess: empty environment (no host secrets), restricted heap, temp cwd, SIGKILL on timeout
    const res = spawnSync(
      process.execPath,
      ['--max-old-space-size=64', '--disallow-code-generation-from-strings', entryPath],
      {
        cwd: tempDir,
        env: {}, // Zero host env secrets exposed
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
      }
    );

    const timedOut = Boolean(
      (res.error && 'code' in res.error && res.error.code === 'ETIMEDOUT') || res.signal === 'SIGKILL'
    );
    return {
      ok: res.status === 0 && !res.error && !timedOut,
      stdout: res.stdout || '',
      stderr: res.stderr || (res.error ? res.error.message : ''),
      isolation: 'subprocess',
      timedOut,
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
}

/**
 * Executes a pure handler `function handle(input)` inside an isolated OS subprocess
 * (or Docker `--network=none --read-only` container when configured) with zero host secret leakage.
 */
export function executeHandlerInSandbox<T = unknown>(
  handlerCode: string,
  input: unknown,
  timeoutMs = 1500
): SandboxExecutionResult<T> {
  const safety = checkCodeSafety(handlerCode);
  if (!safety.safe) {
    return { ok: false, logs: [], durationMs: 0, isolation: 'subprocess', error: safety.violation };
  }

  const start = Date.now();
  const payloadLiteral = JSON.stringify(JSON.stringify(input ?? {}));

  const runnerSource = `"use strict";
const __logs = [];
const console = {
  log: (...args) => { if (__logs.length < 100) __logs.push(args.map((a) => String(a)).join(" ")); },
  warn: (...args) => { if (__logs.length < 100) __logs.push("[WARN] " + args.map((a) => String(a)).join(" ")); },
  error: (...args) => { if (__logs.length < 100) __logs.push("[ERROR] " + args.map((a) => String(a)).join(" ")); },
};
// Freeze/shadow Node globals inside the user scope IIFE
const __result = (function(process, require, module, exports, global, globalThis, Buffer, fetch) {
  ${handlerCode}
  if (typeof handle !== "function") {
    throw new Error("Sandbox handler must define function handle(input)");
  }
  const __input = JSON.parse(${payloadLiteral});
  return handle(__input);
})(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
process.stdout.write(JSON.stringify({ ok: true, output: __result, logs: __logs }));
`;

  const proc = runInIsolatedSubprocess(runnerSource, timeoutMs);
  const durationMs = Date.now() - start;

  if (proc.timedOut) {
    return {
      ok: false,
      logs: [],
      durationMs,
      isolation: proc.isolation,
      error: `Sandbox execution timed out after ${timeoutMs}ms`,
    };
  }

  if (!proc.ok) {
    return {
      ok: false,
      logs: [],
      durationMs,
      isolation: proc.isolation,
      error: (proc.stderr || proc.stdout || 'Subprocess exited non-zero').trim().slice(0, 400),
    };
  }

  try {
    const parsed = JSON.parse(proc.stdout) as { ok: boolean; output?: T; logs?: string[] };
    return {
      ok: true,
      output: parsed.output,
      logs: parsed.logs || [],
      durationMs,
      isolation: proc.isolation,
    };
  } catch (err) {
    return {
      ok: false,
      logs: [],
      durationMs,
      isolation: proc.isolation,
      error: `Invalid sandbox JSON output: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Runs automated unit tests against `handlerCode` inside an isolated subprocess / container.
 */
export function runTestsInSandbox(
  handlerCode: string,
  testCode: string,
  timeoutMs = 2500
): SandboxTestReport {
  const handlerSafety = checkCodeSafety(handlerCode);
  if (!handlerSafety.safe) {
    return {
      passed: 0,
      failed: 1,
      total: 1,
      durationMs: 0,
      isolation: 'subprocess',
      details: [`FAIL security check: ${handlerSafety.violation}`],
    };
  }
  const testSafety = checkCodeSafety(testCode);
  if (!testSafety.safe) {
    return {
      passed: 0,
      failed: 1,
      total: 1,
      durationMs: 0,
      isolation: 'subprocess',
      details: [`FAIL test security check: ${testSafety.violation}`],
    };
  }

  const start = Date.now();
  const runnerSource = `"use strict";
const assert = require("node:assert/strict");
const __logs = [];
const console = {
  log: (...args) => { if (__logs.length < 100) __logs.push(args.map((a) => String(a)).join(" ")); },
  warn: (...args) => { if (__logs.length < 100) __logs.push("[WARN] " + args.map((a) => String(a)).join(" ")); },
  error: (...args) => { if (__logs.length < 100) __logs.push("[ERROR] " + args.map((a) => String(a)).join(" ")); },
};
const __report = (function(process, require, module, exports, global, globalThis, Buffer, fetch) {
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
  return { passed: __passed, failed: __failed, total: __tests.length, details: __results };
})(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
process.stdout.write(JSON.stringify(__report));
`;

  const proc = runInIsolatedSubprocess(runnerSource, timeoutMs);
  const durationMs = Date.now() - start;

  if (proc.timedOut) {
    return {
      passed: 0,
      failed: 1,
      total: 1,
      durationMs,
      isolation: proc.isolation,
      details: [`FAIL sandbox timeout after ${timeoutMs}ms`],
    };
  }

  if (!proc.ok) {
    return {
      passed: 0,
      failed: 1,
      total: 1,
      durationMs,
      isolation: proc.isolation,
      details: [`FAIL sandbox runtime: ${(proc.stderr || proc.stdout).trim().slice(0, 400)}`],
    };
  }

  try {
    const parsed = JSON.parse(proc.stdout) as { passed: number; failed: number; total: number; details: string[] };
    return {
      ...parsed,
      durationMs,
      isolation: proc.isolation,
    };
  } catch (err) {
    return {
      passed: 0,
      failed: 1,
      total: 1,
      durationMs,
      isolation: proc.isolation,
      details: [`FAIL invalid test output: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}
