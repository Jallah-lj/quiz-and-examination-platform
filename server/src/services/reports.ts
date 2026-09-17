/**
 * Reporting layer. Every report is computed from live database records with plain
 * SQL aggregation — there are no synthetic or estimated figures.
 */
import type { Db } from '../db';
import { forbidden, notFound } from '../lib/errors';
import type { ReportTable } from '../lib/exporters';
import { nowIso } from '../lib/time';
import type { RoleCode } from '../types';

export interface ReportActor {
  id: number;
  institutionId: number | null;
  roleCode: RoleCode;
  studentId: number | null;
  fullName: string;
}

function institutionOf(db: Db, actor: ReportActor): { id: number; name: string } {
  if (actor.roleCode === 'super_admin') {
    const first = db.prepare('SELECT id, name FROM institutions ORDER BY id LIMIT 1').get() as
      | { id: number; name: string }
      | undefined;
    if (!first) throw notFound('No institution found.');
    return first;
  }
  if (!actor.institutionId) throw forbidden('You are not attached to an institution.');
  const row = db.prepare('SELECT id, name FROM institutions WHERE id = ?').get(actor.institutionId) as
    | { id: number; name: string }
    | undefined;
  if (!row) throw notFound('Institution not found.');
  return row;
}

interface ReportContext {
  db: Db;
  actor: ReportActor;
  institution: { id: number; name: string };
}

function context(db: Db, actor: ReportActor): ReportContext {
  return { db, actor, institution: institutionOf(db, actor) };
}

/** Guards that a candidate cannot pull institution-wide reporting. */
function assertReportAccess(actor: ReportActor): void {
  if (actor.roleCode === 'student') {
    throw forbidden('Reporting is not available for candidate accounts.');
  }
}

export async function studentResultReport(
  db: Db,
  actor: ReportActor,
  params: { studentId: number; from?: string; to?: string },
): Promise<ReportTable> {
  const ctx = context(db, actor);
  if (actor.roleCode === 'student' && actor.studentId !== params.studentId) {
    throw forbidden('You can only generate a report for your own record.');
  }

  const student = db
    .prepare(
      `SELECT s.id, s.student_code, u.full_name, s.institution_id, c.name AS class_name
         FROM students s JOIN users u ON u.id = s.user_id
         LEFT JOIN classes c ON c.id = s.class_id
        WHERE s.id = ?`,
    )
    .get(params.studentId) as any;
  if (!student) throw notFound('Candidate not found.');
  if (actor.roleCode !== 'super_admin' && student.institution_id !== actor.institutionId) {
    throw forbidden('You cannot generate reports for another institution.');
  }

  const clauses = ['r.student_id = ?'];
  const values: unknown[] = [params.studentId];
  if (params.from) {
    clauses.push('COALESCE(a.submitted_at, r.created_at) >= ?');
    values.push(params.from);
  }
  if (params.to) {
    clauses.push('COALESCE(a.submitted_at, r.created_at) <= ?');
    values.push(params.to);
  }

  const rows = db
    .prepare(
      `SELECT COALESCE(e.name, qz.title) AS paper, sub.name AS subject, e.exam_type AS exam_type,
              COALESCE(e.academic_year, '') AS academic_year,
              COALESCE(a.submitted_at, r.created_at) AS exam_date,
              r.total_marks, r.obtained_marks, r.percentage, r.grade, r.outcome,
              CASE WHEN r.is_published = 1 THEN 'Released' ELSE 'Held' END AS publication
         FROM results r
         JOIN attempts a ON a.id = r.attempt_id
         LEFT JOIN exams e ON e.id = r.exam_id
         LEFT JOIN quizzes qz ON qz.id = r.quiz_id
         LEFT JOIN subjects sub ON sub.id = r.subject_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY exam_date DESC`,
    )
    .all(...values) as any[];

  const totalObtained = rows.reduce((sum, r) => sum + r.obtained_marks, 0);
  const totalMarks = rows.reduce((sum, r) => sum + r.total_marks, 0);
  const passed = rows.filter((r) => r.outcome === 'PASSED').length;

  return {
    title: `Candidate result report — ${student.full_name}`,
    subtitle: `${student.student_code}${student.class_name ? ` • ${student.class_name}` : ''}`,
    institution: ctx.institution.name,
    generatedAt: nowIso(),
    generatedBy: actor.fullName,
    columns: [
      { key: 'paper', header: 'Examination', width: 3 },
      { key: 'subject', header: 'Subject', width: 2 },
      { key: 'exam_date', header: 'Date', width: 2 },
      { key: 'total_marks', header: 'Total', width: 1, align: 'right' },
      { key: 'obtained_marks', header: 'Obtained', width: 1, align: 'right' },
      { key: 'percentage', header: '%', width: 1, align: 'right' },
      { key: 'grade', header: 'Grade', width: 1 },
      { key: 'outcome', header: 'Outcome', width: 1 },
      { key: 'publication', header: 'Result', width: 1 },
    ],
    rows: rows.map((row) => ({
      ...row,
      percentage: `${row.percentage}%`,
      exam_date: row.exam_date ? new Date(row.exam_date).toISOString().slice(0, 10) : '—',
    })),
    summary: {
      Examinations: rows.length,
      Passed: passed,
      Failed: rows.filter((r) => r.outcome === 'FAILED').length,
      Pending: rows.filter((r) => r.outcome === 'PENDING').length,
      'Overall %': totalMarks ? `${Math.round((totalObtained / totalMarks) * 10000) / 100}%` : '—',
    },
  };
}

