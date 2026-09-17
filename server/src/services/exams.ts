import type { Db } from '../db';
import { assertExamTransition, canEditExam, ExamStatus } from '../lib/exam-lifecycle';
import { conflict, forbidden, notFound, unprocessable, validationError } from '../lib/errors';
import { nowIso } from '../lib/time';
import { recordAudit } from './audit';
import { finaliseAttempt } from './attempts';
import { createNotification, userIdForStudent, userIdsForClass, userIdsForGroup } from './notifications';

export interface ExamActor {
  id: number;
  institutionId: number | null;
  roleCode: string;
  fullName: string;
  teacherId?: number | null;
}

export interface ExamInput {
  subjectId: number;
  classId?: number | null;
  name: string;
  code: string;
  academicYear: string;
  semester?: string | null;
  examType: string;
  durationMinutes: number;
  startAt: string;
  endAt: string;
  passMarks: number;
  maxAttempts: number;
  instructions?: string | null;
  randomizeQuestions?: boolean;
  randomizeOptions?: boolean;
  negativeMarking?: boolean;
  gradingSchemeId?: number | null;
  resultReleaseAt?: string | null;
  questions: { questionId: number; marks: number; negativeMarks: number; position?: number }[];
}

/** A teacher may only manage examinations they created, unless they are an administrator. */
export function assertExamOwnership(_db: Db, actor: ExamActor, exam: { created_by: number }): void {
  if (actor.roleCode === 'super_admin' || actor.roleCode === 'institution_admin') return;
  if (actor.roleCode === 'teacher' && exam.created_by !== actor.id) {
    throw forbidden('You can only manage examinations that you created. Ask an administrator for access.');
  }
}

export function getExamOr404(db: Db, actor: ExamActor, examId: number): any {
  const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(examId) as any;
  if (!exam) throw notFound('Examination not found.');
  if (actor.institutionId !== null && exam.institution_id !== actor.institutionId) {
    throw notFound('Examination not found.');
  }
  return exam;
}

function computeTotalMarks(questions: { marks: number }[]): number {
  return Math.round(questions.reduce((sum, q) => sum + q.marks, 0) * 100) / 100;
}

function validateExamInput(db: Db, institutionId: number, input: ExamInput): void {
  const problems: string[] = [];
  if (!input.questions?.length) problems.push('An examination needs at least one question.');
  if (new Date(input.endAt) <= new Date(input.startAt)) {
    problems.push('The examination end time must be after the start time.');
  }
  if (input.durationMinutes <= 0) problems.push('Duration must be greater than zero.');

  const windowMinutes = (new Date(input.endAt).getTime() - new Date(input.startAt).getTime()) / 60000;
  if (input.durationMinutes > windowMinutes) {
    problems.push('The duration cannot exceed the length of the examination window.');
  }

  const subject = db
    .prepare('SELECT id FROM subjects WHERE id = ? AND institution_id = ?')
    .get(input.subjectId, institutionId);
  if (!subject) problems.push('The selected subject does not belong to this institution.');

  if (input.classId) {
    const klass = db
      .prepare('SELECT id FROM classes WHERE id = ? AND institution_id = ?')
      .get(input.classId, institutionId);
    if (!klass) problems.push('The selected class does not belong to this institution.');
  }

  if (input.gradingSchemeId) {
    const scheme = db
      .prepare('SELECT id FROM grading_schemes WHERE id = ? AND institution_id = ?')
      .get(input.gradingSchemeId, institutionId);
    if (!scheme) problems.push('The selected grading scheme does not belong to this institution.');
  }

  const total = computeTotalMarks(input.questions);
  if (input.passMarks > total) problems.push('Pass marks cannot exceed the total marks of the paper.');

  const ids = input.questions.map((q) => q.questionId);
  if (new Set(ids).size !== ids.length) problems.push('The same question cannot appear twice in one examination.');

  const found = db
    .prepare(
      `SELECT id FROM questions WHERE institution_id = ? AND id IN (${ids.map(() => '?').join(',') || 'NULL'})`,
    )
    .all(institutionId, ...ids) as { id: number }[];
  if (found.length !== ids.length) {
    problems.push('One or more questions do not belong to this institution.');
  }
  const objectiveCheck = db
    .prepare(
      `SELECT COUNT(*) AS c FROM questions WHERE id IN (${ids.map(() => '?').join(',') || 'NULL'}) AND status = 'ARCHIVED'`,
    )
    .get(...ids) as { c: number };
  if (objectiveCheck.c > 0) {
    problems.push('Archived questions cannot be added to a new examination.');
  }

  for (const question of input.questions) {
    if (question.marks <= 0) problems.push('Every question must be worth more than zero marks.');
  }

  if (problems.length) {
    throw unprocessable('The examination configuration is invalid.', problems.map((message) => ({ message })));
  }
}

