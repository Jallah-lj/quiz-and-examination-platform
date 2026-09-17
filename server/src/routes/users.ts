import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, created, ok, okList, orderByClause } from '../lib/http';
import { conflict, forbidden, notFound, validationError } from '../lib/errors';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import { createUser, requireInstitution, resetUserPassword, setUserStatus, updatePerson } from '../services/people';
import { PERMISSIONS, ROLE_DEFINITIONS } from '../lib/rbac';
import { nowIso } from '../lib/time';
import { unknownPermissionCodes } from '../services/permissions';
import { recordAudit } from '../services/audit';

const router = Router();
router.use(requireAuth);

const roleCodeSchema = z.enum(['super_admin', 'institution_admin', 'teacher', 'student']);

router.get(
  '/',
  requirePermission('user.view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const filters = parseWith(
      z.object({
        role: roleCodeSchema.optional(),
        status: z.string().trim().max(20).optional(),
        institutionId: z.coerce.number().int().positive().optional(),
      }),
      req.query,
    );
    const db = getDb();
    const where: string[] = ['u.deleted_at IS NULL'];
    const params: unknown[] = [];

    if (req.user!.roleCode !== 'super_admin') {
      where.push('u.institution_id = ?');
      params.push(requireInstitution(req.user!));
    } else if (filters.institutionId) {
      where.push('u.institution_id = ?');
      params.push(filters.institutionId);
    }
    if (filters.role) {
      where.push('r.code = ?');
      params.push(filters.role);
    }
    if (filters.status) {
      where.push('u.status = ?');
      params.push(filters.status);
    }
    if (query.q) {
      where.push('(u.full_name LIKE ? OR u.email LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const total = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id ${whereSql}`)
        .get(...params) as { c: number }
    ).c;

    const items = db
      .prepare(
        `SELECT u.id, u.full_name, u.email, u.status, u.phone, u.last_login_at, u.created_at,
                u.institution_id, u.email_verified_at, r.code AS role, r.name AS role_name,
                i.name AS institution_name,
                CASE WHEN u.locked_until IS NOT NULL AND u.locked_until > ? THEN 1 ELSE 0 END AS locked
           FROM users u JOIN roles r ON r.id = u.role_id
           LEFT JOIN institutions i ON i.id = u.institution_id
           ${whereSql}
           ${orderByClause(query.sort, query.order, { name: 'u.full_name', created: 'u.created_at', role: 'r.name' }, 'u.created_at DESC')}
           LIMIT ? OFFSET ?`,
      )
      .all(nowIso(), ...params, query.pageSize, (query.page - 1) * query.pageSize);

    return okList(res, paginate(items, { page: query.page, pageSize: query.pageSize, total }));
  }),
);

router.get(
  '/roles',
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const roles = db.prepare('SELECT id, code, name, description, scope FROM roles ORDER BY id').all() as any[];
    const permissionCounts = db
      .prepare('SELECT role_id, COUNT(*) AS c FROM role_permissions GROUP BY role_id')
      .all() as { role_id: number; c: number }[];
    const countMap = new Map(permissionCounts.map((row) => [row.role_id, row.c]));
    void req;
    return ok(
      res,
      roles.map((role) => ({
        ...role,
        permissionCount: countMap.get(role.id) ?? 0,
        definition: ROLE_DEFINITIONS[role.code as keyof typeof ROLE_DEFINITIONS] ?? null,
      })),
    );
  }),
);

router.get(
  '/permissions',
  requirePermission('role.manage'),
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT id, code, name, category, description FROM permissions ORDER BY category, code').all() as any[];
    const grouped = rows.reduce<Record<string, any[]>>((acc, row) => {
      acc[row.category] = acc[row.category] ?? [];
      acc[row.category].push(row);
      return acc;
    }, {});
    return ok(res, { permissions: rows, grouped, catalog: PERMISSIONS });
  }),
);

