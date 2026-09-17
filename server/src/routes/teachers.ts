import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, created, ok, okList } from '../lib/http';
import { notFound } from '../lib/errors';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import { createUser, listTeachers, updatePerson } from '../services/people';
import { nowIso } from '../lib/time';
import { recordAudit } from '../services/audit';

const router = Router();
router.use(requireAuth);

function scope(req: AuthedRequest): number | null {
  return req.user!.roleCode === 'super_admin' ? null : req.user!.institutionId;
}

router.get(
  '/',
  requirePermission('teacher.view', 'teacher.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const filters = parseWith(
      z.object({
        departmentId: z.coerce.number().int().positive().optional(),
        status: z.enum(['active', 'inactive', 'suspended']).optional(),
      }),
      req.query,
    );
    const db = getDb();
    const result = listTeachers(db, req.user!, { ...filters, search: query.q }, { page: query.page, pageSize: query.pageSize });
    return okList(res, paginate(result.items, { page: query.page, pageSize: query.pageSize, total: result.total }));
  }),
);

router.post(
  '/',
  requirePermission('teacher.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        fullName: z.string().trim().min(2).max(160),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(10).max(200).optional(),
        staffCode: z.string().trim().max(40).optional(),
        departmentId: z.coerce.number().int().positive().optional().nullable(),
        designation: z.string().trim().max(120).optional().nullable(),
        specialization: z.string().trim().max(160).optional().nullable(),
        phone: z.string().trim().max(40).optional().nullable(),
      }),
      req.body,
    );
    const db = getDb();
    const result = await createUser(
      db,
      req.user!,
      {
        fullName: body.fullName,
        email: body.email,
        roleCode: 'teacher',
        password: body.password,
        phone: body.phone ?? null,
        staffCode: body.staffCode,
        departmentId: body.departmentId ?? null,
        designation: body.designation ?? null,
        specialization: body.specialization ?? null,
      },
      { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null },
    );
    return created(res, result);
  }),
);

router.get(
  '/:id',
  requirePermission('teacher.view', 'teacher.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const teacher = db
      .prepare(
        `SELECT t.*, u.id AS user_id, u.full_name, u.email, u.phone, u.status AS account_status, u.last_login_at,
                d.name AS department_name
           FROM teachers t JOIN users u ON u.id = t.user_id
           LEFT JOIN departments d ON d.id = t.department_id
          WHERE t.id = ?`,
      )
      .get(id) as any;
    if (!teacher) throw notFound('Examiner not found.');
    if (scope(req) !== null && teacher.institution_id !== scope(req)) throw notFound('Examiner not found.');

    const subjects = db
      .prepare(
        `SELECT s.id, s.name, s.code FROM teacher_subjects ts JOIN subjects s ON s.id = ts.subject_id
          WHERE ts.teacher_id = ? ORDER BY s.name`,
      )
      .all(id);
    const exams = db
      .prepare(
        `SELECT e.id, e.name, e.code, e.status, e.start_at, e.total_marks,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id) AS attempts,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status = 'UNDER_REVIEW') AS pending_grading
           FROM exams e WHERE e.created_by = ? ORDER BY e.start_at DESC LIMIT 30`,
      )
      .all(teacher.user_id);
    const stats = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM questions WHERE created_by = ?) AS questions,
           (SELECT COUNT(*) FROM question_banks WHERE created_by = ?) AS banks,
           (SELECT COUNT(*) FROM grading_history WHERE grader_id = ?) AS grading_actions`,
      )
      .get(teacher.user_id, teacher.user_id, teacher.user_id);

    return ok(res, { teacher, subjects, exams, stats });
  }),
);

router.patch(
  '/:id',
  requirePermission('teacher.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const teacher = db.prepare('SELECT id, user_id FROM teachers WHERE id = ?').get(id) as any;
    if (!teacher) throw notFound('Examiner not found.');
    const body = parseWith(
      z
        .object({
          fullName: z.string().trim().min(2).max(160).optional(),
          email: z.string().trim().toLowerCase().email().optional(),
          phone: z.string().trim().max(40).optional().nullable(),
          staffCode: z.string().trim().max(40).optional(),
          departmentId: z.coerce.number().int().positive().nullable().optional(),
          designation: z.string().trim().max(120).optional().nullable(),
          specialization: z.string().trim().max(160).optional().nullable(),
          status: z.enum(['active', 'inactive', 'suspended']).optional(),
        })
        .strict(),
      req.body,
    );
    await updatePerson(db, req.user!, teacher.user_id, body, {
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return ok(res, db.prepare('SELECT * FROM teachers WHERE id = ?').get(id));
  }),
);

router.put(
  '/:id/subjects',
  requirePermission('teacher.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(z.object({ subjectIds: z.array(z.coerce.number().int().positive()).max(100) }), req.body);
    const db = getDb();
    const id = Number(req.params.id);
    const teacher = db.prepare('SELECT * FROM teachers WHERE id = ?').get(id) as any;
    if (!teacher) throw notFound('Examiner not found.');
    if (scope(req) !== null && teacher.institution_id !== scope(req)) throw notFound('Examiner not found.');

    db.transaction(() => {
      db.prepare('DELETE FROM teacher_subjects WHERE teacher_id = ?').run(id);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO teacher_subjects (teacher_id, subject_id, assigned_at)
         SELECT ?, s.id, ? FROM subjects s WHERE s.id = ? AND s.institution_id = ?`,
      );
      for (const subjectId of body.subjectIds) insert.run(id, nowIso(), subjectId, teacher.institution_id);
    })();

    recordAudit(db, {
      institutionId: teacher.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'teacher.subjects_assigned',
      category: 'user',
      resourceType: 'teacher',
      resourceId: id,
      description: `Assigned ${body.subjectIds.length} subject(s) to examiner #${id}`,
      metadata: { subjectIds: body.subjectIds },
      ip: req.ip ?? null,
    });
    return ok(res, { assigned: body.subjectIds.length });
  }),
);

export default router;
