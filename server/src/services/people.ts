/**
 * User provisioning: administrators, teachers and candidates.
 * Every write is institution-scoped and recorded in the audit log.
 */
import crypto from 'node:crypto';
import type { Db } from '../db';
import { env } from '../config/env';
import { hashPassword, validatePasswordStrength } from '../lib/crypto';
import { conflict, forbidden, notFound, validationError } from '../lib/errors';
import { nowIso } from '../lib/time';
import type { RoleCode } from '../types';
import { recordAudit } from './audit';
import { createNotification } from './notifications';

export interface PeopleActor {
  id: number;
  institutionId: number | null;
  roleCode: RoleCode;
  fullName: string;
}

export function requireInstitution(actor: PeopleActor): number {
  if (!actor.institutionId) {
    throw forbidden('This operation must be performed within an institution.');
  }
  return actor.institutionId;
}

export function generateTemporaryPassword(): string {
  // Human-transcribable but high entropy (no ambiguous characters).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 6)}-${out.slice(6, 10)}-${out.slice(10)}1`;
}

export async function createUser(
  db: Db,
  actor: PeopleActor,
  input: {
    fullName: string;
    email: string;
    roleCode: RoleCode;
    institutionId?: number | null;
    password?: string;
    phone?: string | null;
    status?: string;
    studentCode?: string;
    classId?: number | null;
    guardianName?: string | null;
    guardianPhone?: string | null;
    dateOfBirth?: string | null;
    gender?: string | null;
    staffCode?: string;
    departmentId?: number | null;
    designation?: string | null;
    specialization?: string | null;
    sendWelcomeNotification?: boolean;
  },
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ user: any; temporaryPassword: string | null }> {
  const institutionId = input.institutionId ?? actor.institutionId;
  if (input.roleCode === 'super_admin') {
    if (actor.roleCode !== 'super_admin') throw forbidden('Only platform administrators can create super administrators.');
  } else if (!institutionId) {
    throw forbidden('An institution is required for this account.');
  }
  if (actor.roleCode !== 'super_admin' && institutionId !== actor.institutionId) {
    throw forbidden('You cannot create accounts in another institution.');
  }

  const email = input.email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw conflict('An account with this email address already exists.');

  const role = db.prepare('SELECT id, code FROM roles WHERE code = ?').get(input.roleCode) as
    | { id: number; code: RoleCode }
    | undefined;
  if (!role) throw validationError('Unknown role.');

  if (institutionId) {
    const institution = db
      .prepare('SELECT id, name, status FROM institutions WHERE id = ?')
      .get(institutionId) as { id: number; name: string; status: string } | undefined;
    if (!institution) throw notFound('Institution not found.');
    if (institution.status !== 'active') throw conflict('This institution is not active.');
  }

  if (input.classId) {
    const klass = db
      .prepare('SELECT id FROM classes WHERE id = ? AND institution_id = ?')
      .get(input.classId, institutionId);
    if (!klass) throw validationError('The selected class does not belong to this institution.');
  }
  if (input.departmentId) {
    const department = db
      .prepare('SELECT id FROM departments WHERE id = ? AND institution_id = ?')
      .get(input.departmentId, institutionId);
    if (!department) throw validationError('The selected department does not belong to this institution.');
  }

  const temporaryPassword = input.password ? null : generateTemporaryPassword();
  const plainPassword = input.password ?? temporaryPassword!;
  const problems = validatePasswordStrength(plainPassword);
  if (input.password && problems.length) {
    throw validationError('The password does not meet the platform policy.', problems.map((message) => ({ message })));
  }

  const passwordHash = await hashPassword(plainPassword);
  const timestamp = nowIso();
  const status = input.status ?? 'active';

  const userId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO users
          (institution_id, role_id, full_name, email, password_hash, status, phone, must_change_password,
           email_verified_at, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        institutionId ?? null,
        role.id,
        input.fullName.trim(),
        email,
        passwordHash,
        status,
        input.phone?.trim() || null,
        temporaryPassword ? 1 : 0,
        institutionId ? timestamp : null,
        actor.id,
        timestamp,
        timestamp,
      );
    const newUserId = Number(info.lastInsertRowid);

    if (input.roleCode === 'student') {
      const code =
        input.studentCode?.trim() ||
        `STU-${String(newUserId).padStart(5, '0')}`;
      db.prepare(
        `INSERT INTO students
          (user_id, institution_id, class_id, student_code, date_of_birth, gender, guardian_name, guardian_phone,
           admission_date, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'active', ?, ?)`,
      ).run(
        newUserId,
        institutionId!,
        input.classId ?? null,
        code,
        input.dateOfBirth ?? null,
        input.gender ?? null,
        input.guardianName ?? null,
        input.guardianPhone ?? null,
        timestamp.slice(0, 10),
        timestamp,
        timestamp,
      );
    }

    if (input.roleCode === 'teacher') {
      const code = input.staffCode?.trim() || `TCH-${String(newUserId).padStart(5, '0')}`;
      db.prepare(
        `INSERT INTO teachers
          (user_id, institution_id, department_id, staff_code, designation, specialization, joined_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'active', ?, ?)`,
      ).run(
        newUserId,
        institutionId!,
        input.departmentId ?? null,
        code,
        input.designation ?? null,
        input.specialization ?? null,
        timestamp.slice(0, 10),
        timestamp,
        timestamp,
      );
    }

    return newUserId;
  })();

  recordAudit(db, {
    institutionId: institutionId ?? null,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'user.created',
    category: 'user',
    resourceType: 'user',
    resourceId: userId,
    description: `Created ${input.roleCode} account for ${input.fullName} (${email})`,
    metadata: { roleCode: input.roleCode, temporaryPassword: Boolean(temporaryPassword) },
    ...meta,
  });

  if (input.sendWelcomeNotification !== false) {
    createNotification(db, {
      institutionId: institutionId ?? null,
      userId,
      type: 'account_created',
      title: 'Welcome to ExamSys',
      body: `Your ${input.roleCode.replace('_', ' ')} account has been created. Use "Forgot password" to set your own password.`,
      severity: 'info',
    });
  }

  const user = db
    .prepare(
      `SELECT u.id, u.full_name, u.email, u.status, u.institution_id, u.created_at,
              r.code AS role_code, s.id AS student_id, s.student_code, t.id AS teacher_id, t.staff_code
         FROM users u JOIN roles r ON r.id = u.role_id
         LEFT JOIN students s ON s.user_id = u.id
         LEFT JOIN teachers t ON t.user_id = u.id
        WHERE u.id = ?`,
    )
    .get(userId);

  return { user, temporaryPassword };
}

