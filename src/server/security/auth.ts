import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import type { TenantRecord } from '../db/schema.ts';
import { hashApiKey, hashPasscode, verifyPasscode } from './crypto.ts';

export interface AuthenticatedContext {
  actorType: 'api_key' | 'admin';
  actorLabel: string;
  tenant: TenantRecord;
  scopes: string[];
}

declare global {
  namespace Express {
    interface Request {
      neoAuth?: AuthenticatedContext;
    }
  }
}

// In-memory sliding-window rate limiter per key/endpoint
const rateBuckets = new Map<string, number[]>();

export function checkRateLimit(bucketKey: string, maxRpm: number): { allowed: boolean; limit: number; remaining: number; resetMs: number } {
  const now = Date.now();
  const windowStart = now - 60_000;
  if (rateBuckets.size > 10_000) {
    for (const [key, values] of rateBuckets) {
      if (!values.length || values[values.length - 1] <= windowStart) rateBuckets.delete(key);
    }
    while (rateBuckets.size > 10_000) {
      const oldestKey = rateBuckets.keys().next().value;
      if (!oldestKey) break;
      rateBuckets.delete(oldestKey);
    }
  }
  const timestamps = (rateBuckets.get(bucketKey) || []).filter((t) => t > windowStart);
  if (timestamps.length >= maxRpm) {
    const oldest = timestamps[0] || now;
    return { allowed: false, limit: maxRpm, remaining: 0, resetMs: Math.max(1000, oldest + 60_000 - now) };
  }
  timestamps.push(now);
  rateBuckets.set(bucketKey, timestamps);
  return { allowed: true, limit: maxRpm, remaining: maxRpm - timestamps.length, resetMs: 60_000 };
}

export function clearRateLimitsForTests(): void {
  rateBuckets.clear();
}

