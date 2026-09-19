import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { mailStatus } from '../lib/mailer';
import { asyncHandler, created, ok, okList } from '../lib/http';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import { validateBands, DEFAULT_BANDS } from '../lib/grading';
import { nowIso } from '../lib/time';
import { recordAudit } from '../services/audit';
import { env } from '../config/env';

function auditMeta(req: AuthedRequest) {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

function scope(req: AuthedRequest): number {
  if (!req.user!.institutionId) throw forbidden('This view requires an institution context.');
  return req.user!.institutionId;
}

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------
export const auditLogsRouter = Router();
auditLogsRouter.use(requireAuth, requirePermission('audit.view'));

auditLogsRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const filters = parseWith(
      z.object({
        category: z.string().trim().max(40).optional(),
        action: z.string().trim().max(80).optional(),
        userId: z.coerce.number().int().positive().optional(),
        institutionId: z.coerce.number().int().positive().optional(),
        resourceType: z.string().trim().max(40).optional(),
        from: z.string().trim().optional(),
        to: z.string().trim().optional(),
      }),
      req.query,
    );
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];

    if (req.user!.roleCode !== 'super_admin') {
      where.push('a.institution_id = ?');
      params.push(scope(req));
    } else if (filters.institutionId) {
      where.push('a.institution_id = ?');
      params.push(filters.institutionId);
    }
    if (filters.category) {
      where.push('a.category = ?');
      params.push(filters.category);
    }
    if (filters.action) {
      where.push('a.action LIKE ?');
      params.push(`${filters.action}%`);
    }
    if (filters.userId) {
      where.push('a.user_id = ?');
      params.push(filters.userId);
    }
    if (filters.resourceType) {
      where.push('a.resource_type = ?');
      params.push(filters.resourceType);
    }
    if (filters.from) {
      where.push('a.created_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      where.push('a.created_at <= ?');
      params.push(filters.to);
    }
    if (query.q) {
      where.push('(a.description LIKE ? OR a.actor_name LIKE ? OR a.action LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM audit_logs a ${whereSql}`).get(...params) as { c: number }).c;

    const sortMap: Record<string, string> = { created: 'a.created_at', action: 'a.action', actor: 'a.actor_name' };
    const orderColumn = sortMap[query.sort ?? ''] ?? 'a.created_at';

    const items = db
      .prepare(
        `SELECT a.id, a.action, a.category, a.resource_type, a.resource_id, a.description, a.metadata,
                a.ip_address, a.user_agent, a.created_at, a.actor_name, a.actor_role, a.user_id,
                a.institution_id, i.name AS institution_name
           FROM audit_logs a LEFT JOIN institutions i ON i.id = a.institution_id
           ${whereSql}
          ORDER BY ${orderColumn} ${query.order === 'asc' ? 'ASC' : 'DESC'}
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as any[];

    return okList(
      res,
      paginate(
        items.map((row) => ({ ...row, metadata: JSON.parse(row.metadata ?? '{}') })),
        { page: query.page, pageSize: query.pageSize, total },
      ),
    );
  }),
);

auditLogsRouter.get(
  '/summary',
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const params: unknown[] = [];
    let whereSql = '';
    if (req.user!.roleCode !== 'super_admin') {
      whereSql = 'WHERE institution_id = ?';
      params.push(scope(req));
    }
    const byCategory = db
      .prepare(`SELECT category, COUNT(*) AS count FROM audit_logs ${whereSql} GROUP BY category ORDER BY count DESC`)
      .all(...params);
    const byAction = db
      .prepare(
        `SELECT action, COUNT(*) AS count FROM audit_logs ${whereSql} GROUP BY action ORDER BY count DESC LIMIT 20`,
      )
      .all(...params);
    const recentFailures = db
      .prepare(
        `SELECT COUNT(*) AS failures FROM audit_logs
          WHERE action LIKE 'auth.login_failed%' ${req.user!.roleCode === 'super_admin' ? '' : 'AND institution_id = ?'}`,
      )
      .get(...params);
    return ok(res, { byCategory, byAction, ...(recentFailures as object) });
  }),
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const db = getDb();
    const onlyUnread = req.query.unread === 'true';
    const where = ['user_id = ?'];
    const params: unknown[] = [req.user!.id];
    if (onlyUnread) where.push('read_at IS NULL');
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM notifications ${whereSql}`).get(...params) as { c: number }).c;
    const items = db
      .prepare(
        `SELECT id, type, title, body, link, severity, read_at, created_at FROM notifications ${whereSql}
          ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);
    return okList(res, paginate(items, { page: query.page, pageSize: query.pageSize, total }));
  }),
);

notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const unread = (
      db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user!.id) as {
        c: number;
      }
    ).c;
    return ok(res, { unread });
  }),
);

notificationsRouter.post(
  '/:id/read',
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const info = db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?')
      .run(nowIso(), Number(req.params.id), req.user!.id);
    return ok(res, { updated: info.changes });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const info = db
      .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(nowIso(), req.user!.id);
    return ok(res, { updated: info.changes });
  }),
);

// ---------------------------------------------------------------------------
// Institution settings
// ---------------------------------------------------------------------------
export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get(
  '/',
  requirePermission('settings.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const institutionId = req.user!.roleCode === 'super_admin' && req.query.institutionId
      ? Number(req.query.institutionId)
      : scope(req);
    const rows = db.prepare('SELECT key, value, updated_at FROM settings WHERE institution_id = ?').all(institutionId) as {
      key: string;
      value: string;
      updated_at: string;
    }[];
    const settings: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        settings[row.key] = JSON.parse(row.value);
      } catch {
        settings[row.key] = row.value;
      }
    }
    return ok(res, { institutionId, settings });
  }),
);

settingsRouter.put(
  '/',
  requirePermission('settings.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        settings: z.record(z.string().max(60), z.unknown()),
        institutionId: z.coerce.number().int().positive().optional(),
      }),
      req.body,
    );
    const db = getDb();
    const institutionId =
      req.user!.roleCode === 'super_admin' && body.institutionId ? body.institutionId : scope(req);
    const allowed = Object.keys(body.settings).slice(0, 60);
    db.transaction(() => {
      const upsert = db.prepare(
        `INSERT INTO settings (institution_id, key, value, updated_by, updated_at) VALUES (?,?,?,?,?)
         ON CONFLICT(IFNULL(institution_id, 0), key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      );
      for (const key of allowed) {
        upsert.run(institutionId, key, JSON.stringify(body.settings[key]), req.user!.id, nowIso());
      }
    })();
    recordAudit(db, {
      institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'settings.updated',
      category: 'settings',
      description: `Updated institution settings (${allowed.join(', ')})`,
      metadata: { keys: allowed },
      ...auditMeta(req),
    });
    return ok(res, { message: 'Settings saved.', updated: allowed.length });
  }),
);