export function createExam(
  db: Db,
  actor: ExamActor,
  input: ExamInput,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): any {
  if (!actor.institutionId) throw forbidden('Examinations must be created within an institution.');
  validateExamInput(db, actor.institutionId, input);

  const duplicateCode = db
    .prepare('SELECT id FROM exams WHERE institution_id = ? AND code = ?')
    .get(actor.institutionId, input.code.trim());
  if (duplicateCode) throw conflict('An examination with this code already exists in your institution.');

  const totalMarks = computeTotalMarks(input.questions);
  const timestamp = nowIso();

  const examId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO exams
          (institution_id, subject_id, class_id, created_by, name, code, academic_year, semester, exam_type,
           duration_minutes, start_at, end_at, total_marks, pass_marks, max_attempts, instructions,
           randomize_questions, randomize_options, negative_marking, grading_scheme_id, result_release_at,
           status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'DRAFT', ?, ?)`,
      )
      .run(
        actor.institutionId,
        input.subjectId,
        input.classId ?? null,
        actor.id,
        input.name.trim(),
        input.code.trim(),
        input.academicYear.trim(),
        input.semester?.trim() || null,
        input.examType,
        input.durationMinutes,
        input.startAt,
        input.endAt,
        totalMarks,
        input.passMarks,
        input.maxAttempts,
        input.instructions?.trim() || null,
        input.randomizeQuestions ? 1 : 0,
        input.randomizeOptions ? 1 : 0,
        input.negativeMarking ? 1 : 0,
        input.gradingSchemeId ?? null,
        input.resultReleaseAt ?? null,
        timestamp,
        timestamp,
      );
    const id = Number(info.lastInsertRowid);
    const insertQuestion = db.prepare(
      'INSERT INTO exam_questions (exam_id, question_id, position, marks, negative_marks) VALUES (?,?,?,?,?)',
    );
    input.questions.forEach((question, index) => {
      insertQuestion.run(
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
    action: 'exam.created',
    category: 'exam',
    resourceType: 'exam',
    resourceId: examId,
    description: `Created examination "${input.name}"`,
    metadata: { questions: input.questions.length, totalMarks },
    ...meta,
  });

  return getExamOr404(db, actor, examId);
}

export function updateExam(
  db: Db,
  actor: ExamActor,
  examId: number,
  input: Partial<ExamInput>,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): any {
  const exam = getExamOr404(db, actor, examId);
  assertExamOwnership(db, actor, exam);
  if (!canEditExam(exam.status as ExamStatus)) {
    throw conflict(
      'This examination can no longer be edited because it is active or has been processed. Archive it and create a new one instead.',
    );
  }

  const questions = input.questions
    ? input.questions
    : (db.prepare('SELECT question_id, marks, negative_marks, position FROM exam_questions WHERE exam_id = ? ORDER BY position').all(examId) as any[]).map(
        (row) => ({
          questionId: row.question_id,
          marks: row.marks,
          negativeMarks: row.negative_marks,
          position: row.position,
        }),
      );

  const merged: ExamInput = {
    subjectId: input.subjectId ?? exam.subject_id,
    classId: input.classId === undefined ? exam.class_id : input.classId,
    name: input.name ?? exam.name,
    code: input.code ?? exam.code,
    academicYear: input.academicYear ?? exam.academic_year,
    semester: input.semester === undefined ? exam.semester : input.semester,
    examType: input.examType ?? exam.exam_type,
    durationMinutes: input.durationMinutes ?? exam.duration_minutes,
    startAt: input.startAt ?? exam.start_at,
    endAt: input.endAt ?? exam.end_at,
    passMarks: input.passMarks ?? exam.pass_marks,
    maxAttempts: input.maxAttempts ?? exam.max_attempts,
    instructions: input.instructions === undefined ? exam.instructions : input.instructions,
    randomizeQuestions:
      input.randomizeQuestions === undefined ? Boolean(exam.randomize_questions) : input.randomizeQuestions,
    randomizeOptions:
      input.randomizeOptions === undefined ? Boolean(exam.randomize_options) : input.randomizeOptions,
    negativeMarking: input.negativeMarking === undefined ? Boolean(exam.negative_marking) : input.negativeMarking,
    gradingSchemeId: input.gradingSchemeId === undefined ? exam.grading_scheme_id : input.gradingSchemeId,
    resultReleaseAt: input.resultReleaseAt === undefined ? exam.result_release_at : input.resultReleaseAt,
    questions,
  };

  if (input.code && input.code !== exam.code) {
    const duplicate = db
      .prepare('SELECT id FROM exams WHERE institution_id = ? AND code = ? AND id != ?')
      .get(exam.institution_id, input.code.trim(), examId);
    if (duplicate) throw conflict('Another examination already uses this code.');
  }

  validateExamInput(db, exam.institution_id, merged);
  const totalMarks = computeTotalMarks(merged.questions);
  const timestamp = nowIso();

  db.transaction(() => {
    db.prepare(
      `UPDATE exams SET subject_id = ?, class_id = ?, name = ?, code = ?, academic_year = ?, semester = ?,
              exam_type = ?, duration_minutes = ?, start_at = ?, end_at = ?, total_marks = ?, pass_marks = ?,
              max_attempts = ?, instructions = ?, randomize_questions = ?, randomize_options = ?,
              negative_marking = ?, grading_scheme_id = ?, result_release_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      merged.subjectId,
      merged.classId ?? null,
      merged.name.trim(),
      merged.code.trim(),
      merged.academicYear.trim(),
      merged.semester?.trim() || null,
      merged.examType,
      merged.durationMinutes,
      merged.startAt,
      merged.endAt,
      totalMarks,
      merged.passMarks,
      merged.maxAttempts,
      merged.instructions?.trim() || null,
      merged.randomizeQuestions ? 1 : 0,
      merged.randomizeOptions ? 1 : 0,
      merged.negativeMarking ? 1 : 0,
      merged.gradingSchemeId ?? null,
      merged.resultReleaseAt ?? null,
      timestamp,
      examId,
    );

    if (input.questions) {
      const attemptExists = db
        .prepare("SELECT COUNT(*) AS c FROM attempts WHERE exam_id = ? AND status != 'VOID'")
        .get(examId) as { c: number };
      if (attemptExists.c > 0) {
        throw conflict('Candidates have already started this examination; the question paper is locked.');
      }
      db.prepare('DELETE FROM exam_questions WHERE exam_id = ?').run(examId);
      const insertQuestion = db.prepare(
        'INSERT INTO exam_questions (exam_id, question_id, position, marks, negative_marks) VALUES (?,?,?,?,?)',
      );
      merged.questions.forEach((question, index) => {
        insertQuestion.run(
          examId,
          question.questionId,
          question.position ?? index + 1,
          question.marks,
          merged.negativeMarking ? question.negativeMarks : 0,
        );
      });
    }
  })();

  recordAudit(db, {
    institutionId: exam.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'exam.updated',
    category: 'exam',
    resourceType: 'exam',
    resourceId: examId,
    description: `Updated examination "${merged.name}"`,
    metadata: { fields: Object.keys(input) },
    ...meta,
  });

  return getExamOr404(db, actor, examId);
}

