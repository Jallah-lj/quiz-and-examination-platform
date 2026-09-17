import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, created, ok, okList } from '../lib/http';
import { conflict, forbidden, notFound } from '../lib/errors';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import {
  assertAttemptAccess,
  getAttemptPaper,
  recordIntegrityEvent,
  saveAnswer,
  startAttempt,
  submitAttempt,
} from '../services/attempts';
import { getResultDetail } from '../services/results';
import { nowIso } from '../lib/time';
import { recordAudit } from '../services/audit';

const router = Router();
router.use(requireAuth);

function auditMeta(req: AuthedRequest) {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

/** Candidate dashboard list of their own attempts. */
router.get(
  '/',
  requirePermission('attempt.view.own', 'attempt.view.any'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];

    if (req.user!.roleCode === 'student') {
      if (!req.user!.studentId) throw forbidden();
      where.push('a.student_id = ?');
      params.push(req.user!.studentId);
    } else if (req.user!.roleCode !== 'super_admin') {
      where.push('a.institution_id = ?');
      params.push(req.user!.institutionId ?? -1);
    }
    const filters = req.query as Record<string, string | undefined>;
    if (filters.status) {
      where.push('a.status = ?');
      params.push(filters.status);
    }
    if (filters.examId) {
      where.push('a.exam_id = ?');
      params.push(Number(filters.examId));
    }
    if (filters.studentId && req.user!.roleCode !== 'student') {
      where.push('a.student_id = ?');
      params.push(Number(filters.studentId));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (db.prepare(`SELECT COUNT(*) AS c FROM attempts a ${whereSql}`).get(...params) as { c: number }).c;
    const items = db
      .prepare(
        `SELECT a.id, a.attempt_no, a.status, a.started_at, a.expires_at, a.submitted_at, a.obtained_marks,
                a.max_marks, a.percentage, a.grade, a.auto_submitted,
                COALESCE(e.name, qz.title) AS paper_title, COALESCE(e.code, '') AS paper_code,
                CASE WHEN a.exam_id IS NOT NULL THEN 'EXAM' ELSE 'QUIZ' END AS kind,
                r.is_published, r.outcome, r.id AS result_id,
                u.full_name AS student_name, s.student_code
           FROM attempts a
           LEFT JOIN exams e ON e.id = a.exam_id
           LEFT JOIN quizzes qz ON qz.id = a.quiz_id
           JOIN students s ON s.id = a.student_id
           JOIN users u ON u.id = s.user_id
           LEFT JOIN results r ON r.attempt_id = a.id
           ${whereSql}
          ORDER BY a.started_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);
    return okList(res, paginate(items, { page: query.page, pageSize: query.pageSize, total }));
  }),
);

/** Starts (or resumes) an examination attempt. */
router.post(
  '/',
  requirePermission('attempt.take'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z
        .object({
          examId: z.coerce.number().int().positive().optional(),
          quizId: z.coerce.number().int().positive().optional(),
        })
        .refine((data) => Boolean(data.examId) !== Boolean(data.quizId), {
          message: 'Provide exactly one of examId or quizId.',
        }),
      req.body,
    );
    const db = getDb();
    const result = startAttempt(db, req.user!, body, auditMeta(req));
    recordAudit(db, {
      institutionId: req.user!.institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'attempt.started',
      category: 'exam',
      resourceType: 'attempt',
      resourceId: result.attemptId,
      description: `Started ${result.targetKind} #${result.targetId} (attempt ${result.attemptNo})`,
      metadata: { resumed: result.resumed, ip: req.ip ?? null },
      ...auditMeta(req),
    });
    return created(res, result);
  }),
);

/** The running paper, including saved answers and server-derived remaining time. */
router.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const attemptId = Number(req.params.id);
    const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as any;
    if (!attempt) throw notFound('Attempt not found.');
    assertAttemptAccess(db, req.user!, attempt);

    const paper = getAttemptPaper(db, attemptId);
    return ok(res, paper);
  }),
);

const answerSchema = z.object({
  selectedOptions: z.array(z.string().trim().max(4)).max(10).optional(),
  answerText: z.string().max(20000).nullable().optional(),
  isFlagged: z.boolean().optional(),
});

/** Auto-save endpoint: one answer at a time, idempotent and server-timed. */
router.patch(
  '/:id/answers/:questionId',
  requirePermission('attempt.take', 'attempt.view.any'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(answerSchema, req.body);
    const db = getDb();
    const attemptId = Number(req.params.id);
    const questionId = Number(req.params.questionId);
    const result = saveAnswer(db, req.user!, attemptId, questionId, body);
    return ok(res, result);
  }),
);