export async function classPerformanceReport(
  db: Db,
  actor: ReportActor,
  params: { classId: number; examId?: number },
): Promise<ReportTable> {
  assertReportAccess(actor);
  const ctx = context(db, actor);
  const klass = db
    .prepare('SELECT id, name, institution_id FROM classes WHERE id = ?')
    .get(params.classId) as any;
  if (!klass) throw notFound('Class not found.');
  if (actor.roleCode !== 'super_admin' && klass.institution_id !== actor.institutionId) {
    throw forbidden('You cannot report on another institution.');
  }

  const examFilter = params.examId ? 'AND r.exam_id = ?' : '';
  const values: unknown[] = [params.classId];
  if (params.examId) values.push(params.examId);

  const rows = db
    .prepare(
      `SELECT u.full_name AS student, s.student_code,
              COUNT(r.id) AS attempts,
              SUM(CASE WHEN r.outcome = 'PASSED' THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN r.outcome = 'FAILED' THEN 1 ELSE 0 END) AS failed,
              COALESCE(ROUND(AVG(r.percentage), 2), 0) AS average_percentage,
              COALESCE(MAX(r.percentage), 0) AS best_percentage
         FROM students s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN results r ON r.student_id = s.id ${examFilter}
        WHERE s.class_id = ? AND s.status = 'active'
        GROUP BY s.id
        ORDER BY average_percentage DESC, u.full_name ASC`,
    )
    .all(...(params.examId ? [params.examId, params.classId] : [params.classId]))
    .map((row: any, index: number) => ({ ...row, rank: index + 1 }));

  const withResults = rows.filter((r: any) => r.attempts > 0);
  const average =
    withResults.length > 0
      ? Math.round(
          (withResults.reduce((sum: number, r: any) => sum + Number(r.average_percentage), 0) / withResults.length) *
            100,
        ) / 100
      : 0;

  return {
    title: `Class performance report — ${klass.name}`,
    subtitle: params.examId ? 'Single examination' : 'All recorded results',
    institution: ctx.institution.name,
    generatedAt: nowIso(),
    generatedBy: actor.fullName,
    columns: [
      { key: 'rank', header: '#', width: 0.6, align: 'right' },
      { key: 'student', header: 'Candidate', width: 3 },
      { key: 'student_code', header: 'Candidate ID', width: 2 },
      { key: 'attempts', header: 'Assessments', width: 1, align: 'right' },
      { key: 'passed', header: 'Passed', width: 1, align: 'right' },
      { key: 'failed', header: 'Failed', width: 1, align: 'right' },
      { key: 'average_percentage', header: 'Average %', width: 1.4, align: 'right' },
      { key: 'best_percentage', header: 'Best %', width: 1.2, align: 'right' },
    ],
    rows,
    summary: {
      Candidates: rows.length,
      'With results': withResults.length,
      'Class average %': average,
    },
  };
}