export function issueAdminToken(): string {
  const payload = Buffer.from(JSON.stringify({ role: 'admin', exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
  return `neo_adm_${payload}.${sig}`;
}

export function verifyAdminToken(token: string): boolean {
  if (!token.startsWith('neo_adm_')) return false;
  const raw = token.slice('neo_adm_'.length);
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return false;
  const expectedSig = crypto.createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return Boolean(decoded.exp && decoded.exp > Date.now());
  } catch {
    return false;
  }
}

export async function getAdminLockState(): Promise<{ locked: boolean; source: 'env' | 'claimed' | 'unclaimed' }> {
  if (env.adminPasscode) {
    return { locked: true, source: 'env' };
  }
  const db = await getDb();
  const claimedHash = await db.getAdminConfig('admin_passcode_hash');
  if (claimedHash) {
    return { locked: true, source: 'claimed' };
  }
  return { locked: false, source: 'unclaimed' };
}

export async function verifyAdminCredential(passcode: string): Promise<boolean> {
  if (!passcode) return false;
  if (env.adminPasscode) {
    const a = Buffer.from(passcode, 'utf8');
    const b = Buffer.from(env.adminPasscode, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const db = await getDb();
  const claimedHash = await db.getAdminConfig('admin_passcode_hash');
  if (!claimedHash) return false;
  return verifyPasscode(passcode, claimedHash);
}

export async function claimInitialAdminPasscode(passcode: string): Promise<{ ok: boolean; error?: string }> {
  const state = await getAdminLockState();
  if (state.locked) return { ok: false, error: 'Admin access is already configured and locked.' };
  if (!passcode || passcode.length < 12 || passcode.length > 256) {
    return { ok: false, error: 'Passcode must be between 12 and 256 characters.' };
  }
  const db = await getDb();
  // Atomic insert prevents two concurrent first-run requests (including across instances) from both claiming admin.
  const claimed = await db.setAdminConfigIfAbsent('admin_passcode_hash', hashPasscode(passcode));
  return claimed
    ? { ok: true }
    : { ok: false, error: 'Admin access was claimed by another request. Sign in with the configured passcode.' };
}

function extractBearerOrKey(req: Request): string | null {
  const xApiKey = req.header('x-api-key');
  if (xApiKey) return xApiKey.trim();
  const auth = req.header('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

/**
 * Strict Admin Console Auth — never grants unauthenticated access (even when unclaimed).
 * Callers must first claim/login via /api/admin/auth/claim or /api/admin/auth/login to receive a signed neo_adm_ token.
 */
export async function requireAdminConsoleAuth(req: Request, res: Response, next: NextFunction) {
  const lockState = await getAdminLockState();
  const token = extractBearerOrKey(req);

  if (!token || !verifyAdminToken(token)) {
    return res.status(401).json({
      error: lockState.locked
        ? 'Admin authentication required'
        : 'Initial admin setup required. Claim admin passcode first.',
      authRequired: true,
      lockState,
    });
  }

  const db = await getDb();
  const tenants = await db.listTenants();
  const requestedTenant = req.header('x-neo-workspace');
  const activeTenant = requestedTenant ? await db.getTenantById(requestedTenant) : tenants[0];
  if (requestedTenant && !activeTenant) return res.status(403).json({ error: 'Requested workspace is not available to this administrator.' });
  if (!activeTenant) return res.status(503).json({ error: 'No workspace is configured.' });

  const limit = checkRateLimit(`admin:${activeTenant.id}`, activeTenant.rate_limit_rpm);
  res.setHeader('X-RateLimit-Limit', String(limit.limit));
  res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(limit.resetMs / 1000)));
  if (!limit.allowed) return res.status(429).json({ error: 'Rate limit exceeded', retryAfterMs: limit.resetMs });

  req.neoAuth = {
    actorType: 'admin',
    actorLabel: 'admin-session',
    tenant: activeTenant,
    scopes: ['read', 'write', 'forge', 'admin'],
  };
  return next();
}

export function requireApiGatewayAuth(requiredScope = 'read') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const rawCredential = extractBearerOrKey(req);
    const db = await getDb();

    // 1. Scoped neos_live_ API Key (with strict tenant binding & rate limits)
    if (rawCredential && rawCredential.startsWith('neos_live_')) {
      const keyHash = hashApiKey(rawCredential);
      const apiKey = await db.getApiKeyByHash(keyHash);
      if (!apiKey || apiKey.revoked_at) {
        return res.status(401).json({ error: 'Invalid or revoked Neo API key' });
      }
      if (!apiKey.scopes.includes(requiredScope) && !apiKey.scopes.includes('admin')) {
        return res.status(403).json({ error: `API key missing required scope: ${requiredScope}` });
      }
      const tenant = await db.getTenantById(apiKey.tenant_id);
      if (!tenant) {
        return res.status(401).json({ error: 'Workspace/tenant not found for API key' });
      }

      const limit = checkRateLimit(`key:${apiKey.id}`, tenant.rate_limit_rpm);
      res.setHeader('X-RateLimit-Limit', String(limit.limit));
      res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(limit.resetMs / 1000)));
      if (!limit.allowed) {
        return res.status(429).json({ error: 'Rate limit exceeded', retryAfterMs: limit.resetMs });
      }

      await db.touchApiKey(apiKey.id);
      req.neoAuth = {
        actorType: 'api_key',
        actorLabel: apiKey.key_prefix,
        tenant,
        scopes: apiKey.scopes,
      };
      return next();
    }

    // 2. Signed Admin session Bearer token (optional workspace scoping via X-Neo-Workspace)
    if (rawCredential && verifyAdminToken(rawCredential)) {
      const tenants = await db.listTenants();
      const requestedTenant = req.header('x-neo-workspace');
      const activeTenant = requestedTenant ? await db.getTenantById(requestedTenant) : tenants[0];
      if (requestedTenant && !activeTenant) return res.status(403).json({ error: 'Requested workspace is not available to this administrator.' });
      if (!activeTenant) return res.status(503).json({ error: 'No workspace is configured.' });
      const limit = checkRateLimit(`admin:${activeTenant.id}`, activeTenant.rate_limit_rpm);
      res.setHeader('X-RateLimit-Limit', String(limit.limit));
      res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(limit.resetMs / 1000)));
      if (!limit.allowed) {
        return res.status(429).json({ error: 'Rate limit exceeded', retryAfterMs: limit.resetMs });
      }
      req.neoAuth = {
        actorType: 'admin',
        actorLabel: 'admin-session',
        tenant: activeTenant,
        scopes: ['read', 'write', 'forge', 'admin'],
      };
      return next();
    }

    return res.status(401).json({
      error: 'Authentication required. Provide Authorization: Bearer neos_live_... or signed admin session token.',
      authRequired: true,
    });
  };
}
