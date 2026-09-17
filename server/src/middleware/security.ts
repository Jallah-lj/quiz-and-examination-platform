import type { NextFunction, Request, Response } from 'express';
import type { AuthedRequest } from '../types';
import { env } from '../config/env';
import { rateLimited } from '../lib/errors';

/** Hardening headers applied to every response. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  if (env.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

/**
 * API responses are user- and session-specific, so they must never be stored or
 * revalidated: a cached `{ authenticated: false }` (or another user's body) replayed
 * from a conditional request is both incorrect and a disclosure risk.
 */
export function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Small in-process fixed-window limiter. Appropriate for a single-node deployment;
 * a shared store would be used behind a load balancer.
 */
export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  keyPrefix?: string;
  message?: string;
  /** Test suites raise the ceiling so that fixture logins are not throttled. */
  respectTestMode?: boolean;
}) {
  const buckets = new Map<string, Bucket>();
  const prefix = options.keyPrefix ?? 'rl';
  const max =
    env.isTest && options.respectTestMode !== false ? options.max * 1000 : options.max;

  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.min(options.windowMs, 60_000)).unref?.();

  return (req: Request, res: Response, next: NextFunction): void => {
    const authed = req as AuthedRequest;
    const identity = authed.user?.id ? `u:${authed.user.id}` : `ip:${req.ip ?? 'unknown'}`;
    const key = `${prefix}:${identity}:${req.baseUrl}${req.route?.path ?? req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return next(rateLimited(options.message ?? 'Too many requests. Please slow down and try again.'));
    }
    return next();
  };
}