export async function subjectPerformanceReport(
  db: Db,
  actor: ReportActor,
  params: { subjectId?: number; from?: string; to?: string },
): Promise<ReportTable> {
  assertReportAccess(actor);
  const ctx = context(db, actor);
  const clauses = ['r.institution_id = ?'];
  const values: unknown[] = [ctx.institution.id];
  if (params.subjectId) {
    clauses.push('r.subject_id = ?');
    values.push(params.subjectId);
  }
  if (params.from) {
    clauses.push('COALESCE(a.submitted_at, r.created_at) >= ?');
    values.push(params.from);
  }
  if (params.to) {
    clauses.push('COALESCE(a.submitted_at, r.created_at) <= ?');
    values.push(params.to);
  }

  const rows = db
    .prepare(
      `SELECT sub.name AS subject, sub.code AS subject_code,
              COUNT(r.id) AS results,
              SUM(CASE WHEN r.outcome = 'PASSED' THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN r.outcome = 'FAILED' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN r.outcome = 'PENDING' THEN 1 ELSE 0 END) AS pending,
              COALESCE(ROUND(AVG(r.percentage), 2), 0) AS average_percentage,
              COALESCE(ROUND(MAX(r.percentage), 2), 0) AS highest_percentage,
              COALESCE(ROUND(MIN(r.percentage), 2), 0) AS lowest_percentage
         FROM results r
         JOIN subjects sub ON sub.id = r.subject_id
         JOIN attempts a ON a.id = r.attempt_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY sub.id
        ORDER BY average_percentage DESC`,
    )
    .all(...values) as any[];

  return {
    title: 'Subject performance report',
    subtitle: params.subjectId ? 'Selected subject' : 'All subjects',
    institution: ctx.institution.name,
    generatedAt: nowIso(),
    generatedBy: actor.fullName,
    columns: [
      { key: 'subject', header: 'Subject', width: 3 },
      { key: 'subject_code', header: 'Code', width: 1.4 },
      { key: 'results', header: 'Results', width: 1, align: 'right' },
      { key: 'passed', header: 'Passed', width: 1, align: 'right' },
      { key: 'failed', header: 'Failed', width: 1, align: 'right' },
      { key: 'pending', header: 'Pending', width: 1, align: 'right' },
      { key: 'average_percentage', header: 'Average %', width: 1.4, align: 'right' },
      { key: 'highest_percentage', header: 'Highest %', width: 1.2, align: 'right' },
      { key: 'lowest_percentage', header: 'Lowest %', width: 1.2, align: 'right' },
    ],
    rows,
    summary: {
      Subjects: rows.length,
      Results: rows.reduce((sum, r) => sum + r.results, 0),
    },
  };
}

