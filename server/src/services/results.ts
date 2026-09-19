import type { Db } from '../db';
import { forbidden, notFound } from '../lib/errors';
import type { RoleCode } from '../types';

export interface ResultsActor {
  id: number;
  institutionId: number | null;
  roleCode: RoleCode;
  studentId: number | null;
}

export interface ResultFilters {
  search?: string;
  examId?: number;
  quizId?: number;
  subjectId?: number;
  classId?: number;
  outcome?: 'PASSED' | 'FAILED' | 'PENDING';
  published?: 'published' | 'unpublished';
  from?: string;
  to?: string;
}

const RESULT_SELECT = `
  SELECT r.id, r.attempt_id, r.institution_id, r.total_marks, r.obtained_marks, r.percentage, r.grade, r.outcome,
         r.is_published, r.published_at, r.updated_at, r.created_at,
         COALESCE(e.name, qz.title) AS paper_title,
         COALESCE(e.code, '') AS paper_code,
         CASE WHEN r.exam_id IS NOT NULL THEN 'EXAM' ELSE 'QUIZ' END AS kind,
         e.exam_type, e.academic_year, e.semester, e.start_at AS exam_date, e.pass_marks AS exam_pass_marks,
         qz.available_until AS quiz_date,
         u.full_name AS student_name, s.student_code, s.id AS student_id, c.name AS class_name,
         sub.name AS subject_name, sub.code AS subject_code,
         a.submitted_at, a.status AS attempt_status, a.auto_submitted, a.graded_by,
         gu.full_name AS examiner_name
    FROM results r
    JOIN attempts a ON a.id = r.attempt_id
    LEFT JOIN exams e ON e.id = r.exam_id
    LEFT JOIN quizzes qz ON qz.id = r.quiz_id
    JOIN students s ON s.id = r.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN classes c ON c.id = s.class_id
    LEFT JOIN subjects sub ON sub.id = r.subject_id
    LEFT JOIN users gu ON gu.id = a.graded_by
`;

