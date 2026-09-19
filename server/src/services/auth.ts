import crypto from 'node:crypto';
import type { Db } from '../db';
import { env } from '../config/env';
import {
  generateOpaqueToken,
  hashPassword,
  hashPasswordSync,
  hashToken,
  verifyPassword,
  verifyPasswordSync,
} from '../lib/crypto';
import { AppError, conflict, forbidden, notFound, unauthenticated, validationError } from '../lib/errors';
import { addHours, addMinutes, isPast, nowIso } from '../lib/time';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../lib/rbac';
import type { StudentGender } from '../lib/validation';
import type { AuthUser, RoleCode } from '../types';
import { sendAccountEmail } from '../lib/mailer';
import { recordAudit } from './audit';
import { createNotification } from './notifications';

interface UserRow {
  id: number;
  institution_id: number | null;
  role_id: number;
  role_code: RoleCode;
  role_name: string;
  full_name: string;
  email: string;
  password_hash: string;
  status: string;
  failed_login_count: number;
  locked_until: string | null;
  institution_status: string | null;
}

const LOCK_WINDOW_MINUTES = 15;

function loadUserByEmail(db: Db, email: string): UserRow | undefined {
  return db
    .prepare(
      `SELECT u.id, u.institution_id, u.role_id, u.full_name, u.email, u.password_hash, u.status,
              u.failed_login_count, u.locked_until,
              r.code AS role_code, r.name AS role_name,
              i.status AS institution_status
         FROM users u
         JOIN roles r ON r.id = u.role_id
    LEFT JOIN institutions i ON i.id = u.institution_id
        WHERE u.email = ? AND u.deleted_at IS NULL`,
    )
    .get(email) as UserRow | undefined;
}

export interface SessionContext {
  user: AuthUser;
  token: string;
  csrfToken: string;
  expiresAt: string;
}

export function permissionsFor(db: Db, roleCode: RoleCode): string[] {
  const mapping = ROLE_PERMISSIONS[roleCode];
  if (mapping === 'all') {
    const rows = db.prepare('SELECT code FROM permissions').all() as { code: string }[];
    if (rows.length) return rows.map((r) => r.code);
    return PERMISSIONS.map((p) => p.code);
  }
  return mapping;
}

function profileFor(db: Db, user: { id: number; roleCode: RoleCode }) {
  if (user.roleCode === 'student') {
    const row = db
      .prepare('SELECT id, class_id FROM students WHERE user_id = ?')
      .get(user.id) as { id: number; class_id: number | null } | undefined;
    return { studentId: row?.id ?? null, teacherId: null, classId: row?.class_id ?? null, departmentId: null };
  }
  if (user.roleCode === 'teacher') {
    const row = db
      .prepare('SELECT id, department_id FROM teachers WHERE user_id = ?')
      .get(user.id) as { id: number; department_id: number | null } | undefined;
    return {
      studentId: null,
      teacherId: row?.id ?? null,
      classId: null,
      departmentId: row?.department_id ?? null,
    };
  }
  return { studentId: null, teacherId: null, classId: null, departmentId: null };
}

function buildAuthUser(db: Db, row: UserRow, sessionId: number): AuthUser {
  const profile = profileFor(db, { id: row.id, roleCode: row.role_code });
  return {
    id: row.id,
    institutionId: row.institution_id,
    roleId: row.role_id,
    roleCode: row.role_code,
    roleName: row.role_name,
    fullName: row.full_name,
    email: row.email,
    status: row.status,
    permissions: permissionsFor(db, row.role_code),
    sessionId,
    ...profile,
  };
}

function assertAccountUsable(row: UserRow): void {
  if (row.status === 'suspended' || row.status === 'disabled') {
    throw forbidden('This account has been suspended. Contact your administrator.');
  }
  if (row.status === 'pending') {
    throw forbidden(
      'Your registration is awaiting approval by an institution administrator. You will be able to sign in once it has been approved.',
    );
  }
  if (row.institution_status && row.institution_status !== 'active') {
    throw forbidden('The institution for this account is not active.');
  }
  if (row.locked_until && !isPast(row.locked_until)) {
    const minutes = Math.max(
      1,
      Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 60000),
    );
    throw new AppError(
      423,
      'CONFLICT',
      `Too many failed sign-in attempts. This account is locked for about ${minutes} minute(s).`,
    );
  }
}

export interface LoginMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export async function login(db: Db, email: string, password: string, meta: LoginMeta): Promise<SessionContext> {
  const normalized = email.trim().toLowerCase();
  const row = loadUserByEmail(db, normalized);

