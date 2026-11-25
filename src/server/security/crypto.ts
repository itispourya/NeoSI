import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Sign outgoing webhook payloads with HMAC-SHA256.
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
    .replace(/\b(neos_live_[a-zA-Z0-9_-]{12,}|neo_adm_[a-zA-Z0-9_.-]{12,}|sk-[a-zA-Z0-9_-]{16,}|AIza[a-zA-Z0-9_-]{20,})\b/g, '[REDACTED_SECRET]');
}

export function redactUnknownObject<T>(value: T): T {
  if (typeof value === 'string') return redactPII(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactUnknownObject(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/password|secret|token|ssn|iban|tax_id|passcode|api_key/i.test(k) && typeof v === 'string') {
        out[k] = '[REDACTED_FIELD]';
      } else {
        out[k] = redactUnknownObject(v);
      }
    }
    return out as T;
  }
  return value;
}

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.home\.arpa$/i,
  /^metadata\.google\.internal$/i,
];

export function isPrivateOrReservedIp(ipRaw: string): boolean {
  const ip = ipRaw.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!ip) return true;

  // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1 or ::ffff:7f00:1
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) {
      return isPrivateOrReservedIp(mapped);
    }
    const hexParts = mapped.split(':');
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateOrReservedIp(ipv4);
      }
    }
  }

  if (net.isIPv4(ip)) {
    const octets = ip.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
    const [a, b, c] = octets;
    if (a === 0) return true; // 0.0.0.0/8 ("this" network)
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
    if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
    if (a === 192 && b === 88 && c === 99) return true; // Deprecated 6to4 relay anycast
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // Benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a >= 224) return true; // Multicast & reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA fc00::/7
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // fe80::/10 link-local
    if (ip.startsWith('ff')) return true; // Multicast
    if (ip.startsWith('::')) return true; // Unspecified, loopback, and deprecated IPv4-compatible forms
    if (ip.startsWith('2001:')) {
      const secondHextet = Number.parseInt(ip.split(':')[1] || '0', 16);
      if (Number.isFinite(secondHextet) && (secondHextet <= 0x01ff || secondHextet === 0x0db8)) return true; // IETF special-purpose and documentation blocks
    }
    if (ip.startsWith('2002:')) return true; // 6to4 transition addresses
    if (ip.startsWith('3fff:')) return true; // IPv6 documentation range
    if (ip.startsWith('64:ff9b:')) return true; // Well-known NAT64 prefix
    return false;
  }

  return true;
}

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
  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'Embedded URL credentials are forbidden' };
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) {
    return { valid: false, reason: 'Missing hostname' };
  }
  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return { valid: false, reason: 'Loopback, private, or internal hostnames are blocked' };
    }
  }
  if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    return { valid: false, reason: 'Private, loopback, CGNAT, or link-local IP address blocked' };
  }
  return { valid: true, url: parsed };
}

/**
 * DNS-aware SSRF validation: resolves DNS A/AAAA records and rejects any host
 * resolving to private, loopback, link-local, metadata, or reserved networks.
 */
