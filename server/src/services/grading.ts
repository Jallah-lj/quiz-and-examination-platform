/**
 * Manual grading workflow for subjective answers (essays, short answers and any
 * answer an examiner chooses to review). Every mark change is written to
 * `grading_history` so the audit trail survives later edits.
 */
import type { Db } from '../db';
import { clampMarks, round2 } from '../lib/answer-key';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { nowIso } from '../lib/time';
import type { RoleCode } from '../types';
import { finaliseAttempt } from './attempts';
import { recordAudit } from './audit';
import { createNotification, userIdForStudent } from './notifications';

export interface GradingActor {
  id: number;
  institutionId: number | null;
  roleCode: RoleCode;
  fullName: string;
}

function assertGradingAccess(db: Db, actor: GradingActor, attempt: any): void {
  if (actor.roleCode === 'super_admin') return;
  if (actor.institutionId !== attempt.institution_id) {
    throw forbidden('You do not have permission to grade this submission.');
  }
  if (actor.roleCode === 'teacher' && attempt.exam_id) {
    const exam = db.prepare('SELECT created_by FROM exams WHERE id = ?').get(attempt.exam_id) as
      | { created_by: number }
      | undefined;
    if (exam && exam.created_by !== actor.id) {
      // Teachers who did not create the exam may still grade if they are assigned to its class.
      const assigned = db
        .prepare(
          `SELECT COUNT(*) AS c FROM class_subjects cs
             JOIN teachers t ON t.id = cs.teacher_id
            WHERE t.user_id = ? AND cs.class_id = (SELECT class_id FROM exams WHERE id = ?)`,
        )
        .get(actor.id, attempt.exam_id) as { c: number };
      if (!assigned.c) {
        throw forbidden('You can only grade submissions for examinations you own or teach.');
      }
    }
  }
}

export interface GradingQueueFilters {
  examId?: number;
  quizId?: number;
  status?: string;
  classId?: number;
  search?: string;
}