router.get(
  '/roles/:roleId/permissions',
  requirePermission('role.manage'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const roleId = Number(req.params.roleId);
    const role = db.prepare('SELECT id, code, name FROM roles WHERE id = ?').get(roleId) as any;
    if (!role) throw notFound('Role not found.');
    const granted = db
      .prepare(
        `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
      )
      .all(roleId) as { code: string }[];
    return ok(res, { role, permissions: granted.map((g) => g.code) });
  }),
);

/**
 * Role permissions are editable for custom roles only. The four system roles keep their
 * built-in mapping so that a misconfiguration cannot lock the platform out of itself.
 */
router.put(
  '/roles/:roleId/permissions',
  requirePermission('role.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const roleId = Number(req.params.roleId);
    const body = parseWith(z.object({ permissions: z.array(z.string()).max(200) }), req.body);
    const db = getDb();
    const role = db.prepare('SELECT id, code, name, is_system FROM roles WHERE id = ?').get(roleId) as any;
    if (!role) throw notFound('Role not found.');
    if (role.is_system) {
      throw forbidden('System role permissions are fixed by the platform and cannot be edited.');
    }
    const unknown = unknownPermissionCodes(db, body.permissions);
    if (unknown.length) {
      throw validationError('Unknown permission code(s) supplied.', unknown.map((code) => ({ message: code })));
    }

    db.transaction(() => {
      db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId);
      const insert = db.prepare(
        'INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = ?',
      );
      for (const code of body.permissions) insert.run(roleId, code);
    })();

    recordAudit(db, {
      institutionId: req.user!.institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'role.permissions_changed',
      category: 'platform',
      resourceType: 'role',
      resourceId: roleId,
      description: `Updated permissions for role ${role.name}`,
      metadata: { permissions: body.permissions },
      ip: req.ip ?? null,
    });

    return ok(res, { message: 'Role permissions updated.', permissions: body.permissions });
  }),
);

const createUserSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().toLowerCase().email(),
  role: roleCodeSchema,
  password: z.string().min(10).max(200).optional(),
  phone: z.string().trim().max(40).optional().nullable(),
  status: z.enum(['active', 'pending']).optional(),
  institutionId: z.coerce.number().int().positive().optional(),
  studentCode: z.string().trim().max(40).optional(),
  classId: z.coerce.number().int().positive().optional().nullable(),
  guardianName: z.string().trim().max(160).optional().nullable(),
  guardianPhone: z.string().trim().max(40).optional().nullable(),
  dateOfBirth: z.string().trim().max(30).optional().nullable(),
  gender: z.string().trim().max(20).optional().nullable(),
  staffCode: z.string().trim().max(40).optional(),
  departmentId: z.coerce.number().int().positive().optional().nullable(),
  designation: z.string().trim().max(120).optional().nullable(),
  specialization: z.string().trim().max(160).optional().nullable(),
});

router.post(
  '/',
  requirePermission('user.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(createUserSchema, req.body);
    const db = getDb();
    if (req.user!.roleCode === 'institution_admin' && body.role === 'super_admin') {
      throw forbidden('Institution administrators cannot create platform administrators.');
    }
    if (req.user!.roleCode === 'institution_admin' && body.role === 'institution_admin') {
      const existing = db
        .prepare(
          `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.institution_id = ? AND r.code = 'institution_admin'`,
        )
        .get(requireInstitution(req.user!)) as { c: number };
      if (existing.c >= 5) {
        throw conflict('This institution already has the maximum number of administrators allowed.');
      }
    }

    const result = await createUser(db, req.user!, {
      fullName: body.fullName,
      email: body.email,
      roleCode: body.role,
      institutionId: body.institutionId ?? req.user!.institutionId,
      password: body.password,
      phone: body.phone ?? null,
      status: body.status,
      studentCode: body.studentCode,
      classId: body.classId ?? null,
      guardianName: body.guardianName ?? null,
      guardianPhone: body.guardianPhone ?? null,
      dateOfBirth: body.dateOfBirth ?? null,
      gender: body.gender ?? null,
      staffCode: body.staffCode,
      departmentId: body.departmentId ?? null,
      designation: body.designation ?? null,
      specialization: body.specialization ?? null,
    }, { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null });

    return created(res, result);
  }),
);

router.get(
  '/:id',
  requirePermission('user.view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const user = db
      .prepare(
        `SELECT u.id, u.full_name, u.email, u.status, u.phone, u.avatar_url, u.last_login_at, u.created_at,
                u.institution_id, u.email_verified_at, u.must_change_password, r.code AS role, r.name AS role_name,
                i.name AS institution_name
           FROM users u JOIN roles r ON r.id = u.role_id
           LEFT JOIN institutions i ON i.id = u.institution_id
          WHERE u.id = ? AND u.deleted_at IS NULL`,
      )
      .get(id) as any;
    if (!user) throw notFound('User not found.');
    if (req.user!.roleCode !== 'super_admin' && user.institution_id !== req.user!.institutionId) {
      throw notFound('User not found.');
    }
    const profile =
      user.role === 'student'
        ? db.prepare('SELECT * FROM students WHERE user_id = ?').get(id)
        : user.role === 'teacher'
          ? db.prepare('SELECT * FROM teachers WHERE user_id = ?').get(id)
          : null;
    const recentAudit = db
      .prepare(
        `SELECT action, description, created_at, ip_address FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 15`,
      )
      .all(id);
    return ok(res, { user, profile, recentActivity: recentAudit });
  }),
);

router.patch(
  '/:id',
  requirePermission('user.update'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const body = parseWith(
      z
        .object({
          fullName: z.string().trim().min(2).max(160).optional(),
          email: z.string().trim().toLowerCase().email().optional(),
          phone: z.string().trim().max(40).optional().nullable(),
          classId: z.coerce.number().int().positive().nullable().optional(),
          studentCode: z.string().trim().max(40).optional(),
          status: z.enum(['active', 'inactive', 'graduated', 'suspended']).optional(),
          guardianName: z.string().trim().max(160).optional().nullable(),
          guardianPhone: z.string().trim().max(40).optional().nullable(),
          dateOfBirth: z.string().trim().max(30).optional().nullable(),
          gender: z.string().trim().max(20).optional().nullable(),
          staffCode: z.string().trim().max(40).optional(),
          departmentId: z.coerce.number().int().positive().nullable().optional(),
          designation: z.string().trim().max(120).optional().nullable(),
          specialization: z.string().trim().max(160).optional().nullable(),
        })
        .strict(),
      req.body,
    );
    await updatePerson(db, req.user!, id, body, { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null });
    const updated = db
      .prepare(
        `SELECT u.id, u.full_name, u.email, u.status, u.institution_id, r.code AS role FROM users u
           JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      )
      .get(id);
    return ok(res, updated);
  }),
);