export async function validateExternalUrlAsync(
  rawUrl: string,
  lookupFn: (hostname: string) => Promise<Array<{ address: string; family: number }>> = (h) =>
    dns.lookup(h, { all: true })
): Promise<{ valid: boolean; url?: URL; resolvedIps?: string[]; reason?: string }> {
  const staticCheck = validateExternalUrl(rawUrl);
  if (!staticCheck.valid || !staticCheck.url) return staticCheck;

  const hostname = staticCheck.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(hostname)) {
    return { valid: true, url: staticCheck.url, resolvedIps: [hostname] };
  }

  try {
    const records = await lookupFn(hostname);
    if (!records || records.length === 0) {
      return { valid: false, reason: 'DNS resolution returned zero records' };
    }
    const ips = records.map((r) => r.address);
    for (const ip of ips) {
      if (isPrivateOrReservedIp(ip)) {
        return { valid: false, reason: `DNS resolved to blocked internal/private IP (${ip})` };
      }
    }
    return { valid: true, url: staticCheck.url, resolvedIps: ips };
  } catch (err) {
    return {
      valid: false,
      reason: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  lookupFn?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

function pinnedHttpFetch(
  url: URL,
  resolvedIps: string[],
  opts: SafeFetchOptions,
  timeoutMs: number,
  maxBytes: number
): Promise<Response> {
  const address = resolvedIps[0];
  const family = address ? net.isIP(address) : 0;
  if (!address || !family) return Promise.reject(new Error('No validated public IP available for the outbound connection.'));

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const headers = { 'Accept-Encoding': 'identity', ...(opts.headers || {}), Host: url.host };
    let settled = false;
    let receivedBytes = 0;
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearRequestTimer = () => { if (timer) clearTimeout(timer); };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearRequestTimer();
      reject(error);
    };

    // Pin the socket lookup to the IP already checked by validateExternalUrlAsync.
    const pinnedLookup = ((_host: string, _options: unknown, callback: (...args: unknown[]) => void) => {
      callback(null, address, family);
    }) as never;
    const request = transport.request({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: opts.method || 'GET',
      headers,
      lookup: pinnedLookup,
      ...(url.protocol === 'https:' && !net.isIP(hostname) ? { servername: hostname } : {}),
    }, (response) => {
      const declaredLength = Number(response.headers['content-length'] || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        request.destroy(new Error(`Response exceeded max allowed size (${maxBytes} bytes) from ${url.toString()}`));
        return;
      }
      response.on('data', (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += data.byteLength;
        if (receivedBytes > maxBytes) {
          request.destroy(new Error(`Response exceeded max allowed size (${maxBytes} bytes) from ${url.toString()}`));
          return;
        }
        chunks.push(data);
      });
      response.on('error', fail);
      response.on('aborted', () => fail(new Error(`Outbound response aborted by ${url.host}`)));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearRequestTimer();
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const status = response.statusCode || 502;
        const body = Buffer.concat(chunks);
        resolve(new Response([204, 205, 304].includes(status) ? null : body, {
          status,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }));
      });
    });
    request.on('error', fail);
    timer = setTimeout(() => request.destroy(new Error(`Outbound request timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    if (opts.body) request.write(opts.body);
    request.end();
  });
}
/**
 * SSRF-hardened external HTTP fetcher:
 * 1. Validates scheme, hostname, and resolved DNS IP addresses before connecting.
 * 2. Disables automatic redirects (`redirect: 'manual'`) and re-validates every redirect hop.
 * 3. Enforces strict timeout and response byte size cap.
 */
export async function safeExternalFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {}
): Promise<{ response: Response; finalUrl: string; bodyText: string; bodyBuffer: Buffer }> {
  const maxRedirects = opts.maxRedirects ?? 4;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 8) {
    throw new Error('maxRedirects must be an integer between 0 and 8.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('Invalid external fetch timeout or response size limit.');
  }
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await validateExternalUrlAsync(currentUrl, opts.lookupFn);
    if (!check.valid || !check.url) {
      throw new Error(`SSRF blocked URL '${currentUrl}': ${check.reason}`);
    }

    const res = opts.fetchImpl
      ? await opts.fetchImpl(check.url.toString(), {
          method: opts.method ?? 'GET',
          headers: opts.headers,
          body: opts.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        })
      : await pinnedHttpFetch(check.url, check.resolvedIps || [], opts, timeoutMs, maxBytes);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`Redirect (${res.status}) without Location header from ${currentUrl}`);
      }
      const next = new URL(location, check.url);
      // Never forward a signed webhook payload or caller-supplied headers to another origin.
      if (next.origin !== check.url.origin) {
        throw new Error(`Cross-origin redirect blocked from ${check.url.origin} to ${next.origin}`);
      }
      currentUrl = next.toString();
      continue;
    }

    const declaredLength = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await res.body?.cancel();
      throw new Error(`Response exceeded max allowed size (${maxBytes} bytes) from ${currentUrl}`);
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedBytes += value.byteLength;
          if (receivedBytes > maxBytes) {
            await reader.cancel();
            throw new Error(`Response exceeded max allowed size (${maxBytes} bytes) from ${currentUrl}`);
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bodyBuffer = Buffer.concat(chunks);
    const bufferedResponse = new Response(
      [204, 205, 304].includes(res.status) ? null : bodyBuffer,
      { status: res.status, statusText: res.statusText, headers: res.headers }
    );
    return {
      response: bufferedResponse,
      finalUrl: check.url.toString(),
      bodyBuffer,
      bodyText: bodyBuffer.toString('utf8'),
    };
  }

  throw new Error(`Exceeded maximum redirect hops (${maxRedirects}) starting from ${rawUrl}`);
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