export async function examStatisticsReport(
  db: Db,
  actor: ReportActor,
  params: { examId: number },
): Promise<ReportTable> {
  assertReportAccess(actor);
  const ctx = context(db, actor);
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(params.examId) as any;
  if (!exam) throw notFound('Examination not found.');
  if (actor.roleCode !== 'super_admin' && exam.institution_id !== actor.institutionId) {
    throw forbidden('You cannot report on another institution.');
  }

  const rows = db
    .prepare(
      `SELECT u.full_name AS student, s.student_code, a.attempt_no, a.status AS attempt_status,
              a.started_at, a.submitted_at, a.auto_submitted, a.objective_marks, a.subjective_marks,
              a.obtained_marks, a.max_marks, a.percentage, a.grade, r.outcome,
              CASE WHEN r.is_published = 1 THEN 'Released' ELSE 'Held' END AS publication,
              CASE WHEN json_array_length(a.integrity_flags) > 0 THEN 'Flagged' ELSE 'Clean' END AS integrity
         FROM attempts a
         JOIN students s ON s.id = a.student_id
         JOIN users u ON u.id = s.user_id
         LEFT JOIN results r ON r.attempt_id = a.id
        WHERE a.exam_id = ?
        ORDER BY a.obtained_marks DESC NULLS LAST, u.full_name ASC`,
    )
    .all(params.examId) as any[];

  const graded = rows.filter((r) => r.percentage !== null);
  const average =
    graded.length > 0
      ? Math.round((graded.reduce((sum, r) => sum + Number(r.percentage), 0) / graded.length) * 100) / 100
      : 0;

  return {
    title: `Examination statistics — ${exam.name}`,
    subtitle: `${exam.code} • ${new Date(exam.start_at).toISOString().slice(0, 16).replace('T', ' ')} UTC • ${exam.total_marks} marks`,
    institution: ctx.institution.name,
    generatedAt: nowIso(),
    generatedBy: actor.fullName,
    columns: [
      { key: 'student', header: 'Candidate', width: 2.6 },
      { key: 'student_code', header: 'Candidate ID', width: 1.8 },
      { key: 'attempt_no', header: 'Attempt', width: 0.9, align: 'right' },
      { key: 'status_label', header: 'Status', width: 1.4 },
      { key: 'submitted_at', header: 'Submitted', width: 2 },
      { key: 'objective_marks', header: 'Objective', width: 1.1, align: 'right' },
      { key: 'subjective_marks', header: 'Subjective', width: 1.1, align: 'right' },
      { key: 'obtained_marks', header: 'Total', width: 1, align: 'right' },
      { key: 'max_marks', header: 'Out of', width: 1, align: 'right' },
      { key: 'percentage', header: '%', width: 1, align: 'right' },
      { key: 'grade', header: 'Grade', width: 0.8 },
      { key: 'outcome', header: 'Outcome', width: 1.1 },
      { key: 'publication', header: 'Result', width: 1.1 },
      { key: 'integrity', header: 'Integrity', width: 1 },
    ],
    rows: rows.map((row) => ({
      ...row,
      status_label: String(row.attempt_status ?? '').replace(/_/g, ' '),
      submitted_at: row.submitted_at ? new Date(row.submitted_at).toISOString().slice(0, 16).replace('T', ' ') : '—',
      percentage: row.percentage === null ? '—' : `${row.percentage}%`,
    })),
    summary: {
      Candidates: rows.length,
      Graded: graded.length,
      Passed: rows.filter((r) => r.outcome === 'PASSED').length,
      Failed: rows.filter((r) => r.outcome === 'FAILED').length,
      'Average %': average,
      'Auto-submitted': rows.filter((r) => r.auto_submitted).length,
      'Integrity flags': rows.filter((r) => r.integrity === 'Flagged').length,
    },
  };
}

