import type { NextFunction, Response } from 'express';
import { env } from '../config/env';
import { getDb } from '../db';
import { forbidden, unauthenticated } from '../lib/errors';
import { resolveSession, verifyCsrf } from '../services/auth';
import type { AuthedRequest, RoleCode } from '../types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Candidate session tokens for a request, most preferred first (cookie, then bearer). */
export function extractTokenCandidates(req: AuthedRequest): string[] {
  const candidates: string[] = [];
  const cookieToken = req.cookies?.[env.cookieName];
  if (typeof cookieToken === 'string' && cookieToken) candidates.push(cookieToken);
  const header = req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    const bearer = header.slice(7).trim();
    if (bearer) candidates.push(bearer);
  }
  return candidates;
}

/** Kept for callers that only need the preferred token. */
export function extractToken(req: AuthedRequest): string | null {
  return extractTokenCandidates(req)[0] ?? null;
}

/**
 * Resolves the current user from the session cookie (or bearer token) and, for
 * state-changing requests, enforces a double-submit CSRF token. Permissions are
 * always read from the database — never trusted from the client.
 */
export function authenticate(req: AuthedRequest, _res: Response, next: NextFunction): void {
  try {
    const candidates = extractTokenCandidates(req);
    if (!candidates.length) return next();
    const db = getDb();

    // A stale cookie must not shadow a valid bearer token, so try each candidate.
    let user: ReturnType<typeof resolveSession> = null;
    let token: string | null = null;
    for (const candidate of candidates) {
      const resolved = resolveSession(db, candidate);
      if (resolved) {
        user = resolved;
        token = candidate;
        break;
      }
    }
    if (!user || !token) return next();

    if (!SAFE_METHODS.has(req.method)) {
      const csrfHeader = req.header('x-csrf-token') ?? (req.body?.__csrf as string | undefined);
      if (!csrfHeader || !verifyCsrf(db, user.sessionId, csrfHeader)) {
        return next(forbidden('Your session token is missing or invalid. Please refresh the page and try again.'));
      }
    }

    req.user = user;
    req.authToken = token;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction): void {
  if (!req.user) return next(unauthenticated('You must sign in to continue.'));
  return next();
}

export function requirePermission(...permissions: string[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthenticated('You must sign in to continue.'));
    const granted = permissions.some((p) => req.user!.permissions.includes(p));
    if (!granted) {
      return next(forbidden('You do not have permission to perform this action.'));
    }
    return next();
  };
}

export function requireRole(...roles: RoleCode[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(unauthenticated('You must sign in to continue.'));
    if (!roles.includes(req.user.roleCode)) {
      return next(forbidden('You do not have permission to perform this action.'));
    }
    return next();
  };
}

/** Convenience guard: the caller must be able to act on the institution. */
export function assertInstitutionAccess(user: AuthedRequest['user'], institutionId: number | null): void {
  if (!user) throw unauthenticated();
  if (user.roleCode === 'super_admin') return;
  if (institutionId === null || user.institutionId !== institutionId) {
    throw forbidden('You do not have permission to access data from another institution.');
  }
}
