import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBenchmarkGate, isProtectedPath, validateTargetFiles } from './pipeline';

test('protected core security and env files cannot be targeted by self-upgrades', () => {
  assert.equal(isProtectedPath('.env'), true);
  assert.equal(isProtectedPath('src/server/security/auth.ts'), true);
  assert.equal(isProtectedPath('src/server/config/env.ts'), true);
  assert.equal(isProtectedPath('../src/server/security/auth.ts'), true);
  assert.equal(isProtectedPath('/etc/passwd'), true);
  assert.equal(isProtectedPath('src/server/modules/optimizer.js'), false);

  const check = validateTargetFiles(['src/server/modules/ok.js', 'src/server/security/crypto.ts']);
  assert.equal(check.allowed, false);
  assert.deepEqual(check.blockedFiles, ['src/server/security/crypto.ts']);
});

test('benchmark gate rejects failing tests or accuracy regressions', () => {
  const pass = evaluateBenchmarkGate(
    { accuracyScore: 88, avgLatencyMs: 200, passRate: 100 },
    { accuracyScore: 92, avgLatencyMs: 180, passRate: 100 },
    { passed: 3, failed: 0, total: 3 }
  );
  assert.equal(pass.passed, true);

  const failRegress = evaluateBenchmarkGate(
    { accuracyScore: 88, avgLatencyMs: 200, passRate: 100 },
    { accuracyScore: 85, avgLatencyMs: 180, passRate: 100 },
    { passed: 3, failed: 0, total: 3 }
  );
  assert.equal(failRegress.passed, false);

  const failTests = evaluateBenchmarkGate(
    { accuracyScore: 88, avgLatencyMs: 200, passRate: 100 },
    { accuracyScore: 92, avgLatencyMs: 180, passRate: 50 },
    { passed: 1, failed: 1, total: 2 }
  );
  assert.equal(failTests.passed, false);
});
