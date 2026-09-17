import type { Db } from '../db';
import { conflict, forbidden, notFound, unprocessable, validationError } from '../lib/errors';
import { nowIso } from '../lib/time';
import { recordAudit } from './audit';
import { createNotification, userIdForStudent, userIdsForClass, userIdsForGroup } from './notifications';

export interface QuizActor {
  id: number;
  institutionId: number | null;
  roleCode: string;
  fullName: string;
}

export interface QuizInput {
  subjectId: number;
  classId?: number | null;
  title: string;
  description?: string | null;
  instructions?: string | null;
  questionCount: number;
  timeLimitMinutes: number;
  maxAttempts: number;
  passPercentage: number;
  randomizeQuestions?: boolean;
  randomizeOptions?: boolean;
  immediateResults?: boolean;
  showCorrectAnswers?: boolean;
  allowReview?: boolean;
  negativeMarking?: boolean;
  availableFrom: string;
  availableUntil: string;
  resultReleaseAt?: string | null;
  questions: { questionId: number; marks: number; negativeMarks: number; position?: number }[];
}

export function getQuizOr404(db: Db, actor: { institutionId: number | null }, quizId: number): any {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId) as any;
  if (!quiz) throw notFound('Quiz not found.');
  if (actor.institutionId !== null && quiz.institution_id !== actor.institutionId) {
    throw notFound('Quiz not found.');
  }
  return quiz;
}

export function assertQuizOwnership(actor: QuizActor, quiz: { created_by: number }): void {
  if (actor.roleCode === 'super_admin' || actor.roleCode === 'institution_admin') return;
  if (quiz.created_by !== actor.id) {
    throw forbidden('You can only manage quizzes that you created.');
  }
}

function validateQuizInput(db: Db, institutionId: number, input: QuizInput): void {
  const problems: string[] = [];
  if (!input.questions?.length) problems.push('A quiz needs at least one question.');
  if (input.questionCount < 1) problems.push('Number of questions must be at least one.');
  if (input.questionCount > input.questions.length) {
    problems.push('The quiz cannot ask for more questions than are attached to it.');
  }
  if (input.timeLimitMinutes < 1) problems.push('The time limit must be at least one minute.');
  if (input.passPercentage < 0 || input.passPercentage > 100) {
    problems.push('Pass percentage must be between 0 and 100.');
  }
  if (new Date(input.availableUntil) <= new Date(input.availableFrom)) {
    problems.push('The closing date must be after the opening date.');
  }
  const subject = db
    .prepare('SELECT id FROM subjects WHERE id = ? AND institution_id = ?')
    .get(input.subjectId, institutionId);
  if (!subject) problems.push('The selected subject does not belong to this institution.');

  const ids = input.questions.map((q) => q.questionId);
  if (new Set(ids).size !== ids.length) problems.push('The same question cannot be added twice.');
  const found = db
    .prepare(`SELECT COUNT(*) AS c FROM questions WHERE institution_id = ? AND id IN (${ids.map(() => '?').join(',') || 'NULL'})`)
    .get(institutionId, ...ids) as { c: number };
  if (found.c !== ids.length) problems.push('One or more questions do not belong to this institution.');

  if (problems.length) {
    throw unprocessable('The quiz configuration is invalid.', problems.map((message) => ({ message })));
  }
}