export function transitionExam(
  db: Db,
  actor: ExamActor,
  examId: number,
  to: ExamStatus,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): any {
  const exam = getExamOr404(db, actor, examId);
  assertExamOwnership(db, actor, exam);
  const problem = assertExamTransition(exam.status as ExamStatus, to);
  if (problem) throw validationError(problem);

  if (to === 'SCHEDULED' || to === 'ACTIVE') {
    const questions = db.prepare('SELECT COUNT(*) AS c FROM exam_questions WHERE exam_id = ?').get(examId) as {
      c: number;
    };
    if (questions.c === 0) throw unprocessable('Add questions before scheduling this examination.');
    const assignments = db.prepare('SELECT COUNT(*) AS c FROM exam_assignments WHERE exam_id = ?').get(examId) as {
      c: number;
    };
    if (assignments.c === 0) {
      throw unprocessable('Assign this examination to at least one class, group or candidate before publishing it.');
    }
  }

  const timestamp = nowIso();
  const publishedAt = to === 'PUBLISHED' ? exam.published_at ?? timestamp : exam.published_at ?? null;
  const archivedAt = to === 'ARCHIVED' ? timestamp : null;
  db.prepare(
    'UPDATE exams SET status = ?, published_at = ?, archived_at = ?, updated_at = ? WHERE id = ?',
  ).run(to, publishedAt, archivedAt, timestamp, examId);

  recordAudit(db, {
    institutionId: exam.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: `exam.${to.toLowerCase()}`,
    category: 'exam',
    resourceType: 'exam',
    resourceId: examId,
    description: `Examination "${exam.name}" moved from ${exam.status} to ${to}`,
    metadata: { from: exam.status, to },
    ...meta,
  });

  return getExamOr404(db, actor, examId);
}

