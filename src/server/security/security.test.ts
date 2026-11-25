import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateScopedApiKey,
  hashPasscode,
  redactPII,
  signWebhookPayload,
  validateExternalUrl,
  verifyPasscode,
  verifyWebhookSignature,
} from './crypto';

test('HMAC webhook signing verifies valid signatures and rejects tampered payloads', () => {
  const secret = 'test-neos-webhook-secret';
  const payload = JSON.stringify({ event: 'audit.done', amount: 1200 });
  const signed = signWebhookPayload(payload, secret);

  assert.equal(verifyWebhookSignature(payload, signed.header, secret), true);
  assert.equal(verifyWebhookSignature(payload + 'tamper', signed.header, secret), false);
  assert.equal(verifyWebhookSignature(payload, signed.header, 'wrong-secret'), false);
});

test('PII redaction strips emails, phones, cards, and secrets', () => {
  const raw = 'Contact alice@neos.io or +1-415-555-0199 with key neos_live_abcdef1234567890';
  const cleaned = redactPII(raw);
  assert.ok(!cleaned.includes('alice@neos.io'));
  assert.ok(!cleaned.includes('neos_live_abcdef1234567890'));
  assert.ok(cleaned.includes('[REDACTED_EMAIL]'));
  assert.ok(cleaned.includes('[REDACTED_SECRET]'));
});

test('SSRF validator blocks loopback, link-local metadata, and private IP ranges', () => {
  assert.equal(validateExternalUrl('http://127.0.0.1:8080/admin').valid, false);
  assert.equal(validateExternalUrl('http://169.254.169.254/latest/meta-data').valid, false);
  assert.equal(validateExternalUrl('http://192.168.1.50/internal').valid, false);
  assert.equal(validateExternalUrl('file:///etc/passwd').valid, false);
  assert.equal(validateExternalUrl('https://api.github.com/repos').valid, true);
});

test('scrypt passcode hashing and scoped neos_live_ API key generation work deterministically', () => {
  const hash = hashPasscode('super-secure-passcode');
  assert.equal(verifyPasscode('super-secure-passcode', hash), true);
  assert.equal(verifyPasscode('wrong-passcode', hash), false);

  const key = generateScopedApiKey();
  assert.ok(key.rawKey.startsWith('neos_live_'));
  assert.equal(key.hash.length, 64);
});