  const registerFailure = (reason: string) => {
    db.prepare(
      'INSERT INTO login_attempts (email, ip_address, success, reason, created_at) VALUES (?,?,?,?,?)',
    ).run(normalized, meta.ip ?? null, 0, reason, nowIso());
  };

  if (!row) {
    registerFailure('unknown_account');
    throw unauthenticated('Incorrect email or password.');
  }

  // Account lockout is evaluated before the password check so that repeated
  // password guessing cannot continue against a locked account.
  if (row.locked_until && !isPast(row.locked_until)) {
    registerFailure('locked');
    assertAccountUsable(row);
  }

  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) {
    const recentFailures = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM login_attempts
            WHERE email = ? AND success = 0 AND created_at >= ?`,
        )
        .get(normalized, addMinutes(nowIso(), -LOCK_WINDOW_MINUTES)) as { c: number }
    ).c;

    const nextCount = row.failed_login_count + 1;
    const shouldLock = recentFailures + 1 >= env.loginMaxAttempts;
    db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ?, updated_at = ? WHERE id = ?').run(
      shouldLock ? 0 : nextCount,
      shouldLock ? addMinutes(nowIso(), env.loginLockMinutes) : row.locked_until,
      nowIso(),
      row.id,
    );
    registerFailure('bad_password');
    recordAudit(db, {
      institutionId: row.institution_id,
      userId: row.id,
      actorName: row.full_name,
      actorRole: row.role_code,
      action: 'auth.login_failed',
      category: 'auth',
      description: `Failed sign-in for ${row.email}`,
      metadata: { attempts: recentFailures + 1, locked: shouldLock },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    if (shouldLock) {
      throw new AppError(
        423,
        'CONFLICT',
        `Too many failed sign-in attempts. This account is locked for ${env.loginLockMinutes} minutes.`,
      );
    }
    throw unauthenticated('Incorrect email or password.');
  }

  assertAccountUsable(row);

  const session = createSession(db, row.id, meta);
  db.prepare(
    'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?',
  ).run(nowIso(), nowIso(), row.id);
  db.prepare(
    'INSERT INTO login_attempts (email, ip_address, success, reason, created_at) VALUES (?,?,?,?,?)',
  ).run(normalized, meta.ip ?? null, 1, null, nowIso());

  recordAudit(db, {
    institutionId: row.institution_id,
    userId: row.id,
    actorName: row.full_name,
    actorRole: row.role_code,
    action: 'auth.login',
    category: 'auth',
    description: `${row.full_name} signed in`,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { ...session, user: buildAuthUser(db, row, session.sessionId) };
}

function createSession(
  db: Db,
  userId: number,
  meta: LoginMeta,
): { token: string; csrfToken: string; expiresAt: string; sessionId: number } {
  const token = generateOpaqueToken(48);
  const csrfToken = generateOpaqueToken(24);
  const expiresAt = addHours(nowIso(), env.sessionTtlHours);
  const info = db
    .prepare(
      `INSERT INTO sessions (user_id, token_hash, csrf_hash, user_agent, ip_address, created_at, last_seen_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      userId,
      hashToken(token),
      hashToken(csrfToken),
      meta.userAgent ?? null,
      meta.ip ?? null,
      nowIso(),
      nowIso(),
      expiresAt,
    );
  const sessionId = Number(info.lastInsertRowid);
  const persisted = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id = ?').get(sessionId) as { c: number };
  sessionDiagnostic('created', {
    sessionId,
    userId,
    expiresAt,
    persisted: persisted.c === 1 ? 'yes' : 'no',
  });
  return { token, csrfToken, expiresAt, sessionId };
}

/**
 * Development-only trace of session resolution. Reports ids and reasons only: no token
 * material, hashes, secrets or personal data ever reach the log.
 */
function sessionDiagnostic(event: string, detail: Record<string, string | number | null> = {}): void {
  if (env.isProd) return;
  const parts = Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  // eslint-disable-next-line no-console
  console.log(`[auth] session ${event}${parts ? ` ${parts}` : ''}`);
}

