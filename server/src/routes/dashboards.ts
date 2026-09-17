/**
 * Dashboard endpoints. Every figure is aggregated from live records for the
 * authenticated user's scope — no placeholder or estimated statistics.
 */
import { Router } from 'express';
import { getDb } from '../db';
import { asyncHandler, ok } from '../lib/http';
import { forbidden } from '../lib/errors';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import { addDays, nowIso } from '../lib/time';

const router = Router();
router.use(requireAuth);

function assignmentFilter(): string {
  return `(
    EXISTS (SELECT 1 FROM exam_assignments ea WHERE ea.exam_id = e.id
              AND (ea.student_id = @studentId
                   OR (ea.class_id IS NOT NULL AND ea.class_id = @classId)
                   OR (ea.group_id IS NOT NULL AND EXISTS (
                         SELECT 1 FROM group_members gm WHERE gm.group_id = ea.group_id AND gm.student_id = @studentId))))
    OR e.class_id = @classId
  )`;
}

router.get(
  '/student',
  requirePermission('attempt.take', 'attempt.view.own'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const studentId = req.user!.studentId;
    if (!studentId) throw forbidden('No candidate profile is linked to this account.');
    const student = db
      .prepare(
        `SELECT s.id, s.student_code, s.class_id, u.full_name, c.name AS class_name, d.name AS department_name,
                i.name AS institution_name
           FROM students s JOIN users u ON u.id = s.user_id
           JOIN institutions i ON i.id = s.institution_id
           LEFT JOIN classes c ON c.id = s.class_id
           LEFT JOIN departments d ON d.id = c.department_id
          WHERE s.id = ?`,
      )
      .get(studentId) as any;

    const params = { studentId, classId: student.class_id ?? -1 };
    const now = nowIso();

    const availableExams = db
      .prepare(
        `SELECT e.id, e.name, e.code, e.start_at, e.end_at, e.duration_minutes, e.total_marks, e.status,
                s.name AS subject_name, e.max_attempts,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.student_id = @studentId) AS my_attempts,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.student_id = @studentId AND a.status = 'IN_PROGRESS') AS in_progress
           FROM exams e JOIN subjects s ON s.id = e.subject_id
          WHERE e.status IN ('SCHEDULED','ACTIVE') AND ${assignmentFilter()}
            AND e.start_at <= @now AND e.end_at >= @now
          ORDER BY e.end_at ASC`,
      )
      .all({ ...params, now }) as any[];

    const upcomingExams = db
      .prepare(
        `SELECT e.id, e.name, e.code, e.start_at, e.end_at, e.duration_minutes, e.total_marks, e.status,
                s.name AS subject_name
           FROM exams e JOIN subjects s ON s.id = e.subject_id
          WHERE e.status IN ('SCHEDULED','ACTIVE') AND ${assignmentFilter()} AND e.start_at > @now
          ORDER BY e.start_at ASC LIMIT 10`,
      )
      .all({ ...params, now }) as any[];

    const availableQuizzes = db
      .prepare(
        `SELECT qz.id, qz.title, qz.time_limit_minutes, qz.pass_percentage, qz.available_from, qz.available_until,
                qz.max_attempts, s.name AS subject_name,
                (SELECT COUNT(*) FROM attempts a WHERE a.quiz_id = qz.id AND a.student_id = ?) AS my_attempts
           FROM quizzes qz JOIN subjects s ON s.id = qz.subject_id
          WHERE qz.status IN ('SCHEDULED','ACTIVE')
            AND (qz.available_from <= ? AND qz.available_until >= ?)
            AND (EXISTS (SELECT 1 FROM quiz_assignments qa WHERE qa.quiz_id = qz.id
                          AND (qa.student_id = ? OR (qa.class_id IS NOT NULL AND qa.class_id = ?)
                               OR (qa.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = qa.group_id AND gm.student_id = ?))))
                 OR qz.class_id = ?)
          ORDER BY qz.available_until ASC`,
      )
      .all(studentId, now, now, studentId, student.class_id ?? -1, studentId, student.class_id ?? -1) as any[];

    const recentResults = db
      .prepare(
        `SELECT r.id, r.percentage, r.grade, r.outcome, r.obtained_marks, r.total_marks, r.is_published,
                COALESCE(e.name, qz.title) AS paper_title, COALESCE(a.submitted_at, r.created_at) AS date,
                s.name AS subject_name
           FROM results r
           JOIN attempts a ON a.id = r.attempt_id
           LEFT JOIN exams e ON e.id = r.exam_id
           LEFT JOIN quizzes qz ON qz.id = r.quiz_id
           LEFT JOIN subjects s ON s.id = r.subject_id
          WHERE r.student_id = ? AND r.is_published = 1
          ORDER BY date DESC LIMIT 8`,
      )
      .all(studentId);

    const history = db
      .prepare(
        `SELECT a.id, a.status, a.started_at, a.submitted_at, a.obtained_marks, a.max_marks, a.percentage, a.grade,
                COALESCE(e.name, qz.title) AS paper_title,
                CASE WHEN a.exam_id IS NOT NULL THEN 'EXAM' ELSE 'QUIZ' END AS kind,
                r.is_published, r.outcome, r.id AS result_id
           FROM attempts a
           LEFT JOIN exams e ON e.id = a.exam_id
           LEFT JOIN quizzes qz ON qz.id = a.quiz_id
           LEFT JOIN results r ON r.attempt_id = a.id
          WHERE a.student_id = ?
          ORDER BY a.started_at DESC LIMIT 15`,
      )
      .all(studentId);

    const stats = db
      .prepare(
        `SELECT
           COUNT(*) AS total_attempts,
           SUM(CASE WHEN a.status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
           SUM(CASE WHEN a.status IN ('SUBMITTED','UNDER_REVIEW') THEN 1 ELSE 0 END) AS awaiting_release,
           SUM(CASE WHEN a.status = 'GRADED' THEN 1 ELSE 0 END) AS graded,
           (SELECT COUNT(*) FROM results r WHERE r.student_id = ? AND r.outcome = 'PASSED' AND r.is_published = 1) AS passed,
           (SELECT COUNT(*) FROM results r WHERE r.student_id = ? AND r.outcome = 'FAILED' AND r.is_published = 1) AS failed,
           (SELECT COALESCE(ROUND(AVG(r.percentage), 2), 0) FROM results r WHERE r.student_id = ? AND r.outcome != 'PENDING') AS average_percentage
         FROM attempts a WHERE a.student_id = ?`,
      )
      .get(studentId, studentId, studentId, studentId) as any;

    const unread = (
      db
        .prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL')
        .get(req.user!.id) as { c: number }
    ).c;

    return ok(res, {
      student,
      serverTime: now,
      stats: {
        ...stats,
        availableExams: availableExams.length,
        upcomingExams: upcomingExams.length,
        availableQuizzes: availableQuizzes.length,
      },
      availableExams,
      upcomingExams,
      availableQuizzes,
      recentResults,
      history,
      unreadNotifications: unread,
    });
  }),
);

