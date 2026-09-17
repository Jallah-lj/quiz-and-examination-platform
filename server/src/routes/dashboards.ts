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

/**
 * Charts must show a continuous range: a day without submissions is a real zero, not a
 * gap in the line. Every value still comes from the database — only empty days are added.
 */
function fillDailySeries(
  rows: Record<string, unknown>[],
  days: number,
  now: string,
  emptyColumns: Record<string, number | string> = {},
): Record<string, unknown>[] {
  const byDay = new Map(rows.map((row) => [String(row.day), row]));
  const series: Record<string, unknown>[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = addDays(now, -offset).slice(0, 10);
    series.push(byDay.get(day) ?? { day, ...emptyColumns });
  }
  return series;
}

/** Percentage change between two periods; null when the previous period was empty. */
function changePercent(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 10000) / 100;
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

    // Where the candidate stands per subject, from released results only — the same
    // figures their institution publishes, never an internal estimate.
    const subjectPerformance = db
      .prepare(
        `SELECT s.name AS subject, COUNT(r.id) AS results,
                COALESCE(ROUND(AVG(r.percentage), 2), 0) AS average_percentage,
                SUM(CASE WHEN r.outcome = 'PASSED' THEN 1 ELSE 0 END) AS passed,
                MAX(r.percentage) AS best_percentage
           FROM results r JOIN subjects s ON s.id = r.subject_id
          WHERE r.student_id = ? AND r.is_published = 1 AND r.outcome != 'PENDING'
          GROUP BY s.id ORDER BY average_percentage DESC`,
      )
      .all(studentId);

    // Progress over time: released results in the order they were earned.
    const scoreTrend = db
      .prepare(
        `SELECT COALESCE(a.submitted_at, r.created_at) AS at,
                r.percentage, r.grade, COALESCE(e.name, qz.title) AS paper_title
           FROM results r
           JOIN attempts a ON a.id = r.attempt_id
           LEFT JOIN exams e ON e.id = r.exam_id
           LEFT JOIN quizzes qz ON qz.id = r.quiz_id
          WHERE r.student_id = ? AND r.is_published = 1 AND r.outcome != 'PENDING'
          ORDER BY at ASC LIMIT 20`,
      )
      .all(studentId) as { at: string; percentage: number; grade: string | null; paper_title: string }[];

    const bestPercentage = (
      db
        .prepare(
          `SELECT COALESCE(MAX(percentage), 0) AS best FROM results
            WHERE student_id = ? AND is_published = 1 AND outcome != 'PENDING'`,
        )
        .get(studentId) as { best: number }
    ).best;
    const openAttempts = (
      db
        .prepare("SELECT COUNT(*) AS c FROM attempts WHERE student_id = ? AND status = 'IN_PROGRESS'")
        .get(studentId) as { c: number }
    ).c;

    // The single next thing with a deadline, so the candidate always knows what is next.
    const candidates = [
      ...availableExams.map((exam) => ({
        kind: 'EXAM' as const,
        id: exam.id,
        title: exam.name,
        paper_code: exam.code as string | null,
        subject_name: exam.subject_name as string | null,
        due_at: exam.end_at as string,
        start_at: exam.start_at as string,
        action: openAttempts > 0 ? ('resume' as const) : ('start' as const),
      })),
      ...availableQuizzes.map((quiz) => ({
        kind: 'QUIZ' as const,
        id: quiz.id,
        title: quiz.title,
        paper_code: null,
        subject_name: quiz.subject_name as string | null,
        due_at: quiz.available_until as string,
        start_at: quiz.available_from as string,
        action: 'start' as const,
      })),
    ].sort((a, b) => a.due_at.localeCompare(b.due_at));
    const nextDeadline = candidates[0] ?? null;

    const limitReached = [
      ...availableExams
        .filter((exam) => exam.my_attempts >= exam.max_attempts && !exam.in_progress)
        .map((exam) => ({ kind: 'EXAM' as const, id: exam.id, title: exam.name })),
      ...availableQuizzes
        .filter((quiz) => quiz.my_attempts >= quiz.max_attempts)
        .map((quiz) => ({ kind: 'QUIZ' as const, id: quiz.id, title: quiz.title })),
    ];

    const attention = [
      openAttempts > 0
        ? {
            key: 'resume',
            severity: 'warning' as const,
            title: `${openAttempts} attempt(s) still running`,
            detail: 'The server clock keeps running whether or not the page is open. Resume to continue answering.',
            link: '/my-attempts',
          }
        : null,
      stats.awaiting_release > 0
        ? {
            key: 'awaiting',
            severity: 'info' as const,
            title: `${stats.awaiting_release} submitted attempt(s) not yet released`,
            detail: 'Written answers are marked by your examiners; results appear once the institution publishes them.',
            link: '/my-attempts',
          }
        : null,
      limitReached.length > 0
        ? {
            key: 'limits',
            severity: 'info' as const,
            title: `${limitReached.length} assessment(s) at the attempt limit`,
            detail: `You have used every permitted attempt: ${limitReached
              .slice(0, 3)
              .map((item) => item.title)
              .join(', ')}${limitReached.length > 3 ? '…' : ''}.`,
            link: '/my-attempts',
          }
        : null,
      stats.graded > 0 && stats.passed === 0
        ? {
            key: 'support',
            severity: 'warning' as const,
            title: 'No passes in your released results yet',
            detail: 'Review the feedback on each result and speak to your subject examiner about support.',
            link: '/results',
          }
        : null,
    ].filter(Boolean);

    return ok(res, {
      student,
      serverTime: now,
      stats: {
        ...stats,
        best_percentage: bestPercentage,
        availableExams: availableExams.length,
        upcomingExams: upcomingExams.length,
        availableQuizzes: availableQuizzes.length,
      },
      attention,
      nextDeadline,
      subjectPerformance,
      scoreTrend: scoreTrend.map((row) => ({
        ...row,
        label: String(row.at ?? '').slice(5, 10),
      })),
      limitReached,
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
                (SELECT r.grade FROM results r WHERE r.attempt_id = a.id) AS grade,
                (SELECT r.is_published FROM results r WHERE r.attempt_id = a.id) AS is_published,
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
      .all(scope, addDays(now, -13)) as Record<string, unknown>[];

    // Papers this examiner owns, with their outcomes — the fastest way to spot a paper
    // whose cohort is struggling or that nobody has sat yet.
    const examPerformance = db
      .prepare(
        `SELECT e.id, e.name, e.code, e.status, e.total_marks, e.pass_marks, s.name AS subject_name,
                c.name AS class_name,
                (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count,
                (SELECT COUNT(*) FROM exam_assignments ea WHERE ea.exam_id = e.id) AS assignment_count,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status != 'VOID') AS attempts,
                (SELECT COALESCE(ROUND(AVG(r.percentage), 2), 0) FROM results r
                  WHERE r.exam_id = e.id AND r.outcome != 'PENDING') AS average_percentage,
                (SELECT COALESCE(ROUND(
                        100.0 * SUM(CASE WHEN r.outcome = 'PASSED' THEN 1 ELSE 0 END) /
                        NULLIF(COUNT(CASE WHEN r.outcome != 'PENDING' THEN 1 END), 0), 2), 0)
                   FROM results r WHERE r.exam_id = e.id) AS pass_rate
           FROM exams e JOIN subjects s ON s.id = e.subject_id
           LEFT JOIN classes c ON c.id = e.class_id
          WHERE e.institution_id = ? AND (e.created_by = ? OR ? IN ('institution_admin','super_admin'))
          ORDER BY CASE e.status
                     WHEN 'ACTIVE' THEN 0 WHEN 'UNDER_REVIEW' THEN 1 WHEN 'SCHEDULED' THEN 2
                     WHEN 'DRAFT' THEN 3 ELSE 4 END,
                   e.start_at DESC
          LIMIT 8`,
      )
      .all(scope, userId, req.user!.roleCode);

    // How long the oldest unmarked answer has been waiting, and who is waiting on it.
    const gradingBacklog = db
      .prepare(
        `SELECT MIN(a.submitted_at) AS oldest_submission,
                COUNT(DISTINCT a.id) AS attempts,
                COUNT(*) AS ungraded_answers
           FROM attempts a
           JOIN attempt_questions aq ON aq.attempt_id = a.id AND aq.is_objective = 0
           LEFT JOIN answers an ON an.attempt_id = a.id AND an.question_id = aq.question_id
          WHERE a.institution_id = ? AND a.status IN ('SUBMITTED','UNDER_REVIEW')
            AND (an.id IS NULL OR an.awarded_marks IS NULL)`,
      )
      .get(scope) as any;

    const paperHealth = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM exams e WHERE e.institution_id = ? AND e.status IN ('DRAFT','SCHEDULED')
              AND (e.created_by = ? OR ? IN ('institution_admin','super_admin'))
              AND NOT EXISTS (SELECT 1 FROM exam_questions eq WHERE eq.exam_id = e.id)) AS exams_without_questions,
           (SELECT COUNT(*) FROM exams e WHERE e.institution_id = ? AND e.status = 'SCHEDULED'
              AND (e.created_by = ? OR ? IN ('institution_admin','super_admin'))
              AND NOT EXISTS (SELECT 1 FROM exam_assignments ea WHERE ea.exam_id = e.id)) AS scheduled_without_candidates,
           (SELECT COUNT(*) FROM exams e WHERE e.institution_id = ? AND e.status = 'ACTIVE'
              AND (e.created_by = ? OR ? IN ('institution_admin','super_admin'))
              AND e.end_at BETWEEN ? AND ?) AS exams_ending_soon`,
      )
      .get(
        scope, userId, req.user!.roleCode,
        scope, userId, req.user!.roleCode,
        scope, userId, req.user!.roleCode, now, addDays(now, 1),
      ) as any;

    const questionsMissingExplanation = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM questions q
            WHERE q.institution_id = ? AND q.status = 'ACTIVE' AND q.created_by = ?
              AND (q.explanation IS NULL OR TRIM(q.explanation) = '')`,
        )
        .get(scope, userId) as { c: number }
    ).c;

    const attention = [
      gradingBacklog.ungraded_answers > 0
        ? {
            key: 'grading',
            severity: 'warning' as const,
            title: `${gradingBacklog.ungraded_answers} written answer(s) awaiting your marking`,
            detail: gradingBacklog.oldest_submission
              ? `Oldest submission received ${gradingBacklog.oldest_submission.slice(0, 16).replace('T', ' ')} UTC.`
              : 'Results cannot be published until every written answer is marked.',
            link: '/grading',
          }
        : null,
      drafts.length > 0
        ? {
            key: 'drafts',
            severity: 'info' as const,
            title: `${drafts.length} draft paper(s)`,
            detail: 'Complete the questions, then schedule the paper to open it to candidates.',
            link: '/examinations?status=DRAFT',
          }
        : null,
      paperHealth.exams_without_questions > 0
        ? {
            key: 'no-questions',
            severity: 'danger' as const,
            title: `${paperHealth.exams_without_questions} paper(s) have no questions`,
            detail: 'A paper with no questions cannot be scheduled.',
            link: '/examinations?status=DRAFT',
          }
        : null,
      paperHealth.scheduled_without_candidates > 0
        ? {
            key: 'unassigned',
            severity: 'warning' as const,
            title: `${paperHealth.scheduled_without_candidates} scheduled paper(s) without candidates`,
            detail: 'Assign a class, group or individual candidate before it opens.',
            link: '/examinations?status=SCHEDULED',
          }
        : null,
      paperHealth.exams_ending_soon > 0
        ? {
            key: 'ending',
            severity: 'warning' as const,
            title: `${paperHealth.exams_ending_soon} paper(s) close within 24 hours`,
            detail: 'Use the live monitor to watch submissions arrive and auto-submit on expiry.',
            link: '/examinations?status=ACTIVE',
          }
        : null,
      questionsMissingExplanation > 0
        ? {
            key: 'explanations',
            severity: 'info' as const,
            title: `${questionsMissingExplanation} of your questions have no explanation`,
            detail: 'Explanations are shown to candidates during review when the paper allows it.',
            link: '/questions?mine=true&missingExplanation=true',
          }
        : null,
    ].filter(Boolean);

    return ok(res, {
      serverTime: now,
      scope: { institutionId: scope, role: req.user!.roleCode },
      attention,
      gradingBacklog,
      paperHealth,
      examPerformance,
      activeExams,
      upcomingExams,
      drafts,
      recentSubmissions,
      awaitingGrading,
      examStats,
      averages,
      questionBankStats,
      publishedResults,
      weeklyActivity: fillDailySeries(weeklyActivity, 14, now, { submissions: 0 }),
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
      .all(scope, addDays(now, -29)) as Record<string, unknown>[];

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

    // Examination pipeline: where every paper currently sits in its lifecycle.
    const examPipeline = db
      .prepare(
        `SELECT e.status, COUNT(*) AS count,
                SUM(CASE WHEN e.start_at <= ? AND e.end_at >= ? THEN 1 ELSE 0 END) AS window_open
           FROM exams e WHERE e.institution_id = ?
          GROUP BY e.status`,
      )
      .all(now, now, scope);

    // Papers opening in the next fortnight, with delivery readiness.
    const upcomingExams = db
      .prepare(
        `SELECT e.id, e.name, e.code, e.status, e.start_at, e.end_at, e.duration_minutes, e.total_marks,
                e.max_attempts, s.name AS subject_name, c.name AS class_name,
                (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) AS question_count,
                (SELECT COUNT(*) FROM exam_assignments ea WHERE ea.exam_id = e.id) AS assignment_count
           FROM exams e
           JOIN subjects s ON s.id = e.subject_id
           LEFT JOIN classes c ON c.id = e.class_id
          WHERE e.institution_id = ? AND e.status IN ('DRAFT','SCHEDULED')
            AND e.end_at >= ?
          ORDER BY e.start_at ASC LIMIT 8`,
      )
      .all(scope, now);

    // Result of the most recently concluded papers, so administrators see outcomes not counts.
    const examPerformance = db
      .prepare(
        `SELECT e.id, e.name, e.code, e.status, e.total_marks, e.pass_marks, s.name AS subject_name,
                (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status != 'VOID') AS attempts,
                (SELECT COUNT(*) FROM results r WHERE r.exam_id = e.id AND r.is_published = 1) AS published,
                (SELECT COALESCE(ROUND(AVG(r.percentage), 2), 0) FROM results r
                  WHERE r.exam_id = e.id AND r.outcome != 'PENDING') AS average_percentage,
                (SELECT COALESCE(ROUND(
                        100.0 * SUM(CASE WHEN r.outcome = 'PASSED' THEN 1 ELSE 0 END) /
                        NULLIF(COUNT(CASE WHEN r.outcome != 'PENDING' THEN 1 END), 0), 2), 0)
                   FROM results r WHERE r.exam_id = e.id) AS pass_rate
           FROM exams e JOIN subjects s ON s.id = e.subject_id
          WHERE e.institution_id = ? AND e.status IN ('ACTIVE','UNDER_REVIEW','PUBLISHED')
          ORDER BY COALESCE(e.published_at, e.end_at) DESC LIMIT 6`,
      )
      .all(scope);

    // Candidates whose released results put them below the pass mark, worst first.
    const atRiskStudents = db
      .prepare(
        `SELECT s.id, s.student_code, u.full_name, c.name AS class_name,
                COUNT(r.id) AS graded_results,
                COALESCE(ROUND(AVG(r.percentage), 2), 0) AS average_percentage
           FROM results r
           JOIN students s ON s.id = r.student_id
           JOIN users u ON u.id = s.user_id
           LEFT JOIN classes c ON c.id = s.class_id
          WHERE r.institution_id = ? AND r.is_published = 1 AND r.outcome != 'PENDING'
          GROUP BY s.id
         HAVING COUNT(r.id) >= 2 AND AVG(r.percentage) < 50
          ORDER BY average_percentage ASC LIMIT 6`,
      )
      .all(scope);

    // Subjective answers still waiting for an examiner, and how long the oldest has waited.
    const gradingBacklog = db
      .prepare(
        `SELECT COUNT(*) AS ungraded_answers,
                COUNT(DISTINCT a.id) AS attempts,
                MIN(a.submitted_at) AS oldest_waiting
           FROM attempts a
           JOIN attempt_questions aq ON aq.attempt_id = a.id AND aq.is_objective = 0
           LEFT JOIN answers an ON an.attempt_id = a.id AND an.question_id = aq.question_id
          WHERE a.institution_id = ? AND a.status IN ('SUBMITTED','UNDER_REVIEW')
            AND (an.id IS NULL OR an.awarded_marks IS NULL)`,
      )
      .get(scope) as any;

    const paperIntegrity = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM exams e WHERE e.institution_id = ? AND e.status IN ('DRAFT','SCHEDULED')
              AND NOT EXISTS (SELECT 1 FROM exam_questions eq WHERE eq.exam_id = e.id)) AS exams_without_questions,
           (SELECT COUNT(*) FROM exams e WHERE e.institution_id = ? AND e.status = 'SCHEDULED'
              AND EXISTS (SELECT 1 FROM exam_questions eq WHERE eq.exam_id = e.id)
              AND NOT EXISTS (SELECT 1 FROM exam_assignments ea WHERE ea.exam_id = e.id)) AS scheduled_without_candidates,
           (SELECT COUNT(*) FROM users u WHERE u.institution_id = ? AND u.status = 'pending' AND u.deleted_at IS NULL) AS pending_accounts,
           (SELECT COUNT(*) FROM exams e WHERE e.institution_id = ? AND e.status = 'ACTIVE'
              AND e.end_at BETWEEN ? AND ?) AS exams_ending_soon`,
      )
      .get(scope, scope, scope, scope, now, addDays(now, 1)) as any;

    // Period-over-period movement, so the headline numbers can show direction.
    const submissionsRecent = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM attempts a
            WHERE a.institution_id = ? AND a.submitted_at IS NOT NULL AND a.submitted_at >= ?`,
        )
        .get(scope, addDays(now, -14)) as { c: number }
    ).c;
    const submissionsPrevious = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM attempts a
            WHERE a.institution_id = ? AND a.submitted_at IS NOT NULL
              AND a.submitted_at >= ? AND a.submitted_at < ?`,
        )
        .get(scope, addDays(now, -28), addDays(now, -14)) as { c: number }
    ).c;
    const resultsRecent = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM results r
            WHERE r.institution_id = ? AND r.is_published = 1 AND r.created_at >= ?`,
        )
        .get(scope, addDays(now, -30)) as { c: number }
    ).c;
    const resultsPrevious = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM results r
            WHERE r.institution_id = ? AND r.is_published = 1
              AND r.created_at >= ? AND r.created_at < ?`,
        )
        .get(scope, addDays(now, -60), addDays(now, -30)) as { c: number }
    ).c;

    // Each entry maps to a screen that is already filtered for that work.
    const attention = [
      gradingBacklog.ungraded_answers > 0
        ? {
            key: 'grading',
            severity: 'warning' as const,
            title: `${gradingBacklog.ungraded_answers} written answer(s) awaiting marking`,
            detail:
              gradingBacklog.attempts > 0
                ? `${gradingBacklog.attempts} submission(s) in review. Results stay withheld until every written answer is marked.`
                : 'Results stay withheld until every written answer is marked.',
            link: '/grading',
          }
        : null,
      counts.withheld_results > 0
        ? {
            key: 'withheld',
            severity: 'info' as const,
            title: `${counts.withheld_results} result(s) withheld`,
            detail: 'Graded and ready, but not yet visible to candidates.',
            link: '/results',
          }
        : null,
      counts.draft_exams > 0
        ? {
            key: 'drafts',
            severity: 'info' as const,
            title: `${counts.draft_exams} examination draft(s)`,
            detail: 'Drafts must be scheduled before candidates can sit them.',
            link: '/examinations?status=DRAFT',
          }
        : null,
      paperIntegrity.exams_without_questions > 0
        ? {
            key: 'no-questions',
            severity: 'danger' as const,
            title: `${paperIntegrity.exams_without_questions} paper(s) without questions`,
            detail: 'A paper cannot be scheduled until questions are added.',
            link: '/examinations?status=DRAFT',
          }
        : null,
      paperIntegrity.scheduled_without_candidates > 0
        ? {
            key: 'unassigned',
            severity: 'warning' as const,
            title: `${paperIntegrity.scheduled_without_candidates} scheduled paper(s) without candidates`,
            detail: 'No class, group or candidate is assigned, so nobody can start it.',
            link: '/examinations?status=SCHEDULED',
          }
        : null,
      paperIntegrity.exams_ending_soon > 0
        ? {
            key: 'ending',
            severity: 'warning' as const,
            title: `${paperIntegrity.exams_ending_soon} examination(s) close within 24 hours`,
            detail: 'Check that every candidate has submitted and monitor live attempts.',
            link: '/examinations?status=ACTIVE',
          }
        : null,
      paperIntegrity.pending_accounts > 0
        ? {
            key: 'pending',
            severity: 'info' as const,
            title: `${paperIntegrity.pending_accounts} account(s) awaiting approval`,
            detail: 'Self-registered accounts cannot sign in until an administrator activates them.',
            link: '/users?status=pending',
          }
        : null,
    ].filter(Boolean);

    return ok(res, {
      serverTime: now,
      counts,
      passRate: {
        ...passRate,
        passRate:
          passRate.graded > 0 ? Math.round((passRate.passed / passRate.graded) * 10000) / 100 : 0,
      },
      attention,
      gradingBacklog,
      paperIntegrity,
      examPipeline,
      upcomingExams,
      examPerformance,
      atRiskStudents,
      deltas: {
        submissions: {
          current: submissionsRecent,
          previous: submissionsPrevious,
          days: 14,
          changePercent: changePercent(submissionsRecent, submissionsPrevious),
        },
        publishedResults: {
          current: resultsRecent,
          previous: resultsPrevious,
          days: 30,
          changePercent: changePercent(resultsRecent, resultsPrevious),
        },
      },
      recentActivity,
      performanceBySubject,
      gradeDistribution,
      submissionsByDay: fillDailySeries(submissionsByDay, 30, now, { submissions: 0 }),
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

    const loginActivity = fillDailySeries(
      db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS day,
                  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful,
                  SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
             FROM login_attempts WHERE created_at >= ? GROUP BY day ORDER BY day ASC`,
        )
        .all(addDays(now, -13)) as Record<string, unknown>[],
      14,
      now,
      { successful: 0, failed: 0 },
    );

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

    // Account and institution health, aggregated by their stored status values.
    const accountMix = db
      .prepare(
        `SELECT u.status, COUNT(*) AS count FROM users u WHERE u.deleted_at IS NULL GROUP BY u.status ORDER BY count DESC`,
      )
      .all() as Record<string, unknown>[];

    const institutionStatus = db
      .prepare(`SELECT i.status, COUNT(*) AS count FROM institutions i GROUP BY i.status ORDER BY count DESC`)
      .all() as Record<string, unknown>[];

    const submissionsByDay = fillDailySeries(
      db
        .prepare(
          `SELECT substr(a.submitted_at, 1, 10) AS day, COUNT(*) AS submissions
             FROM attempts a WHERE a.submitted_at IS NOT NULL AND a.submitted_at >= ?
            GROUP BY day ORDER BY day ASC`,
        )
        .all(addDays(now, -29)) as Record<string, unknown>[],
      30,
      now,
      { submissions: 0 },
    );

    // Period-over-period movement for the two figures an operator watches day to day.
    const submissionsRecent = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM attempts a WHERE a.submitted_at IS NOT NULL AND a.submitted_at >= ?`)
        .get(addDays(now, -14)) as { c: number }
    ).c;
    const submissionsPrevious = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM attempts a
            WHERE a.submitted_at IS NOT NULL AND a.submitted_at >= ? AND a.submitted_at < ?`,
        )
        .get(addDays(now, -28), addDays(now, -14)) as { c: number }
    ).c;
    const signupsRecent = (
      db.prepare(`SELECT COUNT(*) AS c FROM users u WHERE u.created_at >= ?`).get(addDays(now, -30)) as { c: number }
    ).c;
    const signupsPrevious = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM users u WHERE u.created_at >= ? AND u.created_at < ?`)
        .get(addDays(now, -60), addDays(now, -30)) as { c: number }
    ).c;

    const deltas = {
      submissions: {
        current: submissionsRecent,
        previous: submissionsPrevious,
        days: 14,
        changePercent: changePercent(submissionsRecent, submissionsPrevious),
      },
      signups: {
        current: signupsRecent,
        previous: signupsPrevious,
        days: 30,
        changePercent: changePercent(signupsRecent, signupsPrevious),
      },
    };

    // Platform-wide exceptions: the states an operator must act on.
    const suspendedInstitutions = (
      db.prepare(`SELECT COUNT(*) AS c FROM institutions i WHERE i.status != 'active'`).get() as { c: number }
    ).c;
    const institutionsWithoutAdmin = (
      db
        .prepare(
          // The internal platform office hosts platform staff rather than a tenant, so it
          // is expected to have no institution administrator.
          `SELECT COUNT(*) AS c FROM institutions i
            WHERE i.status = 'active' AND i.code != 'PLATFORM'
              AND NOT EXISTS (SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id
                               WHERE u.institution_id = i.id AND r.code = 'institution_admin'
                                 AND u.status = 'active' AND u.deleted_at IS NULL)`,
        )
        .get() as { c: number }
    ).c;
    const pendingAccounts = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM users u WHERE u.status = 'pending' AND u.deleted_at IS NULL`)
        .get() as { c: number }
    ).c;
    const lockedAccounts = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM users u
            WHERE u.deleted_at IS NULL AND (u.status = 'suspended' OR (u.locked_until IS NOT NULL AND u.locked_until > ?))`,
        )
        .get(now) as { c: number }
    ).c;
    const failedSignIns24h = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM login_attempts l WHERE l.success = 0 AND l.created_at >= ?`)
        .get(addDays(now, -1)) as { c: number }
    ).c;

    const attention = [
      suspendedInstitutions > 0
        ? {
            key: 'suspended-institutions',
            severity: 'danger' as const,
            title: `${suspendedInstitutions} institution(s) are not active`,
            detail: 'Suspended or archived institutions cannot sign in. Review their status before candidates are affected.',
            link: '/institutions',
          }
        : null,
      institutionsWithoutAdmin > 0
        ? {
            key: 'institutions-without-admin',
            severity: 'warning' as const,
            title: `${institutionsWithoutAdmin} active institution(s) have no administrator`,
            detail: 'An institution without an active administrator account cannot manage its own users or examinations.',
            link: '/institutions',
          }
        : null,
      pendingAccounts > 0
        ? {
            key: 'pending-accounts',
            severity: 'warning' as const,
            title: `${pendingAccounts} account(s) awaiting approval`,
            detail: 'These registrations stay inactive until an administrator approves them.',
            link: '/users?status=pending',
          }
        : null,
      failedSignIns24h > 0
        ? {
            key: 'failed-signins',
            severity: 'info' as const,
            title: `${failedSignIns24h} failed sign-in attempt(s) in the last 24 hours`,
            detail: 'Repeated failures against one account trigger a temporary lockout and are recorded in the audit log.',
            link: '/audit-logs',
          }
        : null,
      lockedAccounts > 0
        ? {
            key: 'locked-accounts',
            severity: 'info' as const,
            title: `${lockedAccounts} account(s) suspended or locked out`,
            detail: 'Locked accounts regain access when the lockout expires; suspended accounts require an administrator.',
            link: '/users?status=suspended',
          }
        : null,
    ].filter(Boolean);

    return ok(res, {
      serverTime: now,
      counts,
      attention,
      deltas,
      loginActivity,
      accountMix,
      institutionStatus,
      submissionsByDay,
      institutionBreakdown,
      recentAudit,
    });
  }),
);

export default router;
