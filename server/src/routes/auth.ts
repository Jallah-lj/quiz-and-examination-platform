import { Router } from 'express';
import { env } from '../config/env';
import { getDb } from '../db';
import { asyncHandler, ok } from '../lib/http';
import { parseWith } from '../lib/validation';
import { z } from 'zod';
import { authenticate, extractTokenCandidates, requireAuth } from '../middleware/auth';
import { createRateLimiter } from '../middleware/security';
import {
  changePassword,
  completePasswordReset,
  login,
  logout,
  requestPasswordReset,
  resolveSession,
  selfRegister,
  sendVerificationEmail,
  verifyEmailToken,
  createEmailVerification,
} from '../services/auth';
import { recordAudit } from '../services/audit';
import type { AuthedRequest } from '../types';
import { forbidden, notFound } from '../lib/errors';
import { nowIso } from '../lib/time';
import { sessionCookieOptions } from '../lib/cookies';

const router = Router();

const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: 'login' });
const sensitiveLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, keyPrefix: 'sensitive' });
const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5, keyPrefix: 'register' });

function requestMeta(req: AuthedRequest) {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

function setSessionCookies(
  req: AuthedRequest,
  res: import('express').Response,
  token: string,
  csrfToken: string,
  expiresAt: string,
): void {
  // Attributes follow the actual request transport: Secure is meaningless (and breaks
  // storage) on a plain-HTTP origin, while an embedded HTTPS deployment needs
  // SameSite=None to receive the cookie at all. Explicit COOKIE_* settings win.
  const options = sessionCookieOptions(req, new Date(expiresAt));
  res.cookie(env.cookieName, token, { ...options, httpOnly: true });
  // The CSRF token is intentionally readable by the SPA (double-submit pattern).
  res.cookie(`${env.cookieName}_csrf`, csrfToken, { ...options, httpOnly: false });
}

function clearSessionCookies(res: import('express').Response): void {
  res.clearCookie(env.cookieName, { path: '/' });
  res.clearCookie(`${env.cookieName}_csrf`, { path: '/' });
}

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = parseWith(
      z.object({
        email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
        password: z.string().min(1, 'Enter your password.'),
      }),
      req.body,
    );
    const db = getDb();
    const session = await login(db, body.email, body.password, requestMeta(req));
    setSessionCookies(req, res, session.token, session.csrfToken, session.expiresAt);
    // Cookie-blocked clients (embedded/iframe previews, webviews) cannot keep the session
    // cookie, so when the token transport is enabled the sign-in response also carries the
    // session token. The client sends it back as `Authorization: Bearer`; the cookie stays
    // the preferred transport on the server, and production defaults to cookie-only.
    const issueToken = env.allowSessionTokens;
    return ok(res, {
      user: {
        id: session.user.id,
        fullName: session.user.fullName,
        email: session.user.email,
        role: session.user.roleCode,
        roleName: session.user.roleName,
        institutionId: session.user.institutionId,
        permissions: session.user.permissions,
        studentId: session.user.studentId,
        teacherId: session.user.teacherId,
      },
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      ...(issueToken ? { sessionToken: session.token, tokenTransport: 'bearer' as const } : {}),
    });
  }),
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    logout(db, req.user!.sessionId, req.user!.id, requestMeta(req));
    clearSessionCookies(res);
    return ok(res, { message: 'You have been signed out.' });
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) {
      // Distinguishes "this client sent no session at all" (cookies blocked, no token yet)
      // from "a session was presented and rejected" (stale/revoked/expired). The client
      // needs that difference to recover instead of looping on a dead credential.
      const status = extractTokenCandidates(req).length > 0 ? 'unresolved' : 'none';
      return ok(res, { authenticated: false, sessionStatus: status, user: null });
    }
    const db = getDb();
    const csrfToken = req.cookies?.[`${env.cookieName}_csrf`] ?? null;
    const institution = req.user.institutionId
      ? (db.prepare('SELECT id, name, code, type, timezone FROM institutions WHERE id = ?').get(req.user.institutionId) as any)
      : null;

    const student = req.user.studentId
      ? (db
          .prepare(
            `SELECT s.id, s.student_code, s.class_id, c.name AS class_name, d.name AS department_name
               FROM students s LEFT JOIN classes c ON c.id = s.class_id
               LEFT JOIN departments d ON d.id = c.department_id WHERE s.id = ?`,
          )
          .get(req.user.studentId) as any)
      : null;

    const teacher = req.user.teacherId
      ? (db
          .prepare(
            `SELECT t.id, t.staff_code, t.designation, t.department_id, d.name AS department_name
               FROM teachers t LEFT JOIN departments d ON d.id = t.department_id WHERE t.id = ?`,
          )
          .get(req.user.teacherId) as any)
      : null;

    const unread = (
      db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id) as {
        c: number;
      }
    ).c;

    return ok(res, {
      authenticated: true,
      sessionStatus: 'valid' as const,
      csrfToken,
      unreadNotifications: unread,
      user: {
        id: req.user.id,
        fullName: req.user.fullName,
        email: req.user.email,
        role: req.user.roleCode,
        roleName: req.user.roleName,
        institutionId: req.user.institutionId,
        permissions: req.user.permissions,
        student,
        teacher,
        institution,
      },
    });
  }),
);