router.get(
  '/teacher',
  requirePermission('exam.view', 'grading.grade'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const institutionId = req.user!.institutionId;
    if (!institutionId && req.user!.roleCode !== 'super_admin') throw forbidden();
    const scope = institutionId ?? -1;
    const userId = req.user!.id;
    const now = nowIso();
    const weekAhead = addDays(now, 7);

    const activeExams = db
      .prepare(
        `SELECT e.id, e.name, e.code, e.start_at, e.end_at, e.duration_minutes, e.total_marks, e.status,
                s.name AS subject_name, c.name AS class_name,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id) AS attempts,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status = 'IN_PROGRESS') AS live
           FROM exams e JOIN subjects s ON s.id = e.subject_id
           LEFT JOIN classes c ON c.id = e.class_id
          WHERE e.institution_id = ? AND e.status = 'ACTIVE'
            AND (e.created_by = ? OR ? = 'institution_admin' OR ? = 'super_admin')
          ORDER BY e.end_at ASC`,
      )
      .all(scope, userId, req.user!.roleCode, req.user!.roleCode);

    const upcomingExams = db
      .prepare(
        `SELECT e.id, e.name, e.code, e.start_at, e.status, s.name AS subject_name, c.name AS class_name,
                (SELECT COUNT(*) FROM exam_assignments ea WHERE ea.exam_id = e.id) AS assignments
           FROM exams e JOIN subjects s ON s.id = e.subject_id
           LEFT JOIN classes c ON c.id = e.class_id
          WHERE e.institution_id = ? AND e.status = 'SCHEDULED' AND e.start_at BETWEEN ? AND ?
          ORDER BY e.start_at ASC`,
      )
      .all(scope, now, weekAhead);

    const drafts = db
      .prepare(
        `SELECT e.id, e.name, e.code, e.start_at, e.updated_at, s.name AS subject_name,
                (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count
           FROM exams e JOIN subjects s ON s.id = e.subject_id
          WHERE e.institution_id = ? AND e.status = 'DRAFT'
            AND (e.created_by = ? OR ? IN ('institution_admin','super_admin'))
          ORDER BY e.updated_at DESC LIMIT 20`,
      )
      .all(scope, userId, req.user!.roleCode);

    const recentSubmissions = db
      .prepare(
        `SELECT a.id, a.status, a.submitted_at, a.obtained_marks, a.max_marks, a.percentage, a.auto_submitted,
                COALESCE(e.name, qz.title) AS paper_title, u.full_name AS student_name, s.student_code,
                CASE WHEN a.exam_id IS NOT NULL THEN 'EXAM' ELSE 'QUIZ' END AS kind,
                (SELECT COUNT(*) FROM answers an WHERE an.attempt_id = a.id AND an.awarded_marks IS NULL) AS ungraded
           FROM attempts a
           LEFT JOIN exams e ON e.id = a.exam_id
           LEFT JOIN quizzes qz ON qz.id = a.quiz_id
           JOIN students s ON s.id = a.student_id
           JOIN users u ON u.id = s.user_id
          WHERE a.institution_id = ? AND a.status IN ('SUBMITTED','UNDER_REVIEW','GRADED')
          ORDER BY a.submitted_at DESC LIMIT 12`,
      )
      .all(scope);

    const awaitingGrading = db
      .prepare(
        `SELECT COUNT(*) AS attempts,
                COALESCE(SUM((SELECT COUNT(*) FROM answers an WHERE an.attempt_id = a.id AND an.awarded_marks IS NULL)), 0) AS ungraded_answers
           FROM attempts a
          WHERE a.institution_id = ? AND a.status = 'UNDER_REVIEW'`,
      )
      .get(scope) as any;

    const examStats = db
      .prepare(
        `SELECT
           COUNT(DISTINCT e.id) AS total_exams,
           SUM(CASE WHEN e.status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN e.status = 'DRAFT' THEN 1 ELSE 0 END) AS draft,
           SUM(CASE WHEN e.status = 'PUBLISHED' THEN 1 ELSE 0 END) AS published
         FROM exams e WHERE e.institution_id = ?`,
      )
      .get(scope) as any;

    const averages = db
      .prepare(
        `SELECT COALESCE(ROUND(AVG(r.percentage), 2), 0) AS average_percentage,
                COUNT(*) AS graded_results
           FROM results r WHERE r.institution_id = ? AND r.outcome != 'PENDING'`,
      )
      .get(scope) as any;

    const questionBankStats = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM questions q WHERE q.institution_id = ? AND q.status = 'ACTIVE') AS active_questions,
           (SELECT COUNT(*) FROM questions q WHERE q.institution_id = ? AND q.created_by = ?) AS my_questions,
           (SELECT COUNT(*) FROM question_banks b WHERE b.institution_id = ?) AS banks,
           (SELECT COUNT(*) FROM questions q WHERE q.institution_id = ? AND q.difficulty = 'EASY') AS easy,
           (SELECT COUNT(*) FROM questions q WHERE q.institution_id = ? AND q.difficulty = 'MEDIUM') AS medium,
           (SELECT COUNT(*) FROM questions q WHERE q.institution_id = ? AND q.difficulty = 'HARD') AS hard`,
      )
      .get(scope, scope, userId, scope, scope, scope, scope) as any;

    const publishedResults = db
      .prepare(
        `SELECT COUNT(*) AS published,
                SUM(CASE WHEN r.outcome = 'PASSED' THEN 1 ELSE 0 END) AS passed,
                SUM(CASE WHEN r.outcome = 'FAILED' THEN 1 ELSE 0 END) AS failed
           FROM results r WHERE r.institution_id = ? AND r.is_published = 1`,
      )
      .get(scope) as any;

    const weeklyActivity = db
      .prepare(
        `SELECT substr(a.submitted_at, 1, 10) AS day, COUNT(*) AS submissions
           FROM attempts a
          WHERE a.institution_id = ? AND a.submitted_at IS NOT NULL AND a.submitted_at >= ?
          GROUP BY day ORDER BY day ASC`,
      )
      .all(scope, addDays(now, -13));

    return ok(res, {
      serverTime: now,
      scope: { institutionId: scope, role: req.user!.roleCode },
      activeExams,
      upcomingExams,
      drafts,
      recentSubmissions,
      awaitingGrading,
      examStats,
      averages,
      questionBankStats,
      publishedResults,
      weeklyActivity,
    });
  }),
);

router.get(
  '/admin',
  requirePermission('student.view', 'exam.view', 'result.view.any'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const institutionId = req.user!.institutionId;
    if (!institutionId && req.user!.roleCode !== 'super_admin') throw forbidden();
    const scope = institutionId ?? -1;
    const now = nowIso();

    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM students s WHERE s.institution_id = ? AND s.status = 'active') AS students,
           (SELECT COUNT(*) FROM teachers t WHERE t.institution_id = ? AND t.status = 'active') AS teachers,
           (SELECT COUNT(*) FROM subjects s WHERE s.institution_id = ? AND s.status = 'active') AS subjects,
           (SELECT COUNT(*) FROM classes c WHERE c.institution_id = ? AND c.status = 'active') AS classes,
           (SELECT COUNT(*) FROM departments d WHERE d.institution_id = ? AND d.status = 'active') AS departments,
           (SELECT COUNT(*) FROM exams e WHERE e.institution_id = ?) AS exams,
           (SELECT COUNT(*) FROM exams e WHERE e.institution_id = ? AND e.status = 'ACTIVE') AS active_exams,
           (SELECT COUNT(*) FROM exams e WHERE e.institution_id = ? AND e.status IN ('PUBLISHED','ARCHIVED')) AS completed_exams,
           (SELECT COUNT(*) FROM exams e WHERE e.institution_id = ? AND e.status = 'DRAFT') AS draft_exams,
           (SELECT COUNT(*) FROM questions q WHERE q.institution_id = ? AND q.status = 'ACTIVE') AS questions,
           (SELECT COUNT(*) FROM quizzes qz WHERE qz.institution_id = ?) AS quizzes,
           (SELECT COUNT(*) FROM attempts a WHERE a.institution_id = ? AND a.status = 'IN_PROGRESS') AS live_attempts,
           (SELECT COUNT(*) FROM attempts a WHERE a.institution_id = ? AND a.status = 'UNDER_REVIEW') AS awaiting_grading,
           (SELECT COUNT(*) FROM results r WHERE r.institution_id = ? AND r.is_published = 1) AS published_results,
           (SELECT COUNT(*) FROM results r WHERE r.institution_id = ? AND r.is_published = 0) AS withheld_results`,
      )
      .get(scope, scope, scope, scope, scope, scope, scope, scope, scope, scope, scope, scope, scope, scope, scope) as any;

    const passRate = db
      .prepare(
        `SELECT COUNT(*) AS graded,
                SUM(CASE WHEN outcome = 'PASSED' THEN 1 ELSE 0 END) AS passed,
                COALESCE(ROUND(AVG(percentage), 2), 0) AS average_percentage
           FROM results WHERE institution_id = ? AND outcome != 'PENDING'`,
      )
      .get(scope) as any;

    const recentActivity = db
      .prepare(
        `SELECT id, action, category, description, actor_name, actor_role, created_at, resource_type, resource_id
           FROM audit_logs WHERE institution_id = ? ORDER BY created_at DESC LIMIT 15`,
      )
      .all(scope);

    const performanceBySubject = db
      .prepare(
        `SELECT sub.name AS subject, COUNT(r.id) AS results,
                COALESCE(ROUND(AVG(r.percentage), 2), 0) AS average_percentage,
                SUM(CASE WHEN r.outcome = 'PASSED' THEN 1 ELSE 0 END) AS passed
           FROM subjects sub
           LEFT JOIN results r ON r.subject_id = sub.id AND r.outcome != 'PENDING'
          WHERE sub.institution_id = ?
          GROUP BY sub.id HAVING COUNT(r.id) > 0
          ORDER BY average_percentage DESC LIMIT 8`,
      )
      .all(scope);

    const gradeDistribution = db
      .prepare(
        `SELECT grade, COUNT(*) AS count FROM results
          WHERE institution_id = ? AND grade IS NOT NULL GROUP BY grade ORDER BY grade ASC`,
      )
      .all(scope);

    const submissionsByDay = db
      .prepare(
        `SELECT substr(a.submitted_at, 1, 10) AS day, COUNT(*) AS submissions
           FROM attempts a
          WHERE a.institution_id = ? AND a.submitted_at IS NOT NULL AND a.submitted_at >= ?
          GROUP BY day ORDER BY day ASC`,
      )
      .all(scope, addDays(now, -29));

    const classPerformance = db
      .prepare(
        `SELECT c.id, c.name AS class_name, COUNT(DISTINCT s.id) AS students,
                COALESCE(ROUND(AVG(r.percentage), 2), 0) AS average_percentage
           FROM classes c
           LEFT JOIN students s ON s.class_id = c.id AND s.status = 'active'
           LEFT JOIN results r ON r.student_id = s.id AND r.outcome != 'PENDING'
          WHERE c.institution_id = ? AND c.status = 'active'
          GROUP BY c.id ORDER BY average_percentage DESC LIMIT 8`,
      )
      .all(scope);

    return ok(res, {
      serverTime: now,
      counts,
      passRate: {
        ...passRate,
        passRate:
          passRate.graded > 0 ? Math.round((passRate.passed / passRate.graded) * 10000) / 100 : 0,
      },
      recentActivity,
      performanceBySubject,
      gradeDistribution,
      submissionsByDay,
      classPerformance,
    });
  }),
);