function buildWhere(
  db: Db,
  actor: ResultsActor,
  filters: ResultFilters,
): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (actor.roleCode === 'student') {
    if (!actor.studentId) throw forbidden();
    where.push('r.student_id = ?');
    params.push(actor.studentId);
    // Candidates only ever see released results.
    where.push('r.is_published = 1');
  } else if (actor.roleCode !== 'super_admin') {
    where.push('r.institution_id = ?');
    params.push(actor.institutionId ?? -1);
  }

  if (filters.examId) {
    where.push('r.exam_id = ?');
    params.push(filters.examId);
  }
  if (filters.quizId) {
    where.push('r.quiz_id = ?');
    params.push(filters.quizId);
  }
  if (filters.subjectId) {
    where.push('r.subject_id = ?');
    params.push(filters.subjectId);
  }
  if (filters.classId) {
    where.push('s.class_id = ?');
    params.push(filters.classId);
  }
  if (filters.outcome) {
    where.push('r.outcome = ?');
    params.push(filters.outcome);
  }
  if (filters.published === 'published') where.push('r.is_published = 1');
  if (filters.published === 'unpublished') where.push('r.is_published = 0');
  if (filters.from) {
    where.push('COALESCE(a.submitted_at, r.created_at) >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    where.push('COALESCE(a.submitted_at, r.created_at) <= ?');
    params.push(filters.to);
  }
  if (filters.search) {
    where.push('(u.full_name LIKE ? OR s.student_code LIKE ? OR COALESCE(e.name, qz.title) LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`, `%${filters.search}%`);
  }

  void db;
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export function listResults(
  db: Db,
  actor: ResultsActor,
  filters: ResultFilters,
  pagination: { page: number; pageSize: number },
  sort: { column: string; order: 'asc' | 'desc' },
): { items: any[]; total: number } {
  const { sql, params } = buildWhere(db, actor, filters);
  const sortable: Record<string, string> = {
    student: 'u.full_name',
    paper: 'paper_title',
    percentage: 'r.percentage',
    date: 'COALESCE(a.submitted_at, r.created_at)',
    grade: 'r.grade',
    outcome: 'r.outcome',
  };
  const orderColumn = sortable[sort.column] ?? 'COALESCE(a.submitted_at, r.created_at)';

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM results r JOIN attempts a ON a.id = r.attempt_id
      JOIN students s ON s.id = r.student_id JOIN users u ON u.id = s.user_id
      LEFT JOIN exams e ON e.id = r.exam_id LEFT JOIN quizzes qz ON qz.id = r.quiz_id ${sql}`).get(...params) as {
    c: number;
  }).c;

  const items = db
    .prepare(
      `${RESULT_SELECT} ${sql} ORDER BY ${orderColumn} ${sort.order === 'asc' ? 'ASC' : 'DESC'}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as any[];

  return { items, total };
}

export function getResultDetail(db: Db, actor: ResultsActor, resultId: number): any {
  const row = db.prepare(`${RESULT_SELECT} WHERE r.id = ?`).get(resultId) as any;
  if (!row) throw notFound('Result not found.');

  if (actor.roleCode === 'student') {
    if (row.student_id !== actor.studentId) throw forbidden('You can only view your own results.');
    if (!row.is_published) throw forbidden('This result has not been released yet.');
  } else if (actor.roleCode !== 'super_admin' && row.institution_id !== actor.institutionId) {
    throw forbidden('You do not have permission to view this result.');
  }

  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(row.attempt_id) as any;
  if (!attempt) throw notFound('Attempt not found.');
  if (actor.roleCode !== 'super_admin' && actor.roleCode !== 'student' && attempt.institution_id !== actor.institutionId) {
    throw forbidden('You do not have permission to view this result.');
  }
  if (actor.roleCode === 'teacher' && attempt.exam_id) {
    const exam = db.prepare('SELECT created_by FROM exams WHERE id = ?').get(attempt.exam_id) as
      | { created_by: number }
      | undefined;
    if (exam && exam.created_by !== actor.id) {
      const allowed = db
        .prepare(
          `SELECT COUNT(*) AS c FROM class_subjects cs JOIN teachers t ON t.id = cs.teacher_id
            WHERE t.user_id = ? AND cs.class_id = (SELECT class_id FROM exams WHERE id = ?)`,
        )
        .get(actor.id, attempt.exam_id) as { c: number };
      if (!allowed.c) throw forbidden('You can only view results for examinations you own or teach.');
    }
  }

  const questions = db
    .prepare(
      `SELECT aq.question_id, aq.position, aq.question_type, aq.question_text, aq.marks, aq.is_objective,
              aq.correct_answer, aq.snapshot,
              an.selected_options, an.answer_text, an.is_correct, an.awarded_marks, an.comment
         FROM attempt_questions aq
         LEFT JOIN answers an ON an.attempt_id = aq.attempt_id AND an.question_id = aq.question_id
        WHERE aq.attempt_id = ?
        ORDER BY aq.position ASC`,
    )
    .all(row.attempt_id) as any[];

  // Candidates see the question-level breakdown only when the paper allows review;
  // correct answers are further gated on the "show correct answers" setting.
  const quizConfig =
    row.kind === 'QUIZ'
      ? (db.prepare('SELECT allow_review, show_correct_answers FROM quizzes WHERE id = ?').get(row.quiz_id) as
          | { allow_review: number; show_correct_answers: number }
          | undefined)
      : undefined;
  const isStaff = actor.roleCode !== 'student';
  const canReview = isStaff || row.kind === 'EXAM' || Boolean(quizConfig?.allow_review);
  const canShowAnswers = isStaff || row.kind === 'EXAM' || Boolean(quizConfig?.show_correct_answers);

  return {
    result: {
      id: row.id,
      attemptId: row.attempt_id,
      studentName: row.student_name,
      studentCode: row.student_code,
      className: row.class_name,
      subjectName: row.subject_name,
      paperTitle: row.paper_title,
      paperCode: row.paper_code,
      kind: row.kind,
      examType: row.exam_type,
      academicYear: row.academic_year,
      semester: row.semester,
      examDate: row.exam_date ?? row.quiz_date,
      submittedAt: row.submitted_at,
      totalMarks: row.total_marks,
      obtainedMarks: row.obtained_marks,
      percentage: row.percentage,
      grade: row.grade,
      outcome: row.outcome,
      isPublished: Boolean(row.is_published),
      publishedAt: row.published_at,
      examinerName: row.examiner_name,
      attemptStatus: row.attempt_status,
      autoSubmitted: Boolean(row.auto_submitted),
      objectiveMarks: attempt.objective_marks,
      subjectiveMarks: attempt.subjective_marks,
      integrityFlags: JSON.parse(attempt.integrity_flags ?? '[]'),
      passMarks: row.exam_pass_marks ?? null,
    },
    breakdown: canReview
      ? questions.map((q) => ({
          questionId: q.question_id,
          position: q.position,
          type: q.question_type,
          text: q.question_text,
          marks: q.marks,
          objective: Boolean(q.is_objective),
          options: (JSON.parse(q.snapshot).options ?? []) as { label: string; text: string }[],
          answerText: q.answer_text,
          selectedOptions: JSON.parse(q.selected_options ?? '[]') as string[],
          awardedMarks: q.awarded_marks,
          isCorrect: q.is_correct === null ? null : Boolean(q.is_correct),
          comment: q.comment,
          correctAnswer: canShowAnswers
            ? (JSON.parse(q.correct_answer ?? '{}') as Record<string, unknown>)
            : null,
          explanation: canShowAnswers ? JSON.parse(q.snapshot).explanation ?? null : null,
        }))
      : [],
  };
}

export interface ResultStats {
  attempts: number;
  passed: number;
  failed: number;
  pending: number;
  averagePercentage: number;
  highestPercentage: number;
  lowestPercentage: number;
  published: number;
}

export function resultStats(db: Db, actor: ResultsActor, filters: ResultFilters): ResultStats {
  const { sql, params } = buildWhere(db, actor, filters);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS attempts,
         SUM(CASE WHEN r.outcome = 'PASSED' THEN 1 ELSE 0 END) AS passed,
         SUM(CASE WHEN r.outcome = 'FAILED' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN r.outcome = 'PENDING' THEN 1 ELSE 0 END) AS pending,
         COALESCE(AVG(r.percentage), 0) AS average_percentage,
         COALESCE(MAX(r.percentage), 0) AS highest,
         COALESCE(MIN(r.percentage), 0) AS lowest,
         SUM(CASE WHEN r.is_published = 1 THEN 1 ELSE 0 END) AS published
       FROM results r
       JOIN attempts a ON a.id = r.attempt_id
       JOIN students s ON s.id = r.student_id
       JOIN users u ON u.id = s.user_id
       LEFT JOIN exams e ON e.id = r.exam_id
       LEFT JOIN quizzes qz ON qz.id = r.quiz_id
       ${sql}`,
    )
    .get(...params) as any;

  return {
    attempts: row.attempts ?? 0,
    passed: row.passed ?? 0,
    failed: row.failed ?? 0,
    pending: row.pending ?? 0,
    averagePercentage: Math.round((row.average_percentage ?? 0) * 100) / 100,
    highestPercentage: row.highest ?? 0,
    lowestPercentage: row.lowest ?? 0,
    published: row.published ?? 0,
  };
}