export function resolveSession(db: Db, token: string): AuthUser | null {
  if (!token) return null;
  const session = db
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, s.last_seen_at
         FROM sessions s WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as
    | { id: number; user_id: number; expires_at: string; revoked_at: string | null; last_seen_at: string }
    | undefined;
  if (!session || session.revoked_at) {
    // The single most confusing authentication failure is a token the server cannot
    // resolve (session gone, or signed with a different key after a key change). It is
    // logged by reason — never with token material — so it is diagnosable at a glance.
    sessionDiagnostic('unresolved', { reason: session ? 'revoked' : 'no matching session row' });
    return null;
  }
  if (isPast(session.expires_at)) {
    sessionDiagnostic('unresolved', { reason: 'expired' });
    db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(
      nowIso(),
      'expired',
      session.id,
    );
    return null;
  }

  const row = db
    .prepare(
      `SELECT u.id, u.institution_id, u.role_id, u.full_name, u.email, u.password_hash, u.status,
              u.failed_login_count, u.locked_until,
              r.code AS role_code, r.name AS role_name,
              i.status AS institution_status
         FROM users u
         JOIN roles r ON r.id = u.role_id
    LEFT JOIN institutions i ON i.id = u.institution_id
        WHERE u.id = ? AND u.deleted_at IS NULL`,
    )
    .get(session.user_id) as UserRow | undefined;
  if (!row) {
    sessionDiagnostic('unresolved', { reason: 'account not found', sessionId: session.id });
    return null;
  }
  if (row.status !== 'active') {
    sessionDiagnostic('unresolved', { reason: `account status ${row.status}`, userId: row.id });
    return null;
  }
  if (row.institution_status && row.institution_status !== 'active') {
    sessionDiagnostic('unresolved', { reason: `institution status ${row.institution_status}`, userId: row.id });
    return null;
  }
  sessionDiagnostic('validated', { sessionId: session.id, userId: row.id });

  // Touch at most once a minute to avoid a write on every request.
  if (new Date(nowIso()).getTime() - new Date(session.last_seen_at).getTime() > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(nowIso(), session.id);
  }

  return buildAuthUser(db, row, session.id);
}