router.get(
  '/platform',
  requirePermission('platform.manage', 'institution.view_all'),
  asyncHandler(async (_req: AuthedRequest, res) => {
    const db = getDb();
    const now = nowIso();
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM institutions) AS institutions,
           (SELECT COUNT(*) FROM institutions WHERE status = 'active') AS active_institutions,
           (SELECT COUNT(*) FROM institutions WHERE is_demo = 1) AS demo_institutions,
           (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS users,
           (SELECT COUNT(*) FROM users WHERE status = 'active') AS active_users,
           (SELECT COUNT(*) FROM students) AS students,
           (SELECT COUNT(*) FROM teachers) AS teachers,
           (SELECT COUNT(*) FROM exams) AS exams,
           (SELECT COUNT(*) FROM exams WHERE status = 'ACTIVE') AS active_exams,
           (SELECT COUNT(*) FROM attempts) AS attempts,
           (SELECT COUNT(*) FROM attempts WHERE status = 'IN_PROGRESS') AS live_attempts,
           (SELECT COUNT(*) FROM questions) AS questions,
           (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at > ?) AS active_sessions`,
      )
      .get(now) as any;

    const loginActivity = db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful,
                SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
           FROM login_attempts WHERE created_at >= ? GROUP BY day ORDER BY day ASC`,
      )
      .all(addDays(now, -13));

    const institutionBreakdown = db
      .prepare(
        `SELECT i.id, i.name, i.code, i.status, i.is_demo,
                (SELECT COUNT(*) FROM students s WHERE s.institution_id = i.id) AS students,
                (SELECT COUNT(*) FROM teachers t WHERE t.institution_id = i.id) AS teachers,
                (SELECT COUNT(*) FROM exams e WHERE e.institution_id = i.id) AS exams,
                (SELECT COUNT(*) FROM attempts a WHERE a.institution_id = i.id) AS attempts
           FROM institutions i ORDER BY i.name`,
      )
      .all();

    const recentAudit = db
      .prepare(
        `SELECT id, action, category, description, actor_name, actor_role, institution_id, created_at
           FROM audit_logs ORDER BY created_at DESC LIMIT 20`,
      )
      .all();

    return ok(res, { serverTime: now, counts, loginActivity, institutionBreakdown, recentAudit });
  }),
);

export default router;