router.post(
  '/:id/submit',
  requirePermission('attempt.take', 'attempt.view.any'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        reason: z.enum(['manual', 'time_expired']).optional(),
        finalAnswers: z
          .array(
            z.object({
              questionId: z.coerce.number().int().positive(),
              selectedOptions: z.array(z.string().trim().max(4)).max(10).optional(),
              answerText: z.string().max(20000).nullable().optional(),
              isFlagged: z.boolean().optional(),
            }),
          )
          .max(500)
          .optional(),
      }),
      req.body ?? {},
    );
    const db = getDb();
    const attemptId = Number(req.params.id);

    // Any answers still queued in the browser are flushed before the attempt is locked.
    if (body.finalAnswers?.length) {
      for (const answer of body.finalAnswers) {
        try {
          saveAnswer(db, req.user!, attemptId, answer.questionId, {
            selectedOptions: answer.selectedOptions,
            answerText: answer.answerText,
            isFlagged: answer.isFlagged,
          });
        } catch {
          // A rejected final save (for example because the timer expired) must not
          // block submission — previously saved answers are already persisted.
        }
      }
    }

    const result = submitAttempt(db, req.user!, attemptId, body.reason === 'time_expired' ? 'time_expired' : 'manual');
    recordAudit(db, {
      institutionId: req.user!.institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'attempt.submitted',
      category: 'exam',
      resourceType: 'attempt',
      resourceId: attemptId,
      description: `Submitted attempt #${attemptId} (${result.status})`,
      metadata: { obtained: result.totalObtained, max: result.maxMarks, outcome: result.outcome },
      ...auditMeta(req),
    });
    return ok(res, result);
  }),
);

router.post(
  '/:id/heartbeat',
  requirePermission('attempt.take', 'attempt.view.any'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({ clientRemainingSeconds: z.coerce.number().min(0).max(100000).optional() }).optional(),
      req.body ?? {},
    );
    const db = getDb();
    const attemptId = Number(req.params.id);
    const attempt = db
      .prepare('SELECT id, student_id, institution_id, status, expires_at FROM attempts WHERE id = ?')
      .get(attemptId) as any;
    if (!attempt) throw notFound('Attempt not found.');
    assertAttemptAccess(db, req.user!, attempt);

    const now = nowIso();
    const remaining = Math.max(0, Math.round((new Date(attempt.expires_at).getTime() - new Date(now).getTime()) / 1000));

    // A large divergence between the client clock and the server clock is recorded for
    // the examiner's attention. The server value always wins.
    if (body && typeof body.clientRemainingSeconds === 'number') {
      const drift = Math.abs(remaining - body.clientRemainingSeconds);
      if (drift > 60 && attempt.status === 'IN_PROGRESS') {
        recordIntegrityEvent(db, req.user!, attemptId, {
          type: 'timer_drift',
          detail: `Client reported ${body.clientRemainingSeconds}s remaining; server says ${remaining}s.`,
        });
      }
    }

    if (attempt.status === 'IN_PROGRESS') {
      db.prepare('UPDATE attempts SET last_activity_at = ? WHERE id = ?').run(now, attemptId);
    }

    return ok(res, { serverTime: now, remainingSeconds: remaining, status: attempt.status });
  }),
);

router.post(
  '/:id/events',
  requirePermission('attempt.take'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        type: z.enum(['visibility_hidden', 'visibility_visible', 'window_blur', 'window_focus', 'connection_lost', 'connection_restored', 'copy_attempt', 'fullscreen_exit']),
        detail: z.string().max(500).optional(),
      }),
      req.body,
    );
    const db = getDb();
    recordIntegrityEvent(db, req.user!, Number(req.params.id), body);
    return ok(res, { recorded: true, serverTime: nowIso() });
  }),
);

/** Review of a completed attempt, gated on availability of the released result. */
router.get(
  '/:id/review',
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const attemptId = Number(req.params.id);
    const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as any;
    if (!attempt) throw notFound('Attempt not found.');
    assertAttemptAccess(db, req.user!, attempt);
    if (attempt.status === 'IN_PROGRESS') {
      throw conflict('The attempt is still in progress.');
    }
    const result = db.prepare('SELECT id FROM results WHERE attempt_id = ?').get(attemptId) as { id: number } | undefined;
    if (!result) throw notFound('No result has been generated for this attempt yet.');
    return ok(res, getResultDetail(db, req.user!, result.id));
  }),
);

export default router;