// ---------------------------------------------------------------------------
// Grading schemes
// ---------------------------------------------------------------------------
export const gradingSchemesRouter = Router();
gradingSchemesRouter.use(requireAuth);

gradingSchemesRouter.get(
  '/',
  requirePermission('grading_scheme.manage', 'exam.view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const institutionId = scope(req);
    const schemes = db
      .prepare('SELECT * FROM grading_schemes WHERE institution_id = ? ORDER BY is_default DESC, name ASC')
      .all(institutionId) as any[];
    const bands = db
      .prepare(
        `SELECT gb.* FROM grading_bands gb JOIN grading_schemes gs ON gs.id = gb.scheme_id
          WHERE gs.institution_id = ? ORDER BY gb.min_percentage DESC`,
      )
      .all(institutionId) as any[];
    return ok(
      res,
      schemes.map((scheme) => ({ ...scheme, bands: bands.filter((band) => band.scheme_id === scheme.id) })),
    );
  }),
);

gradingSchemesRouter.post(
  '/',
  requirePermission('grading_scheme.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().trim().max(500).optional().nullable(),
        passPercentage: z.coerce.number().min(0).max(100).default(50),
        isDefault: z.boolean().optional(),
        bands: z
          .array(
            z.object({
              grade: z.string().trim().min(1).max(10),
              min_percentage: z.coerce.number().min(0).max(100),
              max_percentage: z.coerce.number().min(0).max(100),
              points: z.coerce.number().min(0).max(100).optional().nullable(),
              remark: z.string().trim().max(120).optional().nullable(),
            }),
          )
          .min(1)
          .max(30)
          .optional(),
      }),
      req.body,
    );
    const db = getDb();
    const institutionId = scope(req);
    const bands = body.bands?.length ? body.bands : DEFAULT_BANDS;
    const problems = validateBands(bands);
    if (problems.length) throw unprocessable('The grading scale is invalid.', problems.map((message) => ({ message })));
    const duplicate = db
      .prepare('SELECT id FROM grading_schemes WHERE institution_id = ? AND name = ?')
      .get(institutionId, body.name.trim());
    if (duplicate) throw conflict('A grading scheme with this name already exists.');

    const schemeId = db.transaction(() => {
      if (body.isDefault) {
        db.prepare('UPDATE grading_schemes SET is_default = 0 WHERE institution_id = ?').run(institutionId);
      }
      const info = db
        .prepare(
          `INSERT INTO grading_schemes (institution_id, name, description, is_default, pass_percentage, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          institutionId,
          body.name.trim(),
          body.description ?? null,
          body.isDefault ? 1 : 0,
          body.passPercentage,
          req.user!.id,
          nowIso(),
          nowIso(),
        );
      const id = Number(info.lastInsertRowid);
      const insertBand = db.prepare(
        `INSERT INTO grading_bands (scheme_id, grade, min_percentage, max_percentage, points, remark, position)
         VALUES (?,?,?,?,?,?,?)`,
      );
      bands
        .slice()
        .sort((a, b) => b.min_percentage - a.min_percentage)
        .forEach((band, index) =>
          insertBand.run(
            id,
            band.grade,
            band.min_percentage,
            band.max_percentage,
            band.points ?? null,
            band.remark ?? null,
            index,
          ),
        );
      return id;
    })();

    recordAudit(db, {
      institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'grading_scheme.created',
      category: 'settings',
      resourceType: 'grading_scheme',
      resourceId: schemeId,
      description: `Created grading scheme "${body.name}"`,
      ...auditMeta(req),
    });
    return created(res, { id: schemeId });
  }),
);

gradingSchemesRouter.put(
  '/:id',
  requirePermission('grading_scheme.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        description: z.string().trim().max(500).optional().nullable(),
        passPercentage: z.coerce.number().min(0).max(100).optional(),
        isDefault: z.boolean().optional(),
        bands: z
          .array(
            z.object({
              grade: z.string().trim().min(1).max(10),
              min_percentage: z.coerce.number().min(0).max(100),
              max_percentage: z.coerce.number().min(0).max(100),
              points: z.coerce.number().min(0).max(100).optional().nullable(),
              remark: z.string().trim().max(120).optional().nullable(),
            }),
          )
          .min(1)
          .max(30)
          .optional(),
      }),
      req.body,
    );
    const db = getDb();
    const institutionId = scope(req);
    const id = Number(req.params.id);
    const existing = db
      .prepare('SELECT * FROM grading_schemes WHERE id = ? AND institution_id = ?')
      .get(id, institutionId) as any;
    if (!existing) throw notFound('Grading scheme not found.');

    if (body.bands) {
      const problems = validateBands(body.bands);
      if (problems.length) {
        throw unprocessable('The grading scale is invalid.', problems.map((message) => ({ message })));
      }
    }

    db.transaction(() => {
      if (body.isDefault) {
        db.prepare('UPDATE grading_schemes SET is_default = 0 WHERE institution_id = ?').run(institutionId);
      }
      db.prepare(
        `UPDATE grading_schemes SET name = ?, description = ?, pass_percentage = ?, is_default = ?, updated_at = ? WHERE id = ?`,
      ).run(
        body.name ?? existing.name,
        body.description === undefined ? existing.description : body.description,
        body.passPercentage ?? existing.pass_percentage,
        body.isDefault === undefined ? existing.is_default : body.isDefault ? 1 : 0,
        nowIso(),
        id,
      );
      if (body.bands) {
        db.prepare('DELETE FROM grading_bands WHERE scheme_id = ?').run(id);
        const insertBand = db.prepare(
          `INSERT INTO grading_bands (scheme_id, grade, min_percentage, max_percentage, points, remark, position)
           VALUES (?,?,?,?,?,?,?)`,
        );
        body.bands
          .slice()
          .sort((a, b) => b.min_percentage - a.min_percentage)
          .forEach((band, index) =>
            insertBand.run(
              id,
              band.grade,
              band.min_percentage,
              band.max_percentage,
              band.points ?? null,
              band.remark ?? null,
              index,
            ),
          );
      }
    })();

    recordAudit(db, {
      institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'grading_scheme.updated',
      category: 'settings',
      resourceType: 'grading_scheme',
      resourceId: id,
      description: `Updated grading scheme "${body.name ?? existing.name}"`,
      ...auditMeta(req),
    });
    return ok(res, { message: 'Grading scheme updated.' });
  }),
);

// ---------------------------------------------------------------------------
// System information (non-sensitive, used by the settings screen)
// ---------------------------------------------------------------------------
export const systemRouter = Router();
systemRouter.use(requireAuth, requirePermission('platform.manage', 'settings.manage'));

systemRouter.get(
  '/info',
  asyncHandler(async (_req: AuthedRequest, res) => {
    const db = getDb();
    const version = (db.prepare('SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1').get() as
      | { version: string }
      | undefined)?.version;
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM audit_logs) AS audit_entries,
           (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > ?) AS active_sessions`,
      )
      .get(nowIso()) as any;
    return ok(res, {
      application: env.appName,
      environment: env.nodeEnv,
      schemaVersion: version ?? 'initial',
      serverTime: nowIso(),
      demoDataEnabled: env.seedDemoData,
      // Whether account emails (password reset, verification) can actually be delivered.
      email: mailStatus(),
      counts,
      limits: {
        loginMaxAttempts: env.loginMaxAttempts,
        loginLockMinutes: env.loginLockMinutes,
        sessionTtlHours: env.sessionTtlHours,
        attemptClockGraceSeconds: env.attemptClockGraceSeconds,
      },
    });
  }),
);
