import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.ts';
import { getDb } from '../db/adapter.ts';
import type { TenantRecord } from '../db/schema.ts';
import { hashApiKey, hashPasscode, verifyPasscode } from './crypto.ts';

export interface AuthenticatedContext {
  actorType: 'api_key' | 'admin' | 'preview_unclaimed';
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

export function checkRateLimit(bucketKey: string, maxRpm: number): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  const windowStart = now - 60_000;
  const timestamps = (rateBuckets.get(bucketKey) || []).filter((t) => t > windowStart);
  if (timestamps.length >= maxRpm) {
    const oldest = timestamps[0] || now;
    return { allowed: false, remaining: 0, resetMs: Math.max(1000, oldest + 60_000 - now) };
  }
  timestamps.push(now);
  rateBuckets.set(bucketKey, timestamps);
  return { allowed: true, remaining: maxRpm - timestamps.length, resetMs: 60_000 };
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
  if (state.locked) {
    return { ok: false, error: 'Admin access is already configured and locked.' };
  }
  if (!passcode || passcode.length < 6) {
    return { ok: false, error: 'Passcode must be at least 6 characters.' };
  }
  const db = await getDb();
  await db.setAdminConfig('admin_passcode_hash', hashPasscode(passcode));
  return { ok: true };
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

export async function requireAdminConsoleAuth(req: Request, res: Response, next: NextFunction) {
  const lockState = await getAdminLockState();
  const token = extractBearerOrKey(req);

  if (!lockState.locked) {
    // Preview mode before admin passcode is claimed or env var is set
    const db = await getDb();
    const tenants = await db.listTenants();
    req.neoAuth = {
      actorType: 'preview_unclaimed',
      actorLabel: 'admin-preview',
      tenant: tenants[0],
      scopes: ['read', 'write', 'forge', 'admin'],
    };
    return next();
  }

  if (!token || !verifyAdminToken(token)) {
    return res.status(401).json({ error: 'Admin authentication required', authRequired: true });
  }

  const db = await getDb();
  const tenants = await db.listTenants();
  req.neoAuth = {
    actorType: 'admin',
    actorLabel: 'admin-session',
    tenant: tenants[0],
    scopes: ['read', 'write', 'forge', 'admin'],
  };
  return next();
}

export function requireApiGatewayAuth(requiredScope = 'read') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const rawCredential = extractBearerOrKey(req);
    const db = await getDb();

    // 1. Check scoped neos_live_ API Key
    if (rawCredential && rawCredential.startsWith('neos_live_')) {
      const keyHash = hashApiKey(rawCredential);
      const apiKey = await db.getApiKeyByHash(keyHash);
      if (!apiKey || apiKey.revoked_at) {
        return res.status(401).json({ error: 'Invalid or revoked Neos API key' });
      }
      if (!apiKey.scopes.includes(requiredScope) && !apiKey.scopes.includes('admin')) {
        return res.status(403).json({ error: `API key missing required scope: ${requiredScope}` });
      }
      const tenant = await db.getTenantById(apiKey.tenant_id);
      if (!tenant) {
        return res.status(401).json({ error: 'Tenant not found for API key' });
      }

      const limit = checkRateLimit(`key:${apiKey.id}`, tenant.rate_limit_rpm);
      res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
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

    // 2. Check Admin session Bearer token (or unclaimed console workbench request)
    if (rawCredential && verifyAdminToken(rawCredential)) {
      const tenants = await db.listTenants();
      req.neoAuth = {
        actorType: 'admin',
        actorLabel: 'admin-session',
        tenant: tenants[0],
        scopes: ['read', 'write', 'forge', 'admin'],
      };
      return next();
    }

    const lockState = await getAdminLockState();
    const isConsoleOrigin = req.header('x-neo-console') === '1';
    if (!lockState.locked && isConsoleOrigin) {
      const tenants = await db.listTenants();
      req.neoAuth = {
        actorType: 'preview_unclaimed',
        actorLabel: 'console-workbench',
        tenant: tenants[0],
        scopes: ['read', 'write', 'forge', 'admin'],
      };
      return next();
    }

    return res.status(401).json({ error: 'Missing or invalid Authorization: Bearer neos_live_... API key' });
  };
}