/** Publishing an examination releases every graded result attached to it. */
export function publishExamResults(
  db: Db,
  actor: ExamActor,
  examId: number,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): { published: number } {
  const exam = getExamOr404(db, actor, examId);
  assertExamOwnership(db, actor, exam);

  // Publication is blocked only while subjective answers genuinely remain unmarked.
  const ungraded = db
    .prepare(
      `SELECT COUNT(*) AS c FROM attempts a
        WHERE a.exam_id = ? AND a.status IN ('SUBMITTED','UNDER_REVIEW')
          AND EXISTS (
            SELECT 1 FROM attempt_questions aq
             LEFT JOIN answers an ON an.attempt_id = aq.attempt_id AND an.question_id = aq.question_id
             WHERE aq.attempt_id = a.id AND aq.is_objective = 0
               AND (an.id IS NULL OR an.awarded_marks IS NULL))`,
    )
    .get(examId) as { c: number };
  if (ungraded.c > 0) {
    throw conflict(
      `${ungraded.c} submission(s) still have unmarked written answers. Complete the grading queue before publishing results.`,
    );
  }

  // Attempts that are fully marked are finalised so their lifecycle state matches their result.
  const readyToFinalise = db
    .prepare(
      "SELECT id FROM attempts WHERE exam_id = ? AND status IN ('SUBMITTED','UNDER_REVIEW')",
    )
    .all(examId) as { id: number }[];
  for (const attempt of readyToFinalise) {
    try {
      finaliseAttempt(db, actor, attempt.id, { reason: 'result_publication' });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[results] failed to finalise attempt before publication', attempt.id, error);
    }
  }

  const timestamp = nowIso();
  const info = db
    .prepare(
      `UPDATE results SET is_published = 1, published_at = ?, published_by = ?, updated_at = ?
        WHERE exam_id = ? AND is_published = 0`,
    )
    .run(timestamp, actor.id, timestamp, examId);

  db.prepare(
    "UPDATE attempts SET result_published_at = ?, result_published_by = ?, updated_at = ? WHERE exam_id = ? AND result_published_at IS NULL",
  ).run(timestamp, actor.id, timestamp, examId);

  if (exam.status !== 'PUBLISHED') {
    // Publishing results also advances the lifecycle when it is still under review.
    const problem = assertExamTransition(exam.status as ExamStatus, 'PUBLISHED');
    if (!problem) {
      db.prepare("UPDATE exams SET status = 'PUBLISHED', published_at = ?, updated_at = ? WHERE id = ?").run(
        timestamp,
        timestamp,
        examId,
      );
    }
  }

  // Notify every candidate whose result is now visible.
  const students = db
    .prepare(
      `SELECT a.student_id, COALESCE(e.name, qz.title) AS paper
         FROM attempts a
         LEFT JOIN exams e ON e.id = a.exam_id
         LEFT JOIN quizzes qz ON qz.id = a.quiz_id
        WHERE a.exam_id = ?`,
    )
    .all(examId) as { student_id: number; paper: string }[];
  for (const student of students) {
    const userId = userIdForStudent(db, student.student_id);
    if (userId) {
      createNotification(db, {
        institutionId: exam.institution_id,
        userId,
        type: 'result_published',
        title: 'Result published',
        body: `Your result for "${student.paper}" has been released.`,
        link: '/student/results',
        severity: 'success',
        dedupeKey: `result_published:exam:${examId}:${student.student_id}`,
      });
    }
  }

  recordAudit(db, {
    institutionId: exam.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'result.published',
    category: 'result',
    resourceType: 'exam',
    resourceId: examId,
    description: `Published ${info.changes} result(s) for "${exam.name}"`,
    metadata: { count: info.changes },
    ...meta,
  });

  return { published: info.changes };
}