export function createQuiz(
  db: Db,
  actor: QuizActor,
  input: QuizInput,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): any {
  if (!actor.institutionId) throw forbidden('Quizzes must be created within an institution.');
  validateQuizInput(db, actor.institutionId, input);
  const timestamp = nowIso();

  const quizId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO quizzes
          (institution_id, subject_id, class_id, created_by, title, description, instructions, question_count,
           time_limit_minutes, max_attempts, pass_percentage, randomize_questions, randomize_options,
           immediate_results, show_correct_answers, allow_review, negative_marking, available_from,
           available_until, result_release_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'DRAFT', ?, ?)`,
      )
      .run(
        actor.institutionId,
        input.subjectId,
        input.classId ?? null,
        actor.id,
        input.title.trim(),
        input.description?.trim() || null,
        input.instructions?.trim() || null,
        input.questionCount,
        input.timeLimitMinutes,
        input.maxAttempts,
        input.passPercentage,
        input.randomizeQuestions ? 1 : 0,
        input.randomizeOptions ? 1 : 0,
        input.immediateResults ? 1 : 0,
        input.showCorrectAnswers ? 1 : 0,
        input.allowReview === undefined ? 1 : input.allowReview ? 1 : 0,
        input.negativeMarking ? 1 : 0,
        input.availableFrom,
        input.availableUntil,
        input.resultReleaseAt ?? null,
        timestamp,
        timestamp,
      );
    const id = Number(info.lastInsertRowid);
    const insert = db.prepare(
      'INSERT INTO quiz_questions (quiz_id, question_id, position, marks, negative_marks) VALUES (?,?,?,?,?)',
    );
    input.questions.forEach((question, index) => {
      insert.run(
        id,
        question.questionId,
        question.position ?? index + 1,
        question.marks,
        input.negativeMarking ? question.negativeMarks : 0,
      );
    });
    return id;
  })();

  recordAudit(db, {
    institutionId: actor.institutionId,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'quiz.created',
    category: 'exam',
    resourceType: 'quiz',
    resourceId: quizId,
    description: `Created quiz "${input.title}"`,
    metadata: { questions: input.questions.length },
    ...meta,
  });

  return getQuizOr404(db, actor, quizId);
}

export function updateQuiz(
  db: Db,
  actor: QuizActor,
  quizId: number,
  input: Partial<QuizInput>,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): any {
  const quiz = getQuizOr404(db, actor, quizId);
  assertQuizOwnership(actor, quiz);
  if (quiz.status === 'ARCHIVED') throw conflict('An archived quiz cannot be edited.');

  const questions = input.questions
    ? input.questions
    : (
        db
          .prepare('SELECT question_id, marks, negative_marks, position FROM quiz_questions WHERE quiz_id = ? ORDER BY position')
          .all(quizId) as any[]
      ).map((row) => ({
        questionId: row.question_id,
        marks: row.marks,
        negativeMarks: row.negative_marks,
        position: row.position,
      }));

  const merged: QuizInput = {
    subjectId: input.subjectId ?? quiz.subject_id,
    classId: input.classId === undefined ? quiz.class_id : input.classId,
    title: input.title ?? quiz.title,
    description: input.description === undefined ? quiz.description : input.description,
    instructions: input.instructions === undefined ? quiz.instructions : input.instructions,
    questionCount: input.questionCount ?? quiz.question_count,
    timeLimitMinutes: input.timeLimitMinutes ?? quiz.time_limit_minutes,
    maxAttempts: input.maxAttempts ?? quiz.max_attempts,
    passPercentage: input.passPercentage ?? quiz.pass_percentage,
    randomizeQuestions: input.randomizeQuestions ?? Boolean(quiz.randomize_questions),
    randomizeOptions: input.randomizeOptions ?? Boolean(quiz.randomize_options),
    immediateResults: input.immediateResults ?? Boolean(quiz.immediate_results),
    showCorrectAnswers: input.showCorrectAnswers ?? Boolean(quiz.show_correct_answers),
    allowReview: input.allowReview ?? Boolean(quiz.allow_review),
    negativeMarking: input.negativeMarking ?? Boolean(quiz.negative_marking),
    availableFrom: input.availableFrom ?? quiz.available_from,
    availableUntil: input.availableUntil ?? quiz.available_until,
    resultReleaseAt: input.resultReleaseAt === undefined ? quiz.result_release_at : input.resultReleaseAt,
    questions,
  };

  validateQuizInput(db, quiz.institution_id, merged);

  const hasAttempts =
    (db.prepare('SELECT COUNT(*) AS c FROM attempts WHERE quiz_id = ?').get(quizId) as { c: number }).c > 0;
  if (input.questions && hasAttempts) {
    throw conflict('Candidates have already attempted this quiz, so its question list is locked.');
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE quizzes SET subject_id = ?, class_id = ?, title = ?, description = ?, instructions = ?,
              question_count = ?, time_limit_minutes = ?, max_attempts = ?, pass_percentage = ?,
              randomize_questions = ?, randomize_options = ?, immediate_results = ?, show_correct_answers = ?,
              allow_review = ?, negative_marking = ?, available_from = ?, available_until = ?,
              result_release_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      merged.subjectId,
      merged.classId ?? null,
      merged.title.trim(),
      merged.description?.trim() || null,
      merged.instructions?.trim() || null,
      merged.questionCount,
      merged.timeLimitMinutes,
      merged.maxAttempts,
      merged.passPercentage,
      merged.randomizeQuestions ? 1 : 0,
      merged.randomizeOptions ? 1 : 0,
      merged.immediateResults ? 1 : 0,
      merged.showCorrectAnswers ? 1 : 0,
      merged.allowReview ? 1 : 0,
      merged.negativeMarking ? 1 : 0,
      merged.availableFrom,
      merged.availableUntil,
      merged.resultReleaseAt ?? null,
      nowIso(),
      quizId,
    );

    if (input.questions) {
      db.prepare('DELETE FROM quiz_questions WHERE quiz_id = ?').run(quizId);
      const insert = db.prepare(
        'INSERT INTO quiz_questions (quiz_id, question_id, position, marks, negative_marks) VALUES (?,?,?,?,?)',
      );
      merged.questions.forEach((question, index) => {
        insert.run(
          quizId,
          question.questionId,
          question.position ?? index + 1,
          question.marks,
          merged.negativeMarking ? question.negativeMarks : 0,
        );
      });
    }
  })();

  recordAudit(db, {
    institutionId: quiz.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'quiz.updated',
    category: 'exam',
    resourceType: 'quiz',
    resourceId: quizId,
    description: `Updated quiz "${merged.title}"`,
    ...meta,
  });

  return getQuizOr404(db, actor, quizId);
}

const QUIZ_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SCHEDULED', 'ACTIVE', 'ARCHIVED'],
  SCHEDULED: ['ACTIVE', 'DRAFT', 'ARCHIVED'],
  ACTIVE: ['CLOSED', 'SCHEDULED', 'ARCHIVED'],
  CLOSED: ['ARCHIVED', 'ACTIVE'],
  ARCHIVED: [],
};

export function transitionQuiz(
  db: Db,
  actor: QuizActor,
  quizId: number,
  to: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): any {
  const quiz = getQuizOr404(db, actor, quizId);
  assertQuizOwnership(actor, quiz);
  if (quiz.status === to) throw validationError(`This quiz is already ${to.toLowerCase()}.`);
  if (!(QUIZ_TRANSITIONS[quiz.status] ?? []).includes(to)) {
    throw validationError(`A quiz cannot move from ${quiz.status} to ${to}.`);
  }
  if (to === 'SCHEDULED' || to === 'ACTIVE') {
    const questions = db.prepare('SELECT COUNT(*) AS c FROM quiz_questions WHERE quiz_id = ?').get(quizId) as { c: number };
    if (!questions.c) throw unprocessable('Add questions before publishing this quiz.');
    const assignments = db.prepare('SELECT COUNT(*) AS c FROM quiz_assignments WHERE quiz_id = ?').get(quizId) as {
      c: number;
    };
    if (!assignments.c) throw unprocessable('Assign this quiz to a class, group or candidate before publishing it.');
  }

  db.prepare('UPDATE quizzes SET status = ?, updated_at = ? WHERE id = ?').run(to, nowIso(), quizId);
  recordAudit(db, {
    institutionId: quiz.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: `quiz.${to.toLowerCase()}`,
    category: 'exam',
    resourceType: 'quiz',
    resourceId: quizId,
    description: `Quiz "${quiz.title}" moved from ${quiz.status} to ${to}`,
    ...meta,
  });
  return getQuizOr404(db, actor, quizId);
}

export function assignQuiz(
  db: Db,
  actor: QuizActor,
  quizId: number,
  input: { classIds?: number[]; groupIds?: number[]; studentIds?: number[] },
  meta: { ip?: string | null; userAgent?: string | null } = {},
): { assigned: number } {
  const quiz = getQuizOr404(db, actor, quizId);
  assertQuizOwnership(actor, quiz);
  const classIds = input.classIds ?? [];
  const groupIds = input.groupIds ?? [];
  const studentIds = input.studentIds ?? [];
  if (!classIds.length && !groupIds.length && !studentIds.length) {
    throw unprocessable('Select at least one class, group or candidate to assign.');
  }

  const timestamp = nowIso();
  const notifyUserIds = new Set<number>();
  db.transaction(() => {
    const insert = db.prepare(
      'INSERT INTO quiz_assignments (quiz_id, class_id, group_id, student_id, assigned_by, assigned_at) VALUES (?,?,?,?,?,?)',
    );
    const existsClass = db.prepare('SELECT id FROM quiz_assignments WHERE quiz_id = ? AND class_id = ?');
    const existsGroup = db.prepare('SELECT id FROM quiz_assignments WHERE quiz_id = ? AND group_id = ?');
    const existsStudent = db.prepare('SELECT id FROM quiz_assignments WHERE quiz_id = ? AND student_id = ?');
    for (const classId of classIds) {
      if (!existsClass.get(quizId, classId)) insert.run(quizId, classId, null, null, actor.id, timestamp);
      userIdsForClass(db, classId).forEach((id) => notifyUserIds.add(id));
    }
    for (const groupId of groupIds) {
      if (!existsGroup.get(quizId, groupId)) insert.run(quizId, null, groupId, null, actor.id, timestamp);
      userIdsForGroup(db, groupId).forEach((id) => notifyUserIds.add(id));
    }
    for (const studentId of studentIds) {
      if (!existsStudent.get(quizId, studentId)) insert.run(quizId, null, null, studentId, actor.id, timestamp);
      const userId = userIdForStudent(db, studentId);
      if (userId) notifyUserIds.add(userId);
    }
  })();

  for (const userId of notifyUserIds) {
    createNotification(db, {
      institutionId: quiz.institution_id,
      userId,
      type: 'quiz_assigned',
      title: 'New quiz available',
      body: `"${quiz.title}" is available until ${new Date(quiz.available_until).toUTCString()}.`,
      link: '/quizzes',
      severity: 'info',
      dedupeKey: `quiz_assigned:${quizId}`,
    });
  }

  recordAudit(db, {
    institutionId: quiz.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'quiz.assigned',
    category: 'exam',
    resourceType: 'quiz',
    resourceId: quizId,
    description: `Assigned quiz "${quiz.title}"`,
    metadata: { classIds, groupIds, studentIds },
    ...meta,
  });

  return { assigned: notifyUserIds.size };
}

export function unassignQuiz(
  db: Db,
  actor: QuizActor,
  quizId: number,
  assignmentId: number,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): void {
  const quiz = getQuizOr404(db, actor, quizId);
  assertQuizOwnership(actor, quiz);
  const assignment = db
    .prepare('SELECT * FROM quiz_assignments WHERE id = ? AND quiz_id = ?')
    .get(assignmentId, quizId) as any;
  if (!assignment) throw notFound('Assignment not found.');

  const attempts = db
    .prepare("SELECT COUNT(*) AS c FROM attempts WHERE quiz_id = ? AND status != 'VOID'")
    .get(quizId) as { c: number };
  if (attempts.c > 0) {
    throw conflict('Candidates have already attempted this quiz, so assignments can no longer be removed.');
  }

  db.prepare('DELETE FROM quiz_assignments WHERE id = ?').run(assignmentId);
  recordAudit(db, {
    institutionId: quiz.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'quiz.unassigned',
    category: 'exam',
    resourceType: 'quiz',
    resourceId: quizId,
    description: `Removed an assignment from "${quiz.title}"`,
    metadata: { assignmentId },
    ...meta,
  });
}

export function publishQuizResults(
  db: Db,
  actor: QuizActor,
  quizId: number,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): { published: number } {
  const quiz = getQuizOr404(db, actor, quizId);
  assertQuizOwnership(actor, quiz);
  const timestamp = nowIso();
  const info = db
    .prepare(
      'UPDATE results SET is_published = 1, published_at = ?, published_by = ?, updated_at = ? WHERE quiz_id = ? AND is_published = 0',
    )
    .run(timestamp, actor.id, timestamp, quizId);

  const students = db
    .prepare('SELECT student_id FROM attempts WHERE quiz_id = ?')
    .all(quizId) as { student_id: number }[];
  for (const student of students) {
    const userId = userIdForStudent(db, student.student_id);
    if (userId) {
      createNotification(db, {
        institutionId: quiz.institution_id,
        userId,
        type: 'result_published',
        title: 'Quiz result published',
        body: `Your result for "${quiz.title}" has been released.`,
        link: '/results',
        severity: 'success',
        dedupeKey: `result_published:quiz:${quizId}:${student.student_id}`,
      });
    }
  }

  recordAudit(db, {
    institutionId: quiz.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'result.published',
    category: 'result',
    resourceType: 'quiz',
    resourceId: quizId,
    description: `Published ${info.changes} quiz result(s)`,
    ...meta,
  });
  return { published: info.changes };
}
