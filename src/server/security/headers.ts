import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.ts';

declare global {
  namespace Express {
    interface Request {
      neoRequestId?: string;
      neoCorrelationId?: string;
    }
  }
}

export function securityHeadersAndTracingMiddleware(req: Request, res: Response, next: NextFunction) {
  const requestId = req.header('x-request-id')?.slice(0, 80) || crypto.randomUUID();
  const correlationId = req.header('x-correlation-id')?.slice(0, 80) || requestId;
  req.neoRequestId = requestId;
  req.neoCorrelationId = correlationId;

  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Correlation-Id', correlationId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Strict CORS policy — never wildcard on authenticated endpoints
  const origin = req.header('origin');
  if (origin) {
    const requestHost = req.header('x-forwarded-host') || req.header('host') || '';
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    const isSameOrigin = Boolean(requestHost && originHost && originHost === requestHost);
    const isAllowed = isSameOrigin || env.corsAllowedOrigins.includes(origin);

    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-API-Key, X-Request-Id, X-Correlation-Id, Idempotency-Key'
      );
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, X-Correlation-Id, X-RateLimit-Remaining, X-RateLimit-Limit, X-RateLimit-Reset');
    } else if (req.method === 'OPTIONS') {
      return res.status(403).json({
        error: { code: 'CORS_ORIGIN_FORBIDDEN', message: 'Origin is not permitted by Neo CORS policy', requestId },
      });
    }
  }

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
}

export function structuredErrorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.neoRequestId || crypto.randomUUID();
  const status = (err as { status?: number })?.status || 500;
  // Never expose stack traces or raw secrets to callers
  const safeMessage =
    status >= 500
      ? 'Internal Neo system error. Inspect server logs with requestId.'
      : err instanceof Error
      ? err.message
      : 'Request error';

  console.error(`[Neo Error] requestId=${requestId} path=${req.path} status=${status}:`, err instanceof Error ? err.message : err);

  if (res.headersSent) return;
  res.status(status).json({
    error: {
      code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
      message: safeMessage,
      requestId,
      correlationId: req.neoCorrelationId || requestId,
    },
  });
}