export function listGradingQueue(
  db: Db,
  actor: GradingActor,
  filters: GradingQueueFilters,
  pagination: { page: number; pageSize: number },
): { items: any[]; total: number } {
  const where: string[] = ["a.status IN ('SUBMITTED','UNDER_REVIEW','GRADED')"];
  const params: unknown[] = [];

  if (actor.roleCode !== 'super_admin') {
    if (!actor.institutionId) throw forbidden();
    where.push('a.institution_id = ?');
    params.push(actor.institutionId);
  }
  if (filters.examId) {
    where.push('a.exam_id = ?');
    params.push(filters.examId);
  }
  if (filters.quizId) {
    where.push('a.quiz_id = ?');
    params.push(filters.quizId);
  }
  if (filters.status === 'pending') where.push("a.status IN ('SUBMITTED','UNDER_REVIEW')");
  if (filters.status === 'graded') where.push("a.status = 'GRADED'");
  if (filters.classId) {
    where.push('s.class_id = ?');
    params.push(filters.classId);
  }
  if (filters.search) {
    where.push('(u.full_name LIKE ? OR s.student_code LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (actor.roleCode === 'teacher') {
    where.push(
      `(e.created_by = ? OR EXISTS (
          SELECT 1 FROM class_subjects cs JOIN teachers t ON t.id = cs.teacher_id
           WHERE t.user_id = ? AND cs.class_id = e.class_id))`,
    );
    params.push(actor.id, actor.id);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `
    FROM attempts a
    LEFT JOIN exams e ON e.id = a.exam_id
    LEFT JOIN quizzes qz ON qz.id = a.quiz_id
    JOIN students s ON s.id = a.student_id
    JOIN users u ON u.id = s.user_id
    JOIN subjects sub ON sub.id = COALESCE(e.subject_id, qz.subject_id)
    ${whereSql}`;

  const total = (db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(
      `SELECT a.id, a.status, a.submitted_at, a.obtained_marks, a.max_marks, a.percentage, a.auto_submitted,
              COALESCE(e.name, qz.title) AS paper_title, COALESCE(e.code, '') AS exam_code,
              CASE WHEN a.exam_id IS NOT NULL THEN 'EXAM' ELSE 'QUIZ' END AS kind,
              u.full_name AS student_name, s.student_code, s.id AS student_id, sub.name AS subject_name,
              (SELECT COUNT(*) FROM attempt_questions aq WHERE aq.attempt_id = a.id AND aq.is_objective = 0) AS subjective_count,
              (SELECT COUNT(*) FROM answers an WHERE an.attempt_id = a.id AND an.awarded_marks IS NULL) AS ungraded_count,
              e.id AS exam_id, qz.id AS quiz_id
       ${base}
       ORDER BY a.submitted_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pagination.pageSize, (pagination.page - 1) * pagination.pageSize) as any[];

  return { items, total };
}

export function getGradingDetail(db: Db, actor: GradingActor, attemptId: number): any {
  const attempt = db
    .prepare(
      `SELECT a.*, COALESCE(e.name, qz.title) AS paper_title, COALESCE(e.code,'') AS paper_code,
              e.instructions AS exam_instructions, qz.instructions AS quiz_instructions,
              e.pass_marks AS exam_pass_marks, e.total_marks AS exam_total_marks,
              u.full_name AS student_name, s.student_code, s.id AS student_id, i.name AS institution_name
         FROM attempts a
         LEFT JOIN exams e ON e.id = a.exam_id
         LEFT JOIN quizzes qz ON qz.id = a.quiz_id
         JOIN students s ON s.id = a.student_id
         JOIN users u ON u.id = s.user_id
         JOIN institutions i ON i.id = a.institution_id
        WHERE a.id = ?`,
    )
    .get(attemptId) as any;
  if (!attempt) throw notFound('Attempt not found.');
  assertGradingAccess(db, actor, attempt);

  const questions = db
    .prepare(
      `SELECT aq.question_id, aq.position, aq.question_type, aq.question_text, aq.marks, aq.negative_marks,
              aq.is_objective, aq.correct_answer, aq.snapshot,
              an.id AS answer_id, an.selected_options, an.answer_text, an.is_correct, an.awarded_marks,
              an.comment, an.graded_by, an.graded_at, an.auto_graded, an.is_flagged, an.updated_at AS answered_at,
              gu.full_name AS graded_by_name
         FROM attempt_questions aq
         LEFT JOIN answers an ON an.attempt_id = aq.attempt_id AND an.question_id = aq.question_id
         LEFT JOIN users gu ON gu.id = an.graded_by
        WHERE aq.attempt_id = ?
        ORDER BY aq.position ASC`,
    )
    .all(attemptId) as any[];

  const history = db
    .prepare(
      `SELECT gh.*, an.question_id FROM grading_history gh
         JOIN answers an ON an.id = gh.answer_id
        WHERE gh.attempt_id = ?
        ORDER BY gh.created_at DESC`,
    )
    .all(attemptId) as any[];

  return {
    attempt: {
      id: attempt.id,
      status: attempt.status,
      studentName: attempt.student_name,
      studentCode: attempt.student_code,
      paperTitle: attempt.paper_title,
      paperCode: attempt.paper_code,
      kind: attempt.exam_id ? 'EXAM' : 'QUIZ',
      instructions: attempt.exam_instructions ?? attempt.quiz_instructions,
      institutionName: attempt.institution_name,
      submittedAt: attempt.submitted_at,
      autoSubmitted: Boolean(attempt.auto_submitted),
      startedAt: attempt.started_at,
      objectiveMarks: attempt.objective_marks,
      subjectiveMarks: attempt.subjective_marks,
      obtainedMarks: attempt.obtained_marks,
      maxMarks: attempt.max_marks,
      percentage: attempt.percentage,
      grade: attempt.grade,
      passed: attempt.passed,
      examPassMarks: attempt.exam_pass_marks,
      examTotalMarks: attempt.exam_total_marks,
      integrityFlags: JSON.parse(attempt.integrity_flags ?? '[]'),
    },
    questions: questions.map((q) => ({
      questionId: q.question_id,
      position: q.position,
      type: q.question_type,
      text: q.question_text,
      marks: q.marks,
      negativeMarks: q.negative_marks,
      objective: Boolean(q.is_objective),
      options: (JSON.parse(q.snapshot).options ?? []) as { label: string; text: string }[],
      correctAnswer: JSON.parse(q.correct_answer ?? '{}') as Record<string, unknown>,
      answer: q.answer_id
        ? {
            id: q.answer_id,
            selectedOptions: JSON.parse(q.selected_options ?? '[]') as string[],
            answerText: q.answer_text,
            isCorrect: q.is_correct === null ? null : Boolean(q.is_correct),
            awardedMarks: q.awarded_marks,
            comment: q.comment,
            autoGraded: Boolean(q.auto_graded),
            isFlagged: Boolean(q.is_flagged),
            answeredAt: q.answered_at,
            gradedBy: q.graded_by,
            gradedByName: q.graded_by_name,
            gradedAt: q.graded_at,
          }
        : null,
    })),
    history: history.map((h) => ({
      id: h.id,
      answerId: h.answer_id,
      questionId: h.question_id,
      graderName: h.grader_name,
      previousMarks: h.previous_marks,
      awardedMarks: h.awarded_marks,
      comment: h.comment,
      action: h.action,
      createdAt: h.created_at,
    })),
  };
}

export function saveGrade(
  db: Db,
  actor: GradingActor,
  attemptId: number,
  answerId: number,
  input: { awardedMarks: number; comment?: string | null },
  meta: { ip?: string | null; userAgent?: string | null } = {},
): any {
  const attempt = db
    .prepare('SELECT id, institution_id, status, student_id, exam_id, quiz_id FROM attempts WHERE id = ?')
    .get(attemptId) as any;
  if (!attempt) throw notFound('Attempt not found.');
  assertGradingAccess(db, actor, attempt);
  if (attempt.status === 'IN_PROGRESS') {
    throw conflict('This attempt is still in progress and cannot be graded yet.');
  }
  if (attempt.status === 'VOID') throw conflict('This attempt has been voided.');

  const answer = db
    .prepare(
      `SELECT an.id, an.attempt_id, an.awarded_marks, an.comment, an.max_marks, an.question_id,
              aq.is_objective, aq.question_type, aq.marks AS paper_marks
         FROM answers an
         JOIN attempt_questions aq ON aq.attempt_id = an.attempt_id AND aq.question_id = an.question_id
        WHERE an.id = ? AND an.attempt_id = ?`,
    )
    .get(answerId, attemptId) as any;
  if (!answer) throw notFound('Answer not found for this attempt.');

  const maxMarks = answer.paper_marks ?? answer.max_marks;
  const awarded = clampMarks(round2(Number(input.awardedMarks)), maxMarks);
  if (Number.isNaN(Number(input.awardedMarks))) {
    throw unprocessable('Enter a valid mark for this answer.');
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE answers SET awarded_marks = ?, is_correct = ?, graded_by = ?, graded_at = ?, comment = ?,
              graded_version = graded_version + 1, updated_at = ?
        WHERE id = ?`,
    ).run(
      awarded,
      answer.is_objective ? (awarded >= maxMarks && maxMarks > 0 ? 1 : 0) : awarded > 0 ? 1 : 0,
      actor.id,
      nowIso(),
      input.comment?.trim() || null,
      nowIso(),
      answerId,
    );
    db.prepare(
      `INSERT INTO grading_history
        (answer_id, attempt_id, grader_id, grader_name, previous_marks, awarded_marks, previous_comment, comment, action, created_at)
       VALUES (?,?,?,?,?,?,?,?, 'grade', ?)`,
    ).run(
      answerId,
      attemptId,
      actor.id,
      actor.fullName,
      answer.awarded_marks,
      awarded,
      answer.comment,
      input.comment?.trim() || null,
      nowIso(),
    );
  })();

  recordAudit(db, {
    institutionId: attempt.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'grading.mark_saved',
    category: 'grading',
    resourceType: 'answer',
    resourceId: answerId,
    description: `Awarded ${awarded}/${maxMarks} on answer #${answerId} (attempt #${attemptId})`,
    metadata: { attemptId, questionId: answer.question_id, previous: answer.awarded_marks, awarded },
    ...meta,
  });

  return { answerId, awardedMarks: awarded, maxMarks };
}

/** Completes grading for an attempt and recomputes the final result. */
export function finalizeGrading(
  db: Db,
  actor: GradingActor,
  attemptId: number,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): any {
  const attempt = db
    .prepare('SELECT id, institution_id, status, student_id, exam_id, quiz_id FROM attempts WHERE id = ?')
    .get(attemptId) as any;
  if (!attempt) throw notFound('Attempt not found.');
  assertGradingAccess(db, actor, attempt);
  if (attempt.status === 'IN_PROGRESS') {
    throw conflict('This attempt is still in progress.');
  }

  const ungraded = db
    .prepare(
      `SELECT COUNT(*) AS c FROM attempt_questions aq
         LEFT JOIN answers an ON an.attempt_id = aq.attempt_id AND an.question_id = aq.question_id
        WHERE aq.attempt_id = ? AND aq.is_objective = 0 AND (an.id IS NULL OR an.awarded_marks IS NULL)`,
    )
    .get(attemptId) as { c: number };
  if (ungraded.c > 0) {
    throw unprocessable(
      `${ungraded.c} subjective answer(s) still have no mark. Award a mark (zero is allowed) to every answer before finalising.`,
    );
  }

  // Recompute totals and grade using the shared deterministic scoring pipeline.
  const submission = finaliseAttempt(db, actor as any, attemptId, { reason: 'grading_finalised' });

  const now = nowIso();
  db.prepare('UPDATE attempts SET status = ?, graded_at = ?, graded_by = ?, updated_at = ? WHERE id = ?').run(
    'GRADED',
    now,
    actor.id,
    now,
    attemptId,
  );
  const firstAnswer = db
    .prepare('SELECT id FROM answers WHERE attempt_id = ? ORDER BY id LIMIT 1')
    .get(attemptId) as { id: number } | undefined;
  if (firstAnswer) {
    db.prepare(
      `INSERT INTO grading_history
        (answer_id, attempt_id, grader_id, grader_name, awarded_marks, comment, action, created_at)
       VALUES (?,?,?,?,?,?, 'finalize', ?)`,
    ).run(
      firstAnswer.id,
      attemptId,
      actor.id,
      actor.fullName,
      submission.totalObtained,
      'Grading finalised',
      now,
    );
  }

  const userId = userIdForStudent(db, attempt.student_id);
  const paper =
    (db.prepare('SELECT name FROM exams WHERE id = ?').get(attempt.exam_id) as { name: string } | undefined)?.name ??
    (db.prepare('SELECT title FROM quizzes WHERE id = ?').get(attempt.quiz_id) as { title: string } | undefined)?.title ??
    'your paper';
  if (userId) {
    createNotification(db, {
      institutionId: attempt.institution_id,
      userId,
      type: 'grading_completed',
      title: 'Manual grading completed',
      body: `Your submission for "${paper}" has been fully graded.`,
      severity: 'info',
      dedupeKey: `grading_completed:${attemptId}`,
    });
  }

  recordAudit(db, {
    institutionId: attempt.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'grading.finalised',
    category: 'grading',
    resourceType: 'attempt',
    resourceId: attemptId,
    description: `Finalised grading for attempt #${attemptId} — ${submission.totalObtained}/${submission.maxMarks}`,
    metadata: { obtained: submission.totalObtained, max: submission.maxMarks, outcome: submission.outcome },
    ...meta,
  });

  return submission;
}

export function getStudentAttemptReview(db: Db, actor: { studentId: number | null }, attemptId: number): any {
  const attempt = db
    .prepare('SELECT * FROM attempts WHERE id = ?')
    .get(attemptId) as any;
  if (!attempt) throw notFound('Attempt not found.');
  if (actor.studentId !== attempt.student_id) {
    throw forbidden('You can only review your own attempts.');
  }
  return attempt;
}