export function listStudents(
  db: Db,
  actor: PeopleActor,
  filters: { search?: string; classId?: number; departmentId?: number; status?: string },
  pagination: { page: number; pageSize: number },
): { items: any[]; total: number } {
  const where: string[] = ['u.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (actor.roleCode !== 'super_admin') {
    where.push('s.institution_id = ?');
    params.push(requireInstitution(actor));
  }
  if (filters.classId) {
    where.push('s.class_id = ?');
    params.push(filters.classId);
  }
  if (filters.departmentId) {
    where.push('c.department_id = ?');
    params.push(filters.departmentId);
  }
  if (filters.status) {
    where.push('s.status = ?');
    params.push(filters.status);
  }
  if (filters.search) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ? OR s.student_code LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const base = `FROM students s JOIN users u ON u.id = s.user_id
                LEFT JOIN classes c ON c.id = s.class_id
                LEFT JOIN departments d ON d.id = c.department_id`;

  const total = (db.prepare(`SELECT COUNT(*) AS c ${base} ${whereSql}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(
      `SELECT s.id, s.student_code, s.status, s.class_id, s.date_of_birth, s.gender, s.guardian_name,
              s.guardian_phone, s.admission_date, u.id AS user_id, u.full_name, u.email, u.phone,
              u.status AS account_status, u.last_login_at, c.name AS class_name, c.code AS class_code,
              d.name AS department_name,
              (SELECT COUNT(*) FROM attempts a WHERE a.student_id = s.id) AS attempt_count,
              (SELECT COUNT(*) FROM results r WHERE r.student_id = s.id AND r.is_published = 1) AS published_results
       ${base} ${whereSql}
       ORDER BY u.full_name ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as any[];

  return { items, total };
}

export function listTeachers(
  db: Db,
  actor: PeopleActor,
  filters: { search?: string; departmentId?: number; status?: string },
  pagination: { page: number; pageSize: number },
): { items: any[]; total: number } {
  const where: string[] = ['u.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (actor.roleCode !== 'super_admin') {
    where.push('t.institution_id = ?');
    params.push(requireInstitution(actor));
  }
  if (filters.departmentId) {
    where.push('t.department_id = ?');
    params.push(filters.departmentId);
  }
  if (filters.status) {
    where.push('t.status = ?');
    params.push(filters.status);
  }
  if (filters.search) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ? OR t.staff_code LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const base = `FROM teachers t JOIN users u ON u.id = t.user_id
                LEFT JOIN departments d ON d.id = t.department_id`;

  const total = (db.prepare(`SELECT COUNT(*) AS c ${base} ${whereSql}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(
      `SELECT t.id, t.staff_code, t.designation, t.specialization, t.status, t.department_id, t.joined_at,
              u.id AS user_id, u.full_name, u.email, u.phone, u.status AS account_status, u.last_login_at,
              d.name AS department_name,
              (SELECT COUNT(*) FROM questions q WHERE q.created_by = u.id) AS questions_authored,
              (SELECT COUNT(*) FROM exams e WHERE e.created_by = u.id) AS exams_authored,
              (SELECT GROUP_CONCAT(sub.name, ', ') FROM teacher_subjects ts
                 JOIN subjects sub ON sub.id = ts.subject_id WHERE ts.teacher_id = t.id) AS subjects
       ${base} ${whereSql}
       ORDER BY u.full_name ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as any[];

  return { items, total };
}

export async function updatePerson(
  db: Db,
  actor: PeopleActor,
  targetUserId: number,
  input: Record<string, unknown>,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<void> {
  const target = db
    .prepare(
      `SELECT u.id, u.institution_id, u.full_name, u.email, r.code AS role_code,
              s.id AS student_id, s.class_id, t.id AS teacher_id, t.department_id
         FROM users u JOIN roles r ON r.id = u.role_id
         LEFT JOIN students s ON s.user_id = u.id
         LEFT JOIN teachers t ON t.user_id = u.id
        WHERE u.id = ? AND u.deleted_at IS NULL`,
    )
    .get(targetUserId) as any;
  if (!target) throw notFound('User not found.');

  if (actor.roleCode !== 'super_admin') {
    if (target.institution_id !== actor.institutionId) {
      throw forbidden('You cannot modify users from another institution.');
    }
    if (target.role_code === 'super_admin') {
      throw forbidden('Institution administrators cannot modify platform administrators.');
    }
  }

  const userFields: Record<string, unknown> = {};
  if (typeof input.fullName === 'string') userFields.full_name = input.fullName.trim();
  if (typeof input.phone === 'string' || input.phone === null) userFields.phone = input.phone ?? null;
  if (typeof input.email === 'string') {
    const email = input.email.trim().toLowerCase();
    if (email !== target.email) {
      const duplicate = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, targetUserId);
      if (duplicate) throw conflict('Another account already uses this email address.');
      userFields.email = email;
    }
  }

  db.transaction(() => {
    if (Object.keys(userFields).length) {
      const clause = Object.keys(userFields).map((key) => `${key} = ?`).join(', ');
      db.prepare(`UPDATE users SET ${clause}, updated_at = ? WHERE id = ?`).run(
        ...Object.values(userFields),
        nowIso(),
        targetUserId,
      );
    }

    if (target.student_id) {
      const studentFields: Record<string, unknown> = {};
      if (input.classId !== undefined) {
        if (input.classId !== null) {
          const klass = db
            .prepare('SELECT id FROM classes WHERE id = ? AND institution_id = ?')
            .get(input.classId, target.institution_id);
          if (!klass) throw validationError('The selected class does not belong to this institution.');
        }
        studentFields.class_id = input.classId;
      }
      if (typeof input.studentCode === 'string') studentFields.student_code = input.studentCode.trim();
      if (typeof input.guardianName === 'string' || input.guardianName === null) {
        studentFields.guardian_name = input.guardianName ?? null;
      }
      if (typeof input.guardianPhone === 'string' || input.guardianPhone === null) {
        studentFields.guardian_phone = input.guardianPhone ?? null;
      }
      if (typeof input.dateOfBirth === 'string' || input.dateOfBirth === null) {
        studentFields.date_of_birth = input.dateOfBirth ?? null;
      }
      if (typeof input.gender === 'string' || input.gender === null) studentFields.gender = input.gender ?? null;
      if (typeof input.status === 'string') studentFields.status = input.status;
      if (Object.keys(studentFields).length) {
        const clause = Object.keys(studentFields).map((key) => `${key} = ?`).join(', ');
        db.prepare(`UPDATE students SET ${clause}, updated_at = ? WHERE id = ?`).run(
          ...Object.values(studentFields),
          nowIso(),
          target.student_id,
        );
      }
    }

    if (target.teacher_id) {
      const teacherFields: Record<string, unknown> = {};
      if (input.departmentId !== undefined) {
        if (input.departmentId !== null) {
          const department = db
            .prepare('SELECT id FROM departments WHERE id = ? AND institution_id = ?')
            .get(input.departmentId, target.institution_id);
          if (!department) throw validationError('The selected department does not belong to this institution.');
        }
        teacherFields.department_id = input.departmentId;
      }
      if (typeof input.staffCode === 'string') teacherFields.staff_code = input.staffCode.trim();
      if (typeof input.designation === 'string' || input.designation === null) {
        teacherFields.designation = input.designation ?? null;
      }
      if (typeof input.specialization === 'string' || input.specialization === null) {
        teacherFields.specialization = input.specialization ?? null;
      }
      if (typeof input.status === 'string') teacherFields.status = input.status;
      if (Object.keys(teacherFields).length) {
        const clause = Object.keys(teacherFields).map((key) => `${key} = ?`).join(', ');
        db.prepare(`UPDATE teachers SET ${clause}, updated_at = ? WHERE id = ?`).run(
          ...Object.values(teacherFields),
          nowIso(),
          target.teacher_id,
        );
      }
    }
  })();

  recordAudit(db, {
    institutionId: target.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'user.updated',
    category: 'user',
    resourceType: 'user',
    resourceId: targetUserId,
    description: `Updated ${target.role_code} ${target.full_name}`,
    metadata: { fields: Object.keys(input) },
    ...meta,
  });
}

interface ManagedAccount {
  id: number;
  institution_id: number | null;
  status: string;
  full_name: string;
  email: string;
  role_code: RoleCode;
}

/**
 * Loads an account for an administrative write and applies the rules every such write
 * shares. An account outside the actor's institution is reported as missing rather than
 * refused, so the response never confirms that a user exists in another institution.
 */
function loadManagedAccount(db: Db, actor: PeopleActor, targetUserId: number): ManagedAccount {
  const target = db
    .prepare(
      'SELECT u.id, u.institution_id, u.status, u.full_name, u.email, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?',
    )
    .get(targetUserId) as ManagedAccount | undefined;
  if (!target) throw notFound('User not found.');
  if (actor.roleCode !== 'super_admin') {
    if (target.institution_id !== actor.institutionId) throw notFound('User not found.');
    if (target.role_code === 'super_admin') {
      throw forbidden('You cannot modify a platform administrator.');
    }
  }
  return target;
}

/** The student and teacher registry rows carry their own status, kept in step with the account. */
function mirrorRegistryStatus(
  db: Db,
  targetUserId: number,
  status: 'active' | 'suspended' | 'disabled' | 'pending',
  timestamp: string,
): void {
  const registryStatus = status === 'active' ? 'active' : status === 'pending' ? 'inactive' : 'suspended';
  db.prepare('UPDATE students SET status = ?, updated_at = ? WHERE user_id = ?').run(
    registryStatus,
    timestamp,
    targetUserId,
  );
  db.prepare('UPDATE teachers SET status = ?, updated_at = ? WHERE user_id = ?').run(
    registryStatus,
    timestamp,
    targetUserId,
  );
}

/**
 * Approves a self-registered candidate. This is the one transition that lets a `pending`
 * account sign in, so it is deliberately narrow: only an account that is actually awaiting
 * approval can be approved, and the registry row is activated in the same transaction as
 * the account. The candidate is notified, because nothing else would tell them to try again.
 */
export function approvePendingUser(
  db: Db,
  actor: PeopleActor,
  targetUserId: number,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): { id: number; fullName: string } {
  const target = loadManagedAccount(db, actor, targetUserId);
  if (target.status === 'active') {
    throw validationError('This account has already been approved.');
  }
  if (target.status !== 'pending') {
    throw validationError(
      `This account is ${target.status}; only a registration awaiting approval can be approved.`,
    );
  }

  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run('active', timestamp, targetUserId);
    mirrorRegistryStatus(db, targetUserId, 'active', timestamp);
  })();

  createNotification(db, {
    institutionId: target.institution_id,
    userId: targetUserId,
    type: 'account_approved',
    title: 'Registration approved',
    body: 'An administrator approved your registration. You can now sign in with the email address and password you registered with.',
    severity: 'success',
  });

  recordAudit(db, {
    institutionId: target.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'user.approved',
    category: 'user',
    resourceType: 'user',
    resourceId: targetUserId,
    description: `Registration for ${target.full_name} approved`,
    metadata: { from: 'pending', to: 'active' },
    ...meta,
  });

  return { id: targetUserId, fullName: target.full_name };
}

export function setUserStatus(
  db: Db,
  actor: PeopleActor,
  targetUserId: number,
  status: 'active' | 'suspended' | 'disabled' | 'pending',
  meta: { ip?: string | null; userAgent?: string | null } = {},
): void {
  const target = loadManagedAccount(db, actor, targetUserId);
  if (actor.id === targetUserId && status !== 'active') {
    throw validationError('You cannot deactivate your own account.');
  }

  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, targetUserId);
    if (status !== 'active') {
      db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL').run(
        timestamp,
        'account_status_changed',
        targetUserId,
      );
    }
    mirrorRegistryStatus(db, targetUserId, status, timestamp);
  })();

  recordAudit(db, {
    institutionId: target.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'user.status_changed',
    category: 'user',
    resourceType: 'user',
    resourceId: targetUserId,
    description: `Account status for ${target.full_name} changed from ${target.status} to ${status}`,
    metadata: { from: target.status, to: status },
    ...meta,
  });
}

