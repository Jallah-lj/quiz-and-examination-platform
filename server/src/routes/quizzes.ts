import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, created, ok, okList } from '../lib/http';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import { assignQuiz, createQuiz, getQuizOr404, publishQuizResults, transitionQuiz, updateQuiz } from '../services/quizzes';

const router = Router();
router.use(requireAuth);

function scope(req: AuthedRequest): number | null {
  return req.user!.roleCode === 'super_admin' ? null : req.user!.institutionId;
}

function auditMeta(req: AuthedRequest) {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

const quizBodySchema = z.object({
  subjectId: z.coerce.number().int().positive(),
  classId: z.coerce.number().int().positive().nullable().optional(),
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().max(2000).optional().nullable(),
  instructions: z.string().trim().max(4000).optional().nullable(),
  questionCount: z.coerce.number().int().min(1).max(500),
  timeLimitMinutes: z.coerce.number().int().min(1).max(600),
  maxAttempts: z.coerce.number().int().min(1).max(20),
  passPercentage: z.coerce.number().min(0).max(100),
  randomizeQuestions: z.boolean().optional(),
  randomizeOptions: z.boolean().optional(),
  immediateResults: z.boolean().optional(),
  showCorrectAnswers: z.boolean().optional(),
  allowReview: z.boolean().optional(),
  negativeMarking: z.boolean().optional(),
  availableFrom: z.string().trim().min(1),
  availableUntil: z.string().trim().min(1),
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
  requirePermission('quiz.view', 'quiz.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];

    if (scope(req) !== null) {
      where.push('qz.institution_id = ?');
      params.push(scope(req));
    }
    if (req.user!.roleCode === 'teacher' && req.query.mine === 'true') {
      where.push('qz.created_by = ?');
      params.push(req.user!.id);
    }
    const filters = req.query as Record<string, string | undefined>;
    if (filters.subjectId) {
      where.push('qz.subject_id = ?');
      params.push(Number(filters.subjectId));
    }
    if (filters.classId) {
      where.push('qz.class_id = ?');
      params.push(Number(filters.classId));
    }
    if (filters.status) {
      where.push('qz.status = ?');
      params.push(filters.status);
    }
    if (query.q) {
      where.push('(qz.title LIKE ? OR qz.description LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM quizzes qz ${whereSql}`).get(...params) as { c: number }).c;

    const items = db
      .prepare(
        `SELECT qz.*, s.name AS subject_name, c.name AS class_name, u.full_name AS created_by_name,
                (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = qz.id) AS attached_questions,
                (SELECT COUNT(*) FROM quiz_assignments qa WHERE qa.quiz_id = qz.id) AS assignments,
                (SELECT COUNT(*) FROM attempts a WHERE a.quiz_id = qz.id) AS attempt_count,
                (SELECT COALESCE(ROUND(AVG(r.percentage), 2), 0) FROM results r WHERE r.quiz_id = qz.id) AS average_percentage
           FROM quizzes qz
           JOIN subjects s ON s.id = qz.subject_id
           LEFT JOIN classes c ON c.id = qz.class_id
           LEFT JOIN users u ON u.id = qz.created_by
           ${whereSql}
          ORDER BY qz.updated_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);
    return okList(res, paginate(items, { page: query.page, pageSize: query.pageSize, total }));
  }),
);

router.post(
  '/',
  requirePermission('quiz.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(quizBodySchema, req.body);
    const db = getDb();
    const quiz = createQuiz(db, req.user!, body, auditMeta(req));
    return created(res, quiz);
  }),
);

router.get(
  '/:id',
  requirePermission('quiz.view', 'quiz.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const quiz = getQuizOr404(db, req.user!, Number(req.params.id));
    const questions = db
      .prepare(
        `SELECT q.id, q.type, q.text, q.topic, q.difficulty, q.marks AS default_marks, qq.position,
                qq.marks, qq.negative_marks, s.name AS subject_name,
                (SELECT COUNT(*) FROM question_options o WHERE o.question_id = q.id) AS option_count
           FROM quiz_questions qq
           JOIN questions q ON q.id = qq.question_id
           JOIN subjects s ON s.id = q.subject_id
          WHERE qq.quiz_id = ?
          ORDER BY qq.position ASC`,
      )
      .all(quiz.id);
    const assignments = db
      .prepare(
        `SELECT qa.id, qa.class_id, qa.group_id, qa.student_id, qa.assigned_at,
                c.name AS class_name, g.name AS group_name, u.full_name AS student_name, s.student_code
           FROM quiz_assignments qa
           LEFT JOIN classes c ON c.id = qa.class_id
           LEFT JOIN groups g ON g.id = qa.group_id
           LEFT JOIN students s ON s.id = qa.student_id
           LEFT JOIN users u ON u.id = s.user_id
          WHERE qa.quiz_id = ?`,
      )
      .all(quiz.id);
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS attempts,
                SUM(CASE WHEN a.status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
                SUM(CASE WHEN a.status IN ('SUBMITTED','UNDER_REVIEW') THEN 1 ELSE 0 END) AS awaiting_grading,
                COALESCE(ROUND(AVG(a.percentage), 2), 0) AS average_percentage
           FROM attempts a WHERE a.quiz_id = ?`,
      )
      .get(quiz.id);
    return ok(res, { quiz, questions, assignments, stats });
  }),
);

router.patch(
  '/:id',
  requirePermission('quiz.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(quizBodySchema.partial(), req.body);
    const db = getDb();
    const quiz = updateQuiz(db, req.user!, Number(req.params.id), body, auditMeta(req));
    return ok(res, quiz);
  }),
);

router.post(
  '/:id/status',
  requirePermission('quiz.publish', 'quiz.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({ status: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'CLOSED', 'ARCHIVED']) }),
      req.body,
    );
    const db = getDb();
    const quiz = transitionQuiz(db, req.user!, Number(req.params.id), body.status, auditMeta(req));
    return ok(res, quiz);
  }),
);

