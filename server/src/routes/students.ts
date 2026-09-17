import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, created, ok, okList } from '../lib/http';
import { notFound } from '../lib/errors';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import { createUser, listStudents, updatePerson } from '../services/people';

const router = Router();
router.use(requireAuth);

function scope(req: AuthedRequest): number | null {
  return req.user!.roleCode === 'super_admin' ? null : req.user!.institutionId;
}

router.get(
  '/',
  requirePermission('student.view', 'student.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const filters = parseWith(
      z.object({
        classId: z.coerce.number().int().positive().optional(),
        departmentId: z.coerce.number().int().positive().optional(),
        status: z.enum(['active', 'inactive', 'graduated', 'suspended']).optional(),
      }),
      req.query,
    );
    const db = getDb();
    const result = listStudents(db, req.user!, { ...filters, search: query.q }, { page: query.page, pageSize: query.pageSize });
    return okList(res, paginate(result.items, { page: query.page, pageSize: query.pageSize, total: result.total }));
  }),
);

router.post(
  '/',
  requirePermission('student.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        fullName: z.string().trim().min(2).max(160),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(10).max(200).optional(),
        studentCode: z.string().trim().max(40).optional(),
        classId: z.coerce.number().int().positive().optional().nullable(),
        phone: z.string().trim().max(40).optional().nullable(),
        guardianName: z.string().trim().max(160).optional().nullable(),
        guardianPhone: z.string().trim().max(40).optional().nullable(),
        dateOfBirth: z.string().trim().max(30).optional().nullable(),
        gender: z.string().trim().max(20).optional().nullable(),
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
        roleCode: 'student',
        password: body.password,
        phone: body.phone ?? null,
        studentCode: body.studentCode,
        classId: body.classId ?? null,
        guardianName: body.guardianName ?? null,
        guardianPhone: body.guardianPhone ?? null,
        dateOfBirth: body.dateOfBirth ?? null,
        gender: body.gender ?? null,
      },
      { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null },
    );
    return created(res, result);
  }),
);

router.get(
  '/:id',
  requirePermission('student.view', 'student.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const student = db
      .prepare(
        `SELECT s.*, u.id AS user_id, u.full_name, u.email, u.phone, u.status AS account_status, u.last_login_at,
                c.name AS class_name, c.academic_year, d.name AS department_name
           FROM students s JOIN users u ON u.id = s.user_id
           LEFT JOIN classes c ON c.id = s.class_id
           LEFT JOIN departments d ON d.id = c.department_id
          WHERE s.id = ?`,
      )
      .get(id) as any;
    if (!student) throw notFound('Candidate not found.');
    if (scope(req) !== null && student.institution_id !== scope(req)) throw notFound('Candidate not found.');

    const results = db
      .prepare(
        `SELECT r.id, r.percentage, r.grade, r.outcome, r.is_published, r.obtained_marks, r.total_marks,
                COALESCE(e.name, qz.title) AS paper_title, COALESCE(a.submitted_at, r.created_at) AS date
           FROM results r JOIN attempts a ON a.id = r.attempt_id
           LEFT JOIN exams e ON e.id = r.exam_id LEFT JOIN quizzes qz ON qz.id = r.quiz_id
          WHERE r.student_id = ? ORDER BY date DESC LIMIT 50`,
      )
      .all(id);
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS attempts,
                SUM(CASE WHEN outcome = 'PASSED' THEN 1 ELSE 0 END) AS passed,
                COALESCE(ROUND(AVG(percentage), 2), 0) AS average
           FROM results WHERE student_id = ? AND outcome != 'PENDING'`,
      )
      .get(id);
    const upcoming = db
      .prepare(
        `SELECT e.id, e.name, e.start_at, e.duration_minutes, e.status
           FROM exams e
          WHERE e.start_at > ? AND e.status IN ('SCHEDULED','ACTIVE')
            AND (e.class_id = ? OR EXISTS (SELECT 1 FROM exam_assignments ea WHERE ea.exam_id = e.id AND (ea.class_id = ? OR ea.student_id = ?)))
          ORDER BY e.start_at ASC LIMIT 10`,
      )
      .all(new Date().toISOString(), student.class_id ?? -1, student.class_id ?? -1, id);

    return ok(res, { student, results, stats, upcoming });
  }),
);

router.patch(
  '/:id',
  requirePermission('student.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const student = db.prepare('SELECT id, user_id FROM students WHERE id = ?').get(id) as any;
    if (!student) throw notFound('Candidate not found.');
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
        })
        .strict(),
      req.body,
    );
    await updatePerson(db, req.user!, student.user_id, body, {
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
    });
    return ok(res, db.prepare('SELECT * FROM students WHERE id = ?').get(id));
  }),
);

export default router;