router.post(
  '/change-password',
  authenticate,
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(10, 'Password must be at least 10 characters long.'),
      }),
      req.body,
    );
    const db = getDb();
    changePassword(db, req.user!.id, body.currentPassword, body.newPassword, {
      ...requestMeta(req),
      keepSessionId: req.user!.sessionId,
    });
    return ok(res, { message: 'Your password has been updated.' });
  }),
);

router.post(
  '/forgot-password',
  sensitiveLimiter,
  asyncHandler(async (req, res) => {
    const body = parseWith(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
    const db = getDb();
    const result = await requestPasswordReset(db, body.email, requestMeta(req));

    // In non-production environments the reset link is returned so that a developer
    // can complete the flow without an SMTP server. Production never exposes it.
    return ok(res, {
      message: 'If an account exists for that address, a password reset link has been emailed to it.',
      ...(env.exposeResetTokens && result.token ? { resetToken: result.token } : {}),
    });
  }),
);

router.post(
  '/reset-password',
  sensitiveLimiter,
  asyncHandler(async (req, res) => {
    const body = parseWith(
      z.object({ token: z.string().min(10), password: z.string().min(10, 'Password must be at least 10 characters long.') }),
      req.body,
    );
    const db = getDb();
    await completePasswordReset(db, body.token, body.password, requestMeta(req));
    return ok(res, { message: 'Your password has been reset. You can now sign in.' });
  }),
);

router.get('/public-institutions', (_req, res) => {
  const db = getDb();
  const institutions = db
    .prepare("SELECT id, name, code, type, country FROM institutions WHERE status = 'active' ORDER BY name ASC")
    .all();
  return ok(res, institutions);
});

router.post(
  '/register',
  registerLimiter,
  asyncHandler(async (req, res) => {
    const body = parseWith(
      z.object({
        fullName: z.string().trim().min(2).max(160),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(10, 'Password must be at least 10 characters long.'),
        institutionId: z.coerce.number().int().positive(),
        studentCode: z.string().trim().max(40).optional(),
      }),
      req.body,
    );
    const db = getDb();
    const result = await selfRegister(db, body, requestMeta(req));
    return ok(
      res,
      {
        message:
          'Your registration has been received. An administrator must activate your account before you can sign in.',
        userId: result.userId,
        ...(env.exposeResetTokens ? { verificationToken: result.verificationToken } : {}),
      },
      201,
    );
  }),
);

router.post(
  '/verify-email',
  sensitiveLimiter,
  asyncHandler(async (req, res) => {
    const body = parseWith(z.object({ token: z.string().min(10) }), req.body);
    const db = getDb();
    const result = verifyEmailToken(db, body.token);
    return ok(res, { message: 'Your email address has been verified.', userId: result.userId });
  }),
);

router.post(
  '/resend-verification',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const user = db.prepare('SELECT id, email, email_verified_at FROM users WHERE id = ?').get(req.user!.id) as any;
    if (!user) throw notFound('Account not found.');
    if (user.email_verified_at) return ok(res, { message: 'Your email address is already verified.' });
    const token = createEmailVerification(db, user.id, user.email);
    recordAudit(db, {
      institutionId: req.user!.institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'auth.verification_resent',
      category: 'auth',
      description: 'Email verification re-issued',
    });
    const delivery = await sendVerificationEmail(db, {
      userId: user.id,
      email: user.email,
      fullName: req.user!.fullName,
      institutionId: req.user!.institutionId,
      token,
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return ok(res, {
      message: delivery.delivered
        ? 'A new verification link has been sent to your email address.'
        : 'A new verification link was generated, but the email could not be sent. Contact your administrator.',
      ...(env.exposeResetTokens ? { verificationToken: token } : {}),
    });
  }),
);

router.get(
  '/sessions',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const sessions = db
      .prepare(
        `SELECT id, user_agent, ip_address, created_at, last_seen_at, expires_at
           FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY last_seen_at DESC`,
      )
      .all(req.user!.id, nowIso()) as any[];
    return ok(
      res,
      sessions.map((s) => ({ ...s, current: s.id === req.user!.sessionId })),
    );
  }),
);

router.delete(
  '/sessions/:id',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const session = db.prepare('SELECT id, user_id FROM sessions WHERE id = ?').get(Number(req.params.id)) as any;
    if (!session || session.user_id !== req.user!.id) throw notFound('Session not found.');
    if (session.id === req.user!.sessionId) throw forbidden('You cannot revoke the session you are using.');
    db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(
      nowIso(),
      'revoked_by_user',
      session.id,
    );
    recordAudit(db, {
      institutionId: req.user!.institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'auth.session_revoked',
      category: 'auth',
      resourceType: 'session',
      resourceId: session.id,
      description: 'Revoked a sign-in session',
    });
    return ok(res, { message: 'Session revoked.' });
  }),
);

/** Lightweight endpoint the SPA uses to confirm the session is still valid. */
router.get(
  '/ping',
  authenticate,
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const user = req.authToken ? resolveSession(db, req.authToken) : null;
    return ok(res, { authenticated: Boolean(user), serverTime: nowIso() });
  }),
);

export default router;