export async function resetUserPassword(
  db: Db,
  actor: PeopleActor,
  targetUserId: number,
  newPassword: string | undefined,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ temporaryPassword: string | null }> {
  const target = db
    .prepare('SELECT u.id, u.institution_id, u.full_name, u.email, r.code AS role_code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?')
    .get(targetUserId) as any;
  if (!target) throw notFound('User not found.');
  if (actor.roleCode !== 'super_admin') {
    if (target.institution_id !== actor.institutionId) throw forbidden('Cross-institution operation blocked.');
    if (target.role_code === 'super_admin') {
      const admins = db
        .prepare("SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'super_admin' AND u.status = 'active'")
        .get() as { c: number };
      if (admins.c <= 1) throw forbidden('The last platform administrator password cannot be reset by another account.');
      throw forbidden('You cannot reset a platform administrator password.');
    }
  }

  const temporaryPassword = newPassword ? null : generateTemporaryPassword();
  const plain = newPassword ?? temporaryPassword!;
  if (newPassword) {
    const problems = validatePasswordStrength(newPassword);
    if (problems.length) {
      throw validationError('The password does not meet the platform policy.', problems.map((message) => ({ message })));
    }
  }

  const hash = await hashPassword(plain);
  const timestamp = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(
      hash,
      temporaryPassword ? 1 : 0,
      timestamp,
      targetUserId,
    );
    db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL').run(
      timestamp,
      'password_reset_by_admin',
      targetUserId,
    );
  })();

  createNotification(db, {
    institutionId: target.institution_id,
    userId: targetUserId,
    type: 'password_reset_by_admin',
    title: 'Your password was reset',
    body: 'An administrator reset your password. Sign in with the temporary password you were given and change it immediately.',
    severity: 'warning',
  });

  recordAudit(db, {
    institutionId: target.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'user.password_reset',
    category: 'user',
    resourceType: 'user',
    resourceId: targetUserId,
    description: `Reset password for ${target.full_name}`,
    ...meta,
  });

  return { temporaryPassword };
}

export function assertNotDemoLeak(): string {
  return env.isProd ? 'production' : 'development';
}