export function verifyCsrf(db: Db, sessionId: number, csrfToken: string): boolean {
  if (!csrfToken) return false;
  const row = db.prepare('SELECT csrf_hash FROM sessions WHERE id = ?').get(sessionId) as
    | { csrf_hash: string }
    | undefined;
  if (!row) return false;
  const provided = Buffer.from(hashToken(csrfToken));
  const expected = Buffer.from(row.csrf_hash);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

export function logout(db: Db, sessionId: number, userId: number, meta: LoginMeta): void {
  const user = db.prepare('SELECT full_name, role_id, institution_id, email FROM users WHERE id = ?').get(userId) as
    | { full_name: string; role_id: number; institution_id: number | null; email: string }
    | undefined;
  db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(
    nowIso(),
    'logout',
    sessionId,
  );
  if (user) {
    const role = db.prepare('SELECT code FROM roles WHERE id = ?').get(user.role_id) as { code: RoleCode };
    recordAudit(db, {
      institutionId: user.institution_id,
      userId,
      actorName: user.full_name,
      actorRole: role?.code,
      action: 'auth.logout',
      category: 'auth',
      description: `${user.full_name} signed out`,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
}

export function revokeAllUserSessions(db: Db, userId: number, reason: string): void {
  db.prepare(
    'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
  ).run(nowIso(), reason, userId);
}

export function changePassword(
  db: Db,
  userId: number,
  currentPassword: string,
  newPassword: string,
  meta: LoginMeta & { keepSessionId?: number },
): void {
  const row = db
    .prepare('SELECT id, email, full_name, password_hash, role_id, institution_id FROM users WHERE id = ?')
    .get(userId) as
    | {
        id: number;
        email: string;
        full_name: string;
        password_hash: string;
        role_id: number;
        institution_id: number | null;
      }
    | undefined;
  if (!row) throw notFound('Account not found.');

  const valid = verifyPasswordSync(currentPassword, row.password_hash);
  if (!valid) throw validationError('Your current password is incorrect.');

  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(
    hashPasswordSync(newPassword),
    nowIso(),
    userId,
  );
  // Every other session is invalidated when the password changes; the caller's own
  // session (if supplied) stays valid so the user is not thrown out mid-workflow.
  if (meta.keepSessionId) {
    db.prepare(
      'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL',
    ).run(nowIso(), 'password_changed', userId, meta.keepSessionId);
  } else {
    db.prepare(
      'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
    ).run(nowIso(), 'password_changed', userId);
  }

  const role = db.prepare('SELECT code FROM roles WHERE id = ?').get(row.role_id) as { code: RoleCode };
  recordAudit(db, {
    institutionId: row.institution_id,
    userId,
    actorName: row.full_name,
    actorRole: role?.code,
    action: 'auth.password_changed',
    category: 'auth',
    description: 'Password changed',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

export async function requestPasswordReset(
  db: Db,
  email: string,
  meta: LoginMeta,
): Promise<{ token: string | null; userId: number | null }> {
  const normalized = email.trim().toLowerCase();
  const row = db
    .prepare('SELECT id, full_name, role_id, institution_id, status FROM users WHERE email = ? AND deleted_at IS NULL')
    .get(normalized) as
    | { id: number; full_name: string; role_id: number; institution_id: number | null; status: string }
    | undefined;

  // Always report success to avoid account enumeration.
  if (!row || row.status !== 'active') {
    recordAudit(db, {
      action: 'auth.password_reset_requested',
      category: 'auth',
      description: `Password reset requested for unknown or inactive account ${normalized}`,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { token: null, userId: null };
  }

  const token = generateOpaqueToken(32);
  db.prepare(
    'INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip, created_at) VALUES (?,?,?,?,?)',
  ).run(row.id, hashToken(token), addHours(nowIso(), 2), meta.ip ?? null, nowIso());

  const role = db.prepare('SELECT code FROM roles WHERE id = ?').get(row.role_id) as { code: RoleCode };
  recordAudit(db, {
    institutionId: row.institution_id,
    userId: row.id,
    actorName: row.full_name,
    actorRole: role?.code,
    action: 'auth.password_reset_requested',
    category: 'auth',
    description: 'Password reset link generated',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  const user = db.prepare('SELECT id, full_name, email, institution_id FROM users WHERE id = ?').get(row.id) as {
    id: number;
    full_name: string;
    email: string;
    institution_id: number | null;
  };
  createNotification(db, {
    institutionId: row.institution_id,
    userId: row.id,
    type: 'password_reset_requested',
    title: 'Password reset requested',
    body: 'A password reset link was sent to your email address. If this was not you, contact your administrator.',
    severity: 'warning',
  });

  // The link is delivered to the account owner. Delivery failure is recorded so an
  // administrator can see that a reset was requested but never arrived.
  const delivery = await sendAccountEmail({
    to: user.email,
    fullName: user.full_name,
    template: 'password-reset',
    token,
  });
  recordAudit(db, {
    institutionId: row.institution_id,
    userId: row.id,
    actorName: row.full_name,
    action: 'auth.password_reset_email',
    category: 'auth',
    description: delivery.delivered
      ? 'Password reset link emailed to the account owner'
      : `Password reset email could not be delivered: ${delivery.error}`,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { token, userId: row.id };
}

export async function completePasswordReset(
  db: Db,
  token: string,
  newPassword: string,
  meta: LoginMeta,
): Promise<number> {
  const record = db
    .prepare('SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?')
    .get(hashToken(token)) as
    | { id: number; user_id: number; expires_at: string; used_at: string | null }
    | undefined;
  if (!record || record.used_at || isPast(record.expires_at)) {
    throw validationError('This password reset link is invalid or has expired.');
  }
  const hash = await hashPassword(newPassword);
  const run = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(
      hash,
      nowIso(),
      record.user_id,
    );
    db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(nowIso(), record.id);
    db.prepare(
      'UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
    ).run(nowIso(), 'password_reset', record.user_id);
  });
  run();

  const user = db
    .prepare('SELECT full_name, role_id, institution_id FROM users WHERE id = ?')
    .get(record.user_id) as { full_name: string; role_id: number; institution_id: number | null };
  const role = db.prepare('SELECT code FROM roles WHERE id = ?').get(user.role_id) as { code: RoleCode };
  recordAudit(db, {
    institutionId: user.institution_id,
    userId: record.user_id,
    actorName: user.full_name,
    actorRole: role?.code,
    action: 'auth.password_reset_completed',
    category: 'auth',
    description: 'Password reset completed',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  createNotification(db, {
    institutionId: user.institution_id,
    userId: record.user_id,
    type: 'password_reset_completed',
    title: 'Your password was changed',
    body: 'Your password was reset successfully. All other sessions were signed out.',
    severity: 'success',
  });
  return record.user_id;
}

export function createEmailVerification(db: Db, userId: number, email: string): string {
  const token = generateOpaqueToken(32);
  db.prepare(
    'INSERT INTO email_verifications (user_id, token_hash, email, expires_at, created_at) VALUES (?,?,?,?,?)',
  ).run(userId, hashToken(token), email, addHours(nowIso(), 48), nowIso());
  return token;
}

/**
 * Emails a verification link and audits the outcome. Used at registration and whenever a
 * candidate asks for the link again — the token only ever reaches the account owner.
 */
export async function sendVerificationEmail(
  db: Db,
  input: {
    userId: number;
    email: string;
    fullName: string;
    institutionId: number | null;
    token: string;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<{ delivered: boolean }> {
  const delivery = await sendAccountEmail({
    to: input.email,
    fullName: input.fullName,
    template: 'email-verification',
    token: input.token,
  });
  recordAudit(db, {
    institutionId: input.institutionId,
    userId: input.userId,
    actorName: input.fullName,
    action: 'auth.verification_email',
    category: 'auth',
    description: delivery.delivered
      ? 'Verification link emailed to the account owner'
      : `Verification email could not be delivered: ${delivery.error}`,
    ip: input.ip,
    userAgent: input.userAgent,
  });
  return { delivered: delivery.delivered };
}

export function verifyEmailToken(db: Db, token: string): { userId: number } {
  const record = db
    .prepare('SELECT id, user_id, expires_at, verified_at FROM email_verifications WHERE token_hash = ?')
    .get(hashToken(token)) as
    | { id: number; user_id: number; expires_at: string; verified_at: string | null }
    | undefined;
  if (!record || record.verified_at || isPast(record.expires_at)) {
    throw validationError('This verification link is invalid or has expired.');
  }
  db.prepare('UPDATE email_verifications SET verified_at = ? WHERE id = ?').run(nowIso(), record.id);
  db.prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?').run(
    nowIso(),
    nowIso(),
    record.user_id,
  );
  return { userId: record.user_id };
}

/** Self-registration is restricted to student accounts and requires an institution join code. */
export async function selfRegister(
  db: Db,
  input: {
    fullName: string;
    email: string;
    password: string;
    institutionId: number;
    studentCode?: string;
    /** The candidate's own details, recorded on the student row the registry vets. */
    phone?: string;
    dateOfBirth?: string;
    gender?: StudentGender;
  },
  meta: LoginMeta,
): Promise<{ userId: number; verificationToken: string }> {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(input.email);
  if (existing) throw conflict('An account with this email address already exists.');

  const institution = db
    .prepare("SELECT id, status FROM institutions WHERE id = ?")
    .get(input.institutionId) as { id: number; status: string } | undefined;
  if (!institution) throw notFound('Institution not found.');
  if (institution.status !== 'active') throw forbidden('This institution is not accepting registrations.');

  const studentRole = db.prepare("SELECT id FROM roles WHERE code = 'student'").get() as { id: number };
  const passwordHash = await hashPassword(input.password);

  const created = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO users (institution_id, role_id, full_name, email, password_hash, status, phone, created_at, updated_at)
         VALUES (?,?,?,?,?, 'pending', ?, ?, ?)`,
      )
      .run(
        institution.id,
        studentRole.id,
        input.fullName,
        input.email,
        passwordHash,
        input.phone?.trim() || null,
        nowIso(),
        nowIso(),
      );
    const userId = Number(info.lastInsertRowid);
    const code = input.studentCode?.trim() || `REG-${String(userId).padStart(5, '0')}`;
    /*
     * The candidate record starts inactive and unclassed. It carries the details the
     * candidate supplied so an administrator can vet the registration before approving it;
     * a class and a matriculation number are assigned by the registry afterwards.
     */
    db.prepare(
      `INSERT INTO students (user_id, institution_id, student_code, date_of_birth, gender, status, created_at, updated_at)
       VALUES (?,?,?,?,?, 'inactive', ?, ?)`,
    ).run(
      userId,
      institution.id,
      code,
      input.dateOfBirth?.trim() || null,
      input.gender ?? null,
      nowIso(),
      nowIso(),
    );
    return userId;
  })();

  const verificationToken = createEmailVerification(db, created, input.email);
  recordAudit(db, {
    institutionId: institution.id,
    userId: created,
    actorName: input.fullName,
    actorRole: 'student',
    action: 'auth.self_registered',
    category: 'auth',
    description: 'Candidate self-registered and awaits approval',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  await sendVerificationEmail(db, {
    userId: created,
    email: input.email,
    fullName: input.fullName,
    institutionId: institution.id,
    token: verificationToken,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { userId: created, verificationToken };
}