export async function questionPerformanceReport(
  db: Db,
  actor: ReportActor,
  params: { examId?: number; subjectId?: number; questionBankId?: number },
): Promise<ReportTable> {
  assertReportAccess(actor);
  const ctx = context(db, actor);

  const clauses = ['a.institution_id = ?', 'aq.is_objective = 1'];
  const values: unknown[] = [ctx.institution.id];
  if (params.examId) {
    clauses.push('a.exam_id = ?');
    values.push(params.examId);
  }
  if (params.subjectId) {
    clauses.push('q.subject_id = ?');
    values.push(params.subjectId);
  }
  if (params.questionBankId) {
    clauses.push('q.question_bank_id = ?');
    values.push(params.questionBankId);
  }

  const rows = db
    .prepare(
      `SELECT aq.question_id AS question_id, aq.question_text AS question,
              q.type AS question_type, q.difficulty AS difficulty, sub.name AS subject, q.topic AS topic,
              COUNT(an.id) AS responses,
              SUM(CASE WHEN an.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
              SUM(CASE WHEN an.is_correct = 0 AND (an.awarded_marks IS NOT NULL) THEN 1 ELSE 0 END) AS incorrect,
              COALESCE(ROUND(100.0 * SUM(CASE WHEN an.is_correct = 1 THEN 1 ELSE 0 END) /
                NULLIF(SUM(CASE WHEN an.awarded_marks IS NOT NULL THEN 1 ELSE 0 END), 0), 2), 0) AS correct_rate,
              COALESCE(ROUND(AVG(an.awarded_marks), 2), 0) AS average_awarded
         FROM attempt_questions aq
         JOIN attempts a ON a.id = aq.attempt_id
         JOIN questions q ON q.id = aq.question_id
         JOIN subjects sub ON sub.id = q.subject_id
         LEFT JOIN answers an ON an.attempt_id = aq.attempt_id AND an.question_id = aq.question_id
        WHERE ${clauses.join(' AND ')} AND a.status NOT IN ('IN_PROGRESS','VOID')
        GROUP BY aq.question_id
        ORDER BY correct_rate ASC, responses DESC
        LIMIT 500`,
    )
    .all(...values) as any[];

  return {
    title: 'Question performance report',
    subtitle: params.examId ? 'Single examination' : 'All graded objective questions',
    institution: ctx.institution.name,
    generatedAt: nowIso(),
    generatedBy: actor.fullName,
    columns: [
      { key: 'question_id', header: 'ID', width: 0.7, align: 'right' },
      { key: 'question', header: 'Question', width: 5 },
      { key: 'question_type', header: 'Type', width: 1.3 },
      { key: 'difficulty', header: 'Difficulty', width: 1.1 },
      { key: 'subject', header: 'Subject', width: 1.6 },
      { key: 'responses', header: 'Responses', width: 1.1, align: 'right' },
      { key: 'correct', header: 'Correct', width: 1, align: 'right' },
      { key: 'incorrect', header: 'Incorrect', width: 1, align: 'right' },
      { key: 'correct_rate', header: 'Correct %', width: 1.1, align: 'right' },
      { key: 'average_awarded', header: 'Avg marks', width: 1.1, align: 'right' },
    ],
    rows: rows.map((row) => ({
      ...row,
      question: String(row.question).length > 160 ? `${String(row.question).slice(0, 157)}…` : row.question,
    })),
    summary: {
      Questions: rows.length,
      'Below 50% correct': rows.filter((r) => Number(r.correct_rate) < 50).length,
    },
  };
}

export async function passFailReport(
  db: Db,
  actor: ReportActor,
  params: { examId?: number; classId?: number; from?: string; to?: string },
): Promise<ReportTable> {
  assertReportAccess(actor);
  const ctx = context(db, actor);
  const clauses = ['r.institution_id = ?'];
  const values: unknown[] = [ctx.institution.id];
  if (params.examId) {
    clauses.push('r.exam_id = ?');
    values.push(params.examId);
  }
  if (params.classId) {
    clauses.push('s.class_id = ?');
    values.push(params.classId);
  }
  if (params.from) {
    clauses.push('COALESCE(a.submitted_at, r.created_at) >= ?');
    values.push(params.from);
  }
  if (params.to) {
    clauses.push('COALESCE(a.submitted_at, r.created_at) <= ?');
    values.push(params.to);
  }

  const rows = db
    .prepare(
      `SELECT r.grade AS grade,
              COUNT(*) AS candidates,
              SUM(CASE WHEN r.outcome = 'PASSED' THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN r.outcome = 'FAILED' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN r.outcome = 'PENDING' THEN 1 ELSE 0 END) AS pending,
              COALESCE(ROUND(AVG(r.percentage), 2), 0) AS average_percentage
         FROM results r
         JOIN students s ON s.id = r.student_id
         JOIN attempts a ON a.id = r.attempt_id
        WHERE ${clauses.join(' AND ')}
        GROUP BY r.grade
        ORDER BY average_percentage DESC`,
    )
    .all(...values) as any[];

  const totals = rows.reduce(
    (acc, row) => ({
      candidates: acc.candidates + row.candidates,
      passed: acc.passed + row.passed,
      failed: acc.failed + row.failed,
      pending: acc.pending + row.pending,
    }),
    { candidates: 0, passed: 0, failed: 0, pending: 0 },
  );

  return {
    title: 'Pass / fail report',
    subtitle: params.examId ? 'Single examination' : 'Institution-wide',
    institution: ctx.institution.name,
    generatedAt: nowIso(),
    generatedBy: actor.fullName,
    columns: [
      { key: 'grade', header: 'Grade', width: 1 },
      { key: 'candidates', header: 'Results', width: 1, align: 'right' },
      { key: 'passed', header: 'Passed', width: 1, align: 'right' },
      { key: 'failed', header: 'Failed', width: 1, align: 'right' },
      { key: 'pending', header: 'Pending', width: 1, align: 'right' },
      { key: 'average_percentage', header: 'Average %', width: 1.2, align: 'right' },
      { key: 'pass_rate', header: 'Pass rate %', width: 1.2, align: 'right' },
    ],
    rows: rows.map((row) => ({
      ...row,
      pass_rate: row.candidates ? Math.round((row.passed / row.candidates) * 10000) / 100 : 0,
    })),
    summary: {
      Results: totals.candidates,
      Passed: totals.passed,
      Failed: totals.failed,
      Pending: totals.pending,
      'Pass rate %': totals.candidates ? Math.round((totals.passed / totals.candidates) * 10000) / 100 : 0,
    },
  };
}

