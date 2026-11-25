import crypto from 'node:crypto';
import net from 'node:net';

/**
 * Sign outgoing Neos webhook payloads with HMAC-SHA256.
 */
export function signWebhookPayload(payload: string, secret: string, timestamp = Date.now()): {
  signature: string;
  timestamp: string;
  header: string;
} {
  const ts = String(timestamp);
  const signedContent = `${ts}.${payload}`;
  const hmac = crypto.createHmac('sha256', secret).update(signedContent).digest('hex');
  return {
    signature: hmac,
    timestamp: ts,
    header: `t=${ts},v1=${hmac}`,
  };
}

export function verifyWebhookSignature(payload: string, header: string, secret: string, toleranceMs = 300_000): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k?.trim(), v?.trim()];
    })
  );
  if (!parts.t || !parts.v1) return false;
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > toleranceMs) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
  const a = Buffer.from(parts.v1, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Redact common PII (emails, phone numbers, SSNs, IBAN/cards, bearer tokens)
 */
export function redactPII(input: string): string {
  return input
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/\b(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g, '[REDACTED_PHONE]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_CARD]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]')
    .replace(/\b(neos_live_[a-zA-Z0-9_-]{12,}|sk-[a-zA-Z0-9_-]{16,}|AIza[a-zA-Z0-9_-]{20,})\b/g, '[REDACTED_SECRET]');
}

export function redactUnknownObject<T>(value: T): T {
  if (typeof value === 'string') return redactPII(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactUnknownObject(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/password|secret|token|ssn|iban|tax_id/i.test(k) && typeof v === 'string') {
        out[k] = '[REDACTED_FIELD]';
      } else {
        out[k] = redactUnknownObject(v);
      }
    }
    return out as T;
  }
  return value;
}

const PRIVATE_CIDR_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd00:/i,
  /\.local$/i,
  /\.internal$/i,
];

/**
 * SSRF protection: only allows external http/https URLs, rejecting loopback/private/link-local addresses.
 */
export function validateExternalUrl(rawUrl: string): { valid: boolean; url?: URL; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: 'Only http and https schemes are permitted' };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) {
    return { valid: false, reason: 'Missing hostname' };
  }
  for (const pattern of PRIVATE_CIDR_HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      return { valid: false, reason: 'Loopback, private, or link-local hosts are blocked' };
    }
  }
  if (net.isIPv4(hostname)) {
    const octets = hostname.split('.').map(Number);
    if (
      octets[0] === 127 ||
      octets[0] === 10 ||
      octets[0] === 0 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    ) {
      return { valid: false, reason: 'Private IPv4 range blocked' };
    }
  }
  return { valid: true, url: parsed };
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export function generateScopedApiKey(): { rawKey: string; prefix: string; hash: string } {
  const token = crypto.randomBytes(24).toString('base64url');
  const rawKey = `neos_live_${token}`;
  const prefix = rawKey.slice(0, 16);
  const hash = hashApiKey(rawKey);
  return { rawKey, prefix, hash };
}

export function hashPasscode(passcode: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPasscode(passcode: string, storedHash: string): boolean {
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex) return false;
  const derived = crypto.scryptSync(passcode, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}
