import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, created, ok, okList } from '../lib/http';
import { forbidden, notFound } from '../lib/errors';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import { recordAudit } from '../services/audit';
import { nowIso } from '../lib/time';

const router = Router();
router.use(requireAuth);

function assertInstitutionScope(req: AuthedRequest, institutionId: number): void {
  if (req.user!.roleCode === 'super_admin') return;
  if (req.user!.institutionId !== institutionId) {
    throw forbidden('You do not have permission to access data from another institution.');
  }
}

router.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.user!.roleCode !== 'super_admin') {
      where.push('i.id = ?');
      params.push(req.user!.institutionId ?? -1);
    }
    if (query.q) {
      where.push('(i.name LIKE ? OR i.code LIKE ? OR i.city LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM institutions i ${whereSql}`).get(...params) as { c: number }).c;
    const items = db
      .prepare(
        `SELECT i.*,
                (SELECT COUNT(*) FROM students s WHERE s.institution_id = i.id AND s.status = 'active') AS student_count,
                (SELECT COUNT(*) FROM teachers t WHERE t.institution_id = i.id AND t.status = 'active') AS teacher_count,
                (SELECT COUNT(*) FROM exams e WHERE e.institution_id = i.id) AS exam_count
           FROM institutions i ${whereSql}
          ORDER BY i.name ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);
    return okList(res, paginate(items, { page: query.page, pageSize: query.pageSize, total }));
  }),
);

router.post(
  '/',
  requirePermission('institution.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        name: z.string().trim().min(2).max(180),
        code: z
          .string()
          .trim()
          .min(2)
          .max(20)
          .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens only.'),
        type: z.enum(['school', 'university', 'training_center', 'certification_body', 'organisation']).default('school'),
        email: z.string().trim().email().optional().nullable(),
        phone: z.string().trim().max(40).optional().nullable(),
        address: z.string().trim().max(250).optional().nullable(),
        city: z.string().trim().max(120).optional().nullable(),
        country: z.string().trim().max(120).optional().nullable(),
        timezone: z.string().trim().max(60).default('UTC'),
        isDemo: z.boolean().optional(),
        adminName: z.string().trim().min(2).max(160).optional(),
        adminEmail: z.string().trim().toLowerCase().email().optional(),
      }),
      req.body,
    );

    const db = getDb();
    const duplicate = db.prepare('SELECT id FROM institutions WHERE code = ?').get(body.code.toUpperCase());
    if (duplicate) throw notFound('An institution with this code already exists.');

    const timestamp = nowIso();
    const institution = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO institutions (name, code, type, email, phone, address, city, country, timezone, status, is_demo, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?, 'active', ?, ?, ?)`,
        )
        .run(
          body.name.trim(),
          body.code.toUpperCase(),
          body.type,
          body.email ?? null,
          body.phone ?? null,
          body.address ?? null,
          body.city ?? null,
          body.country ?? null,
          body.timezone,
          body.isDemo ? 1 : 0,
          timestamp,
          timestamp,
        );
      const id = Number(info.lastInsertRowid);

      // A new institution always receives its own default grading scale.
      const schemeInfo = db
        .prepare(
          `INSERT INTO grading_schemes (institution_id, name, description, is_default, pass_percentage, created_by, created_at, updated_at)
           VALUES (?,?,?, 1, 50, ?, ?, ?)`,
        )
        .run(
          id,
          'Standard grading scale',
          '90-100 A+ · 80-89 A · 70-79 B · 60-69 C · 50-59 D · below 50 F',
          req.user!.id,
          timestamp,
          timestamp,
        );
      const schemeId = Number(schemeInfo.lastInsertRowid);
      const bands = [
        ['A+', 90, 100, 4, 'Outstanding'],
        ['A', 80, 89.99, 4, 'Excellent'],
        ['B', 70, 79.99, 3, 'Very good'],
        ['C', 60, 69.99, 2, 'Good'],
        ['D', 50, 59.99, 1, 'Satisfactory'],
        ['F', 0, 49.99, 0, 'Fail'],
      ];
      const insertBand = db.prepare(
        `INSERT INTO grading_bands (scheme_id, grade, min_percentage, max_percentage, points, remark, position)
         VALUES (?,?,?,?,?,?,?)`,
      );
      bands.forEach((band, index) =>
        insertBand.run(schemeId, band[0] as string, band[1] as number, band[2] as number, band[3] as number, band[4] as string, index),
      );

      return { id, schemeId };
    })();

    recordAudit(db, {
      institutionId: institution.id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'institution.created',
      category: 'institution',
      resourceType: 'institution',
      resourceId: institution.id,
      description: `Created institution "${body.name}"`,
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });

    let administrator: { email: string; userId: number } | null = null;
    if (body.adminName && body.adminEmail) {
      const { createUser } = await import('../services/people');
      const result = await createUser(
        db,
        req.user!,
        {
          fullName: body.adminName,
          email: body.adminEmail,
          roleCode: 'institution_admin',
          institutionId: institution.id,
        },
        { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null },
      );
      administrator = { email: body.adminEmail, userId: result.user.id };
      // The generated password is returned exactly once so the operator can hand it over.
      return created(res, {
        institution: db.prepare('SELECT * FROM institutions WHERE id = ?').get(institution.id),
        administrator: { ...administrator, temporaryPassword: result.temporaryPassword },
      });
    }

    return created(res, {
      institution: db.prepare('SELECT * FROM institutions WHERE id = ?').get(institution.id),
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    assertInstitutionScope(req, id);
    const institution = db.prepare('SELECT * FROM institutions WHERE id = ?').get(id) as any;
    if (!institution) throw notFound('Institution not found.');
    const departments = db.prepare('SELECT id, name, code, status FROM departments WHERE institution_id = ? ORDER BY name').all(id);
    const schemes = db
      .prepare('SELECT id, name, is_default, pass_percentage FROM grading_schemes WHERE institution_id = ? ORDER BY name')
      .all(id);
    return ok(res, { institution, departments, gradingSchemes: schemes });
  }),
);