export async function teacherActivityReport(db: Db, actor: ReportActor): Promise<ReportTable> {
  assertReportAccess(actor);
  const ctx = context(db, actor);

  const rows = db
    .prepare(
      `SELECT u.full_name AS teacher, t.staff_code, t.designation,
              (SELECT COUNT(*) FROM questions q WHERE q.created_by = u.id) AS questions_created,
              (SELECT COUNT(*) FROM exams e WHERE e.created_by = u.id) AS exams_created,
              (SELECT COUNT(*) FROM exams e WHERE e.created_by = u.id AND e.status = 'PUBLISHED') AS exams_published,
              (SELECT COUNT(*) FROM grading_history gh WHERE gh.grader_id = u.id) AS grading_actions,
              (SELECT COUNT(*) FROM exams e WHERE e.created_by = u.id AND e.status = 'ACTIVE') AS active_exams
         FROM teachers t
         JOIN users u ON u.id = t.user_id
        WHERE t.institution_id = ? AND t.status = 'active'
        ORDER BY exams_created DESC, questions_created DESC`,
    )
    .all(ctx.institution.id) as any[];

  return {
    title: 'Examiner activity report',
    subtitle: 'Authorship, publication and grading activity per examiner',
    institution: ctx.institution.name,
    generatedAt: nowIso(),
    generatedBy: actor.fullName,
    columns: [
      { key: 'teacher', header: 'Examiner', width: 3 },
      { key: 'staff_code', header: 'Staff ID', width: 1.5 },
      { key: 'designation', header: 'Designation', width: 2 },
      { key: 'questions_created', header: 'Questions', width: 1.2, align: 'right' },
      { key: 'exams_created', header: 'Examinations', width: 1.4, align: 'right' },
      { key: 'exams_published', header: 'Published', width: 1.2, align: 'right' },
      { key: 'active_exams', header: 'Active', width: 1, align: 'right' },
      { key: 'grading_actions', header: 'Grading actions', width: 1.5, align: 'right' },
    ],
    rows,
    summary: {
      Examiners: rows.length,
      'Questions authored': rows.reduce((sum, r) => sum + r.questions_created, 0),
      'Examinations authored': rows.reduce((sum, r) => sum + r.exams_created, 0),
    },
  };
}

export const REPORT_DEFINITIONS = [
  { key: 'student-results', name: 'Candidate result report', params: ['studentId', 'from', 'to'] },
  { key: 'class-performance', name: 'Class performance report', params: ['classId', 'examId'] },
  { key: 'subject-performance', name: 'Subject performance report', params: ['subjectId', 'from', 'to'] },
  { key: 'exam-statistics', name: 'Examination statistics', params: ['examId'] },
  { key: 'question-performance', name: 'Question performance report', params: ['examId', 'subjectId', 'questionBankId'] },
  { key: 'pass-fail', name: 'Pass / fail report', params: ['examId', 'classId', 'from', 'to'] },
  { key: 'examiner-activity', name: 'Examiner activity report', params: [] },
] as const;

export type ReportKey = (typeof REPORT_DEFINITIONS)[number]['key'];
