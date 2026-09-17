import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, created, ok, okList } from '../lib/http';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import {
  assignExam,
  createExam,
  getExamOr404,
  publishAttemptResults,
  publishExamResults,
  transitionExam,
  unassignExam,
  updateExam,
} from '../services/exams';
import { nowIso } from '../lib/time';

const router = Router();
router.use(requireAuth);

function scope(req: AuthedRequest): number | null {
  return req.user!.roleCode === 'super_admin' ? null : req.user!.institutionId;
}

function auditMeta(req: AuthedRequest) {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

const examBodySchema = z.object({
  subjectId: z.coerce.number().int().positive(),
  classId: z.coerce.number().int().positive().nullable().optional(),
  name: z.string().trim().min(3).max(200),
  code: z.string().trim().min(2).max(40),
  academicYear: z.string().trim().min(4).max(20),
  semester: z.string().trim().max(40).nullable().optional(),
  examType: z.enum(['QUIZ', 'MIDTERM', 'FINAL', 'PRACTICAL', 'ASSIGNMENT', 'CERTIFICATION', 'ENTRANCE']),
  durationMinutes: z.coerce.number().int().min(1).max(600),
  startAt: z.string().trim().min(1),
  endAt: z.string().trim().min(1),
  passMarks: z.coerce.number().min(0).max(100000),
  maxAttempts: z.coerce.number().int().min(1).max(20),
  instructions: z.string().trim().max(5000).nullable().optional(),
  randomizeQuestions: z.boolean().optional(),
  randomizeOptions: z.boolean().optional(),
  negativeMarking: z.boolean().optional(),
  gradingSchemeId: z.coerce.number().int().positive().nullable().optional(),
  resultReleaseAt: z.string().trim().min(1).nullable().optional(),
  questions: z
    .array(
      z.object({
        questionId: z.coerce.number().int().positive(),
        marks: z.coerce.number().min(0.25).max(1000),
        negativeMarks: z.coerce.number().min(0).max(1000).default(0),
        position: z.coerce.number().int().min(1).optional(),
      }),
    )
    .min(1)
    .max(500),
});

router.get(
  '/',
  requirePermission('exam.view', 'exam.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];

    if (scope(req) !== null) {
      where.push('e.institution_id = ?');
      params.push(scope(req));
    }
    const filters = req.query as Record<string, string | undefined>;
    if (filters.subjectId) {
      where.push('e.subject_id = ?');
      params.push(Number(filters.subjectId));
    }
    if (filters.classId) {
      where.push('e.class_id = ?');
      params.push(Number(filters.classId));
    }
    if (filters.status) {
      where.push('e.status = ?');
      params.push(filters.status);
    }
    if (filters.examType) {
      where.push('e.exam_type = ?');
      params.push(filters.examType);
    }
    if (filters.academicYear) {
      where.push('e.academic_year = ?');
      params.push(filters.academicYear);
    }
    if (filters.from) {
      where.push('e.start_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      where.push('e.start_at <= ?');
      params.push(filters.to);
    }
    if (filters.mine === 'true') {
      where.push('e.created_by = ?');
      params.push(req.user!.id);
    }
    if (query.q) {
      where.push('(e.name LIKE ? OR e.code LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM exams e ${whereSql}`).get(...params) as { c: number }).c;

    const items = db
      .prepare(
        `SELECT e.*, s.name AS subject_name, c.name AS class_name, u.full_name AS created_by_name,
                (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count,
                (SELECT COUNT(*) FROM exam_assignments ea WHERE ea.exam_id = e.id) AS assignment_count,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id) AS attempt_count,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status = 'IN_PROGRESS') AS live_attempts,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status = 'UNDER_REVIEW') AS awaiting_grading,
                (SELECT COALESCE(ROUND(AVG(r.percentage), 2), 0) FROM results r WHERE r.exam_id = e.id) AS average_percentage
           FROM exams e
           JOIN subjects s ON s.id = e.subject_id
           LEFT JOIN classes c ON c.id = e.class_id
           LEFT JOIN users u ON u.id = e.created_by
           ${whereSql}
          ORDER BY e.start_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);
    return okList(res, paginate(items, { page: query.page, pageSize: query.pageSize, total }));
  }),
);

router.post(
  '/',
  requirePermission('exam.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(examBodySchema, req.body);
    const db = getDb();
    const exam = createExam(db, req.user!, body, auditMeta(req));
    return created(res, exam);
  }),
);

router.get(
  '/:id',
  requirePermission('exam.view', 'exam.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const exam = getExamOr404(db, req.user!, Number(req.params.id));
    const questions = db
      .prepare(
        `SELECT q.id, q.type, q.text, q.topic, q.difficulty, q.marks AS default_marks, eq.position,
                eq.marks, eq.negative_marks, s.name AS subject_name,
                (SELECT COUNT(*) FROM question_options o WHERE o.question_id = q.id) AS option_count
           FROM exam_questions eq
           JOIN questions q ON q.id = eq.question_id
           JOIN subjects s ON s.id = q.subject_id
          WHERE eq.exam_id = ?
          ORDER BY eq.position ASC`,
      )
      .all(exam.id);
    const assignments = db
      .prepare(
        `SELECT ea.id, ea.class_id, ea.group_id, ea.student_id, ea.assigned_at,
                c.name AS class_name, g.name AS group_name, u.full_name AS student_name, s.student_code
           FROM exam_assignments ea
           LEFT JOIN classes c ON c.id = ea.class_id
           LEFT JOIN groups g ON g.id = ea.group_id
           LEFT JOIN students s ON s.id = ea.student_id
           LEFT JOIN users u ON u.id = s.user_id
          WHERE ea.exam_id = ?`,
      )
      .all(exam.id);
    const gradingScheme = exam.grading_scheme_id
      ? db
          .prepare('SELECT id, name, pass_percentage FROM grading_schemes WHERE id = ?')
          .get(exam.grading_scheme_id)
      : null;
    return ok(res, { exam, questions, assignments, gradingScheme });
  }),
);

router.patch(
  '/:id',
  requirePermission('exam.edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(examBodySchema.partial(), req.body);
    const db = getDb();
    const exam = updateExam(db, req.user!, Number(req.params.id), body, auditMeta(req));
    return ok(res, exam);
  }),
);

router.post(
  '/:id/status',
  requirePermission('exam.publish', 'exam.edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({ status: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'UNDER_REVIEW', 'PUBLISHED', 'ARCHIVED']) }),
      req.body,
    );
    const db = getDb();
    const exam = transitionExam(db, req.user!, Number(req.params.id), body.status, auditMeta(req));
    return ok(res, exam);
  }),
);

router.post(
  '/:id/assign',
  requirePermission('exam.assign'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        classIds: z.array(z.coerce.number().int().positive()).max(100).optional(),
        groupIds: z.array(z.coerce.number().int().positive()).max(100).optional(),
        studentIds: z.array(z.coerce.number().int().positive()).max(1000).optional(),
      }),
      req.body,
    );
    const db = getDb();
    const result = assignExam(db, req.user!, Number(req.params.id), body, auditMeta(req));
    return ok(res, result);
  }),
);

router.delete(
  '/:id/assignments/:assignmentId',
  requirePermission('exam.assign'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    unassignExam(db, req.user!, Number(req.params.id), Number(req.params.assignmentId), auditMeta(req));
    return ok(res, { message: 'Assignment removed.' });
  }),
);

router.post(
  '/:id/publish-results',
  requirePermission('result.publish'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const result = publishExamResults(db, req.user!, Number(req.params.id), auditMeta(req));
    return ok(res, result);
  }),
);

router.post(
  '/:id/results/publish',
  requirePermission('result.publish'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({ attemptIds: z.array(z.coerce.number().int().positive()).min(1).max(1000), publish: z.boolean() }),
      req.body,
    );
    const db = getDb();
    const result = publishAttemptResults(db, req.user!, body.attemptIds, body.publish, auditMeta(req));
    return ok(res, result);
  }),
);

router.get(
  '/:id/attempts',
  requirePermission('exam.view', 'attempt.view.any'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const exam = getExamOr404(db, req.user!, Number(req.params.id));
    const attempts = db
      .prepare(
        `SELECT a.id, a.attempt_no, a.status, a.started_at, a.expires_at, a.submitted_at, a.last_activity_at,
                a.obtained_marks, a.max_marks, a.percentage, a.grade, a.auto_submitted, a.integrity_flags,
                u.full_name AS student_name, s.student_code, s.id AS student_id, c.name AS class_name,
                r.is_published, r.outcome, r.id AS result_id
           FROM attempts a
           JOIN students s ON s.id = a.student_id
           JOIN users u ON u.id = s.user_id
           LEFT JOIN classes c ON c.id = s.class_id
           LEFT JOIN results r ON r.attempt_id = a.id
          WHERE a.exam_id = ?
          ORDER BY a.started_at DESC`,
      )
      .all(exam.id) as any[];
    return ok(
      res,
      attempts.map((row) => ({ ...row, integrityFlags: JSON.parse(row.integrity_flags ?? '[]').length })),
    );
  }),
);

/** Live invigilation view: candidates currently sitting the paper. */
router.get(
  '/:id/monitor',
  requirePermission('exam.monitor'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const exam = getExamOr404(db, req.user!, Number(req.params.id));
    const live = db
      .prepare(
        `SELECT a.id, a.attempt_no, a.started_at, a.expires_at, a.last_activity_at, a.ip_address,
                u.full_name AS student_name, s.student_code, c.name AS class_name,
                (SELECT COUNT(*) FROM answers an WHERE an.attempt_id = a.id) AS answers_saved,
                (SELECT COUNT(*) FROM attempt_questions aq WHERE aq.attempt_id = a.id) AS total_questions,
                json_array_length(a.integrity_flags) AS integrity_events
           FROM attempts a
           JOIN students s ON s.id = a.student_id
           JOIN users u ON u.id = s.user_id
           LEFT JOIN classes c ON c.id = s.class_id
          WHERE a.exam_id = ? AND a.status = 'IN_PROGRESS'
          ORDER BY a.started_at ASC`,
      )
      .all(exam.id);
    const summary = db
      .prepare(
        `SELECT COUNT(*) AS total_attempts,
                SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
                SUM(CASE WHEN status IN ('SUBMITTED','UNDER_REVIEW') THEN 1 ELSE 0 END) AS awaiting_review,
                SUM(CASE WHEN status = 'GRADED' THEN 1 ELSE 0 END) AS graded,
                SUM(CASE WHEN auto_submitted = 1 THEN 1 ELSE 0 END) AS auto_submitted
           FROM attempts WHERE exam_id = ?`,
      )
      .get(exam.id);
    return ok(res, { exam, live, summary, serverTime: nowIso() });
  }),
);

router.get(
  '/:id/available-candidates',
  requirePermission('exam.assign'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const exam = getExamOr404(db, req.user!, Number(req.params.id));
    const candidates = db
      .prepare(
        `SELECT s.id, s.student_code, u.full_name, c.name AS class_name, s.class_id
           FROM students s JOIN users u ON u.id = s.user_id
           LEFT JOIN classes c ON c.id = s.class_id
          WHERE s.institution_id = ? AND s.status = 'active'
          ORDER BY u.full_name LIMIT 1000`,
      )
      .all(exam.institution_id);
    const assignedIds = (
      db.prepare('SELECT student_id FROM exam_assignments WHERE exam_id = ? AND student_id IS NOT NULL').all(exam.id) as {
        student_id: number;
      }[]
    ).map((row) => row.student_id);
    return ok(res, { candidates, directlyAssigned: assignedIds });
  }),
);

export default router;