router.patch(
  '/:id',
  requirePermission('institution.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    assertInstitutionScope(req, id);
    const body = parseWith(
      z
        .object({
          name: z.string().trim().min(2).max(180).optional(),
          type: z.enum(['school', 'university', 'training_center', 'certification_body', 'organisation']).optional(),
          email: z.string().trim().email().optional().nullable(),
          phone: z.string().trim().max(40).optional().nullable(),
          address: z.string().trim().max(250).optional().nullable(),
          city: z.string().trim().max(120).optional().nullable(),
          country: z.string().trim().max(120).optional().nullable(),
          timezone: z.string().trim().max(60).optional(),
          logoUrl: z.string().trim().max(300).optional().nullable(),
        })
        .strict(),
      req.body,
    );
    const existing = db.prepare('SELECT * FROM institutions WHERE id = ?').get(id) as any;
    if (!existing) throw notFound('Institution not found.');

    const fields: Record<string, unknown> = {};
    const mapping: Record<string, string> = {
      name: 'name',
      type: 'type',
      email: 'email',
      phone: 'phone',
      address: 'address',
      city: 'city',
      country: 'country',
      timezone: 'timezone',
      logoUrl: 'logo_url',
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (body[key as keyof typeof body] !== undefined) fields[column] = body[key as keyof typeof body] ?? null;
    }
    if (!Object.keys(fields).length) return ok(res, existing);

    const clause = Object.keys(fields).map((key) => `${key} = ?`).join(', ');
    db.prepare(`UPDATE institutions SET ${clause}, updated_at = ? WHERE id = ?`).run(
      ...Object.values(fields),
      nowIso(),
      id,
    );
    recordAudit(db, {
      institutionId: id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'institution.updated',
      category: 'institution',
      resourceType: 'institution',
      resourceId: id,
      description: 'Updated institution profile',
      metadata: { fields: Object.keys(fields) },
      ip: req.ip ?? null,
    });
    return ok(res, db.prepare('SELECT * FROM institutions WHERE id = ?').get(id));
  }),
);

router.post(
  '/:id/status',
  requirePermission('platform.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(z.object({ status: z.enum(['active', 'suspended', 'archived']) }), req.body);
    const db = getDb();
    const id = Number(req.params.id);
    const institution = db.prepare('SELECT * FROM institutions WHERE id = ?').get(id) as any;
    if (!institution) throw notFound('Institution not found.');
    db.prepare('UPDATE institutions SET status = ?, updated_at = ? WHERE id = ?').run(body.status, nowIso(), id);
    if (body.status !== 'active') {
      // Suspending an institution immediately invalidates its users' sessions.
      db.prepare(
        `UPDATE sessions SET revoked_at = ?, revoked_reason = 'institution_' || ?
          WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE institution_id = ?)`,
      ).run(nowIso(), body.status, id);
    }
    recordAudit(db, {
      institutionId: id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'institution.status_changed',
      category: 'institution',
      resourceType: 'institution',
      resourceId: id,
      description: `Institution status changed from ${institution.status} to ${body.status}`,
      ip: req.ip ?? null,
    });
    return ok(res, { message: `Institution is now ${body.status}.` });
  }),
);

export default router;