router.post(
  '/:id/assign',
  requirePermission('quiz.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        classIds: z.array(z.coerce.number().int().positive()).max(100).optional(),
        groupIds: z.array(z.coerce.number().int().positive()).max(100).optional(),
        studentIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
      }),
      req.body,
    );
    const db = getDb();
    const result = assignQuiz(db, req.user!, Number(req.params.id), body, auditMeta(req));
    return ok(res, result);
  }),
);

router.post(
  '/:id/publish-results',
  requirePermission('quiz.publish', 'result.publish'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const result = publishQuizResults(db, req.user!, Number(req.params.id), auditMeta(req));
    return ok(res, result);
  }),
);

router.get(
  '/:id/attempts',
  requirePermission('quiz.view', 'quiz.manage', 'attempt.view.any'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const quiz = getQuizOr404(db, req.user!, Number(req.params.id));
    const attempts = db
      .prepare(
        `SELECT a.id, a.attempt_no, a.status, a.started_at, a.submitted_at, a.obtained_marks, a.max_marks,
                a.percentage, a.grade, a.auto_submitted, a.expires_at,
                u.full_name AS student_name, s.student_code, s.id AS student_id,
                r.is_published, r.outcome
           FROM attempts a
           JOIN students s ON s.id = a.student_id
           JOIN users u ON u.id = s.user_id
           LEFT JOIN results r ON r.attempt_id = a.id
          WHERE a.quiz_id = ?
          ORDER BY a.started_at DESC`,
      )
      .all(quiz.id);
    return ok(res, attempts);
  }),
);

router.get(
  '/:id/available-candidates',
  requirePermission('quiz.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const quiz = getQuizOr404(db, req.user!, Number(req.params.id));
    const candidates = db
      .prepare(
        `SELECT s.id, s.student_code, u.full_name, c.name AS class_name
           FROM students s JOIN users u ON u.id = s.user_id
           LEFT JOIN classes c ON c.id = s.class_id
          WHERE s.institution_id = ? AND s.status = 'active'
            AND (? IS NULL OR s.class_id = ?)
          ORDER BY u.full_name LIMIT 500`,
      )
      .all(quiz.institution_id, quiz.class_id, quiz.class_id);
    return ok(res, candidates);
  }),
);

export default router;