export interface AssignmentInput {
  classIds?: number[];
  groupIds?: number[];
  studentIds?: number[];
}

export function assignExam(
  db: Db,
  actor: ExamActor,
  examId: number,
  input: AssignmentInput,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): { assigned: number } {
  const exam = getExamOr404(db, actor, examId);
  assertExamOwnership(db, actor, exam);
  if (exam.status === 'ARCHIVED') throw conflict('An archived examination cannot be assigned.');

  const classIds = input.classIds ?? [];
  const groupIds = input.groupIds ?? [];
  const studentIds = input.studentIds ?? [];
  if (!classIds.length && !groupIds.length && !studentIds.length) {
    throw unprocessable('Select at least one class, group or candidate to assign.');
  }

  for (const classId of classIds) {
    const row = db.prepare('SELECT id FROM classes WHERE id = ? AND institution_id = ?').get(classId, exam.institution_id);
    if (!row) throw validationError('One of the selected classes does not belong to this institution.');
  }
  for (const groupId of groupIds) {
    const row = db.prepare('SELECT id FROM groups WHERE id = ? AND institution_id = ?').get(groupId, exam.institution_id);
    if (!row) throw validationError('One of the selected groups does not belong to this institution.');
  }
  for (const studentId of studentIds) {
    const row = db
      .prepare('SELECT id FROM students WHERE id = ? AND institution_id = ?')
      .get(studentId, exam.institution_id);
    if (!row) throw validationError('One of the selected candidates does not belong to this institution.');
  }

  const timestamp = nowIso();
  const notifyUserIds = new Set<number>();

  db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO exam_assignments (exam_id, class_id, group_id, student_id, assigned_by, assigned_at)
       VALUES (?,?,?,?,?,?)`,
    );
    const existsClass = db.prepare('SELECT id FROM exam_assignments WHERE exam_id = ? AND class_id = ?');
    const existsGroup = db.prepare('SELECT id FROM exam_assignments WHERE exam_id = ? AND group_id = ?');
    const existsStudent = db.prepare('SELECT id FROM exam_assignments WHERE exam_id = ? AND student_id = ?');

    for (const classId of classIds) {
      if (!existsClass.get(examId, classId)) insert.run(examId, classId, null, null, actor.id, timestamp);
      userIdsForClass(db, classId).forEach((id) => notifyUserIds.add(id));
    }
    for (const groupId of groupIds) {
      if (!existsGroup.get(examId, groupId)) insert.run(examId, null, groupId, null, actor.id, timestamp);
      userIdsForGroup(db, groupId).forEach((id) => notifyUserIds.add(id));
    }
    for (const studentId of studentIds) {
      if (!existsStudent.get(examId, studentId)) insert.run(examId, null, null, studentId, actor.id, timestamp);
      const userId = userIdForStudent(db, studentId);
      if (userId) notifyUserIds.add(userId);
    }
  })();

  for (const userId of notifyUserIds) {
    createNotification(db, {
      institutionId: exam.institution_id,
      userId,
      type: 'exam_assigned',
      title: 'New examination assigned',
      body: `"${exam.name}" is scheduled for ${new Date(exam.start_at).toUTCString()}.`,
      link: '/student/examinations',
      severity: 'info',
      dedupeKey: `exam_assigned:${examId}`,
    });
  }

  recordAudit(db, {
    institutionId: exam.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'exam.assigned',
    category: 'exam',
    resourceType: 'exam',
    resourceId: examId,
    description: `Assigned "${exam.name}" to ${classIds.length} class(es), ${groupIds.length} group(s), ${studentIds.length} candidate(s)`,
    metadata: { classIds, groupIds, studentIds },
    ...meta,
  });

  return { assigned: notifyUserIds.size };
}

export function unassignExam(
  db: Db,
  actor: ExamActor,
  examId: number,
  assignmentId: number,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): void {
  const exam = getExamOr404(db, actor, examId);
  assertExamOwnership(db, actor, exam);
  const assignment = db
    .prepare('SELECT * FROM exam_assignments WHERE id = ? AND exam_id = ?')
    .get(assignmentId, examId) as any;
  if (!assignment) throw notFound('Assignment not found.');

  const attempts = db
    .prepare("SELECT COUNT(*) AS c FROM attempts WHERE exam_id = ? AND status != 'VOID'")
    .get(examId) as { c: number };
  if (attempts.c > 0) {
    throw conflict('Candidates have already attempted this examination, so assignments can no longer be removed.');
  }

  db.prepare('DELETE FROM exam_assignments WHERE id = ?').run(assignmentId);
  recordAudit(db, {
    institutionId: exam.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'exam.unassigned',
    category: 'exam',
    resourceType: 'exam',
    resourceId: examId,
    description: `Removed an assignment from "${exam.name}"`,
    metadata: { assignmentId },
    ...meta,
  });
}

/** Publishes results for individual attempts (used from the results screen). */
export function publishAttemptResults(
  db: Db,
  actor: ExamActor,
  attemptIds: number[],
  publish: boolean,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): { updated: number } {
  if (!attemptIds.length) throw unprocessable('Select at least one result.');
  const timestamp = nowIso();

  const updated = db.transaction(() => {
    let count = 0;
    for (const attemptId of attemptIds) {
      const attempt = db
        .prepare('SELECT id, institution_id, student_id, status, exam_id, quiz_id FROM attempts WHERE id = ?')
        .get(attemptId) as any;
      if (!attempt) throw notFound(`Attempt #${attemptId} was not found.`);
      if (actor.institutionId !== null && attempt.institution_id !== actor.institutionId) {
        throw forbidden('You cannot publish results for another institution.');
      }
      const result = db.prepare('SELECT id, is_published FROM results WHERE attempt_id = ?').get(attemptId) as
        | { id: number; is_published: number }
        | undefined;
      if (!result) throw notFound(`No result exists for attempt #${attemptId}.`);

      if (publish) {
        if (attempt.status === 'UNDER_REVIEW') {
          throw conflict('Submission still needs manual grading before its result can be published.');
        }
        if (!result.is_published) {
          db.prepare(
            'UPDATE results SET is_published = 1, published_at = ?, published_by = ?, updated_at = ? WHERE id = ?',
          ).run(timestamp, actor.id, timestamp, result.id);
          db.prepare(
            'UPDATE attempts SET result_published_at = ?, result_published_by = ?, updated_at = ? WHERE id = ?',
          ).run(timestamp, actor.id, timestamp, attemptId);
          count += 1;

          const userId = userIdForStudent(db, attempt.student_id);
          const paper =
            (db.prepare('SELECT name FROM exams WHERE id = ?').get(attempt.exam_id) as { name: string } | undefined)
              ?.name ??
            (db.prepare('SELECT title FROM quizzes WHERE id = ?').get(attempt.quiz_id) as { title: string } | undefined)
              ?.title ??
            'your paper';
          if (userId) {
            createNotification(db, {
              institutionId: attempt.institution_id,
              userId,
              type: 'result_published',
              title: 'Your result has been published',
              body: `The result for "${paper}" is now available on your dashboard.`,
              link: '/student/results',
              severity: 'success',
              dedupeKey: `result_published:attempt:${attemptId}`,
            });
          }
        }
      } else if (result.is_published) {
        db.prepare('UPDATE results SET is_published = 0, updated_at = ? WHERE id = ?').run(timestamp, result.id);
        db.prepare('UPDATE attempts SET result_published_at = NULL, result_published_by = NULL, updated_at = ? WHERE id = ?').run(
          timestamp,
          attemptId,
        );
        count += 1;
      }
    }
    return count;
  })();

  recordAudit(db, {
    institutionId: actor.institutionId,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: publish ? 'result.published' : 'result.unpublished',
    category: 'result',
    resourceType: 'attempt',
    resourceId: attemptIds.join(','),
    description: `${publish ? 'Published' : 'Unpublished'} ${updated} result(s)`,
    metadata: { attemptIds },
    ...meta,
  });

  return { updated };
}