router.post(
  '/:id/status',
  requirePermission('user.status'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(z.object({ status: z.enum(['active', 'suspended', 'disabled', 'pending']) }), req.body);
    const db = getDb();
    setUserStatus(db, req.user!, Number(req.params.id), body.status, {
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return ok(res, { message: `Account status updated to ${body.status}.` });
  }),
);

router.post(
  '/:id/reset-password',
  requirePermission('user.reset_password'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({ password: z.string().min(10).max(200).optional() }),
      req.body ?? {},
    );
    const db = getDb();
    const result = await resetUserPassword(db, req.user!, Number(req.params.id), body.password, {
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return ok(res, {
      message: result.temporaryPassword
        ? 'A temporary password has been generated. Share it securely; the user must change it at first sign-in.'
        : 'Password updated.',
      temporaryPassword: result.temporaryPassword,
    });
  }),
);

router.post(
  '/:id/revoke-sessions',
  requirePermission('user.status'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const target = db.prepare('SELECT id, institution_id, role_id, full_name FROM users WHERE id = ?').get(id) as any;
    if (!target) throw notFound('User not found.');
    if (req.user!.roleCode !== 'super_admin' && target.institution_id !== req.user!.institutionId) {
      throw notFound('User not found.');
    }
    const info = db
      .prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(nowIso(), 'revoked_by_admin', id);
    recordAudit(db, {
      institutionId: target.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'user.sessions_revoked',
      category: 'user',
      resourceType: 'user',
      resourceId: id,
      description: `Revoked ${info.changes} session(s) for ${target.full_name}`,
      ip: req.ip ?? null,
    });
    return ok(res, { message: `${info.changes} session(s) revoked.` });
  }),
);

export default router;
