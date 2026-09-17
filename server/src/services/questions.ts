import type { Db } from '../db';
import { conflict, notFound, unprocessable, validationError } from '../lib/errors';
import { parseAnswerConfig, QuestionType } from '../lib/answer-key';
import { nowIso } from '../lib/time';
import { recordAudit } from './audit';

export interface QuestionOptionInput {
  label: string;
  text: string;
  isCorrect?: boolean;
  position?: number;
}

export interface QuestionInput {
  questionBankId: number;
  subjectId: number;
  type: QuestionType;
  text: string;
  explanation?: string | null;
  marks: number;
  negativeMarks?: number;
  difficulty?: 'EASY' | 'MEDIUM' | 'HARD';
  topic?: string | null;
  tags?: string[];
  status?: 'ACTIVE' | 'ARCHIVED';
  options?: QuestionOptionInput[];
  answerConfig?: {
    caseSensitive?: boolean;
    allowPartial?: boolean;
    numericTolerance?: number;
    acceptedAnswers?: string[];
  };
}

export interface QuestionRow {
  id: number;
  institution_id: number;
  question_bank_id: number;
  subject_id: number;
  topic: string | null;
  type: QuestionType;
  text: string;
  explanation: string | null;
  marks: number;
  negative_marks: number;
  difficulty: string;
  status: string;
  tags: string;
  answer_config: string;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
}

const OBJECTIVE_TYPES: QuestionType[] = ['MCQ', 'TRUE_FALSE', 'FILL_BLANK'];

/**
 * Validates a question payload against the rules of its type. Objective questions
 * need a machine-checkable key; subjective questions never do.
 */
export function validateQuestionPayload(input: QuestionInput): void {
  const problems: string[] = [];
  if (!input.text?.trim()) problems.push('Question text is required.');

  if (input.type === 'MCQ') {
    const options = (input.options ?? []).filter((o) => o.text?.trim());
    if (options.length < 2) problems.push('A multiple-choice question needs at least two options.');
    const correct = options.filter((o) => o.isCorrect);
    if (correct.length === 0) problems.push('Select the correct option for this multiple-choice question.');
    if (correct.length > 1 && !input.answerConfig?.allowPartial) {
      problems.push(
        'Multiple correct options require "partial credit for multi-select" to be enabled, or reduce the key to one option.',
      );
    }
    const labels = new Set<string>();
    for (const option of options) {
      const label = option.label?.trim().toUpperCase();
      if (!label) problems.push('Every option needs a label (A, B, C …).');
      if (labels.has(label)) problems.push(`Duplicate option label ${label}.`);
      labels.add(label);
    }
    if (!correct.length && options.length === 0) problems.push('Options are required.');
  }

  if (input.type === 'TRUE_FALSE') {
    const options = input.options ?? [];
    const texts = options.map((o) => o.text.trim().toLowerCase());
    if (options.length !== 2 || !texts.includes('true') || !texts.includes('false')) {
      problems.push('A true/false question must have exactly the "True" and "False" options.');
    }
    if (!options.some((o) => o.isCorrect)) problems.push('Select whether the statement is true or false.');
  }

  if (input.type === 'FILL_BLANK') {
    const accepted = input.answerConfig?.acceptedAnswers ?? [];
    if (!accepted.some((a) => a && a.trim())) {
      problems.push('Provide at least one accepted answer for this fill-in-the-blank question.');
    }
    if (input.negativeMarks && input.negativeMarks > 0 && input.marks <= 0) {
      problems.push('Negative marking requires a positive mark value.');
    }
  }

  if (input.marks <= 0) problems.push('Marks must be greater than zero.');
  if (input.negativeMarks && input.negativeMarks > input.marks) {
    problems.push('Negative marks cannot exceed the marks for a correct answer.');
  }

  if (problems.length) {
    throw unprocessable('The question could not be saved.', problems.map((message) => ({ message })));
  }
}

export function isObjective(type: QuestionType): boolean {
  return OBJECTIVE_TYPES.includes(type);
}

/** Machine-checkable key stored with the question (options for MCQ, accepted answers for text). */
export function buildAnswerKey(
  input: QuestionInput,
  options: QuestionOptionInput[],
): Record<string, unknown> {
  if (input.type === 'MCQ' || input.type === 'TRUE_FALSE') {
    return {
      correctOptions: options.filter((o) => o.isCorrect).map((o) => o.label.trim().toUpperCase()),
      allowPartial: Boolean(input.answerConfig?.allowPartial),
    };
  }
  if (input.type === 'FILL_BLANK') {
    return {
      acceptedAnswers: (input.answerConfig?.acceptedAnswers ?? []).map((a) => a.trim()).filter(Boolean),
      caseSensitive: Boolean(input.answerConfig?.caseSensitive),
      numericTolerance: input.answerConfig?.numericTolerance ?? 0,
    };
  }
  return { manual: true };
}

export function createQuestion(
  db: Db,
  actor: { id: number; institutionId: number | null; roleCode: string; fullName: string },
  input: QuestionInput,
  requestMeta: { ip?: string | null; userAgent?: string | null } = {},
): QuestionRow {
  validateQuestionPayload(input);
  const bank = db
    .prepare('SELECT id, institution_id, subject_id FROM question_banks WHERE id = ?')
    .get(input.questionBankId) as { id: number; institution_id: number; subject_id: number } | undefined;
  if (!bank) throw notFound('Question bank not found.');
  if (actor.institutionId !== null && bank.institution_id !== actor.institutionId) {
    throw notFound('Question bank not found.');
  }
  if (bank.subject_id !== input.subjectId) {
    throw validationError('The selected subject does not belong to this question bank.');
  }

  const timestamp = nowIso();
  const options = (input.options ?? []).map((option, index) => ({
    label: option.label.trim().toUpperCase(),
    text: option.text.trim(),
    isCorrect: Boolean(option.isCorrect),
    position: option.position ?? index,
  }));

  const created = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO questions
          (institution_id, question_bank_id, subject_id, topic, type, text, explanation, marks,
           negative_marks, difficulty, status, tags, answer_config, created_by, updated_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        bank.institution_id,
        bank.id,
        input.subjectId,
        input.topic?.trim() || null,
        input.type,
        input.text.trim(),
        input.explanation?.trim() || null,
        input.marks,
        input.negativeMarks ?? 0,
        input.difficulty ?? 'MEDIUM',
        input.status ?? 'ACTIVE',
        JSON.stringify(input.tags ?? []),
        JSON.stringify(buildAnswerKey(input, options)),
        actor.id,
        actor.id,
        timestamp,
        timestamp,
      );
    const questionId = Number(info.lastInsertRowid);
    insertOptions(db, questionId, options);
    return questionId;
  })();

  recordAudit(db, {
    institutionId: bank.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'question.created',
    category: 'question',
    resourceType: 'question',
    resourceId: created,
    description: `Created ${input.type} question`,
    metadata: { bankId: bank.id, subjectId: input.subjectId, marks: input.marks },
    ...requestMeta,
  });

  return getQuestion(db, created) as QuestionRow;
}

function insertOptions(
  db: Db,
  questionId: number,
  options: { label: string; text: string; isCorrect: boolean; position: number }[],
): void {
  const stmt = db.prepare(
    'INSERT INTO question_options (question_id, label, text, is_correct, position, created_at) VALUES (?,?,?,?,?,?)',
  );
  const timestamp = nowIso();
  options.forEach((option) => {
    stmt.run(questionId, option.label, option.text, option.isCorrect ? 1 : 0, option.position, timestamp);
  });
}

export function getQuestion(db: Db, id: number): (QuestionRow & { options: any[]; answerKey: any }) | undefined {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow | undefined;
  if (!row) return undefined;
  const options = db
    .prepare('SELECT id, label, text, is_correct, position FROM question_options WHERE question_id = ? ORDER BY position, label')
    .all(id);
  return { ...row, options, answerKey: parseAnswerConfig(row.answer_config) };
}

export function updateQuestion(
  db: Db,
  actor: { id: number; institutionId: number | null; roleCode: string; fullName: string },
  id: number,
  input: Partial<QuestionInput>,
  requestMeta: { ip?: string | null; userAgent?: string | null } = {},
): QuestionRow {
  const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow | undefined;
  if (!existing) throw notFound('Question not found.');
  if (actor.institutionId !== null && existing.institution_id !== actor.institutionId) {
    throw notFound('Question not found.');
  }

  const merged: QuestionInput = {
    questionBankId: input.questionBankId ?? existing.question_bank_id,
    subjectId: input.subjectId ?? existing.subject_id,
    type: (input.type ?? existing.type) as QuestionType,
    text: input.text ?? existing.text,
    explanation: input.explanation ?? existing.explanation,
    marks: input.marks ?? existing.marks,
    negativeMarks: input.negativeMarks ?? existing.negative_marks,
    difficulty: (input.difficulty ?? existing.difficulty) as 'EASY' | 'MEDIUM' | 'HARD',
    topic: input.topic ?? existing.topic,
    tags: input.tags ?? (JSON.parse(existing.tags) as string[]),
    status: (input.status ?? existing.status) as 'ACTIVE' | 'ARCHIVED',
    options: input.options,
    answerConfig: input.answerConfig ?? parseAnswerConfig(existing.answer_config),
  };

  if (!input.options) {
    // Preserve existing option set (and its correctness flags) when options are not resubmitted.
    const current = db
      .prepare('SELECT label, text, is_correct FROM question_options WHERE question_id = ? ORDER BY position, label')
      .all(id) as { label: string; text: string; is_correct: number }[];
    merged.options = current.map((o) => ({ label: o.label, text: o.text, isCorrect: Boolean(o.is_correct) }));
  }

  validateQuestionPayload(merged);

  const options = (merged.options ?? []).map((option, index) => ({
    label: option.label.trim().toUpperCase(),
    text: option.text.trim(),
    isCorrect: Boolean(option.isCorrect),
    position: option.position ?? index,
  }));
  const timestamp = nowIso();

  db.transaction(() => {
    db.prepare(
      `UPDATE questions SET subject_id = ?, type = ?, text = ?, explanation = ?, marks = ?, negative_marks = ?,
              difficulty = ?, topic = ?, status = ?, tags = ?, answer_config = ?, updated_by = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      merged.subjectId,
      merged.type,
      merged.text.trim(),
      merged.explanation?.toString().trim() || null,
      merged.marks,
      merged.negativeMarks ?? 0,
      merged.difficulty,
      merged.topic?.toString().trim() || null,
      merged.status,
      JSON.stringify(merged.tags ?? []),
      JSON.stringify(buildAnswerKey(merged, options)),
      actor.id,
      timestamp,
      id,
    );
    if (merged.type !== 'SHORT_ANSWER' && merged.type !== 'ESSAY') {
      db.prepare('DELETE FROM question_options WHERE question_id = ?').run(id);
      insertOptions(db, id, options);
    } else {
      db.prepare('DELETE FROM question_options WHERE question_id = ?').run(id);
    }
  })();

  recordAudit(db, {
    institutionId: existing.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'question.updated',
    category: 'question',
    resourceType: 'question',
    resourceId: id,
    description: `Updated question #${id}`,
    metadata: { fields: Object.keys(input) },
    ...requestMeta,
  });

  return getQuestion(db, id) as QuestionRow;
}

export function duplicateQuestion(
  db: Db,
  actor: { id: number; institutionId: number | null; roleCode: string; fullName: string },
  id: number,
  requestMeta: { ip?: string | null; userAgent?: string | null } = {},
): QuestionRow {
  const source = getQuestion(db, id);
  if (!source) throw notFound('Question not found.');
  if (actor.institutionId !== null && source.institution_id !== actor.institutionId) {
    throw notFound('Question not found.');
  }
  return createQuestion(
    db,
    actor,
    {
      questionBankId: source.question_bank_id,
      subjectId: source.subject_id,
      type: source.type,
      text: `${source.text}`,
      explanation: source.explanation,
      marks: source.marks,
      negativeMarks: source.negative_marks,
      difficulty: source.difficulty as 'EASY' | 'MEDIUM' | 'HARD',
      topic: source.topic,
      tags: JSON.parse(source.tags) as string[],
      status: 'ACTIVE',
      options: source.options.map((o: any) => ({
        label: o.label,
        text: o.text,
        isCorrect: Boolean(o.is_correct),
      })),
      answerConfig: source.answerKey,
    },
    requestMeta,
  );
}

/**
 * Questions used by a live or historical examination are never deleted — they are
 * archived so that results remain reproducible.
 */
export function archiveQuestion(
  db: Db,
  actor: { id: number; institutionId: number | null; roleCode: string; fullName: string },
  id: number,
  archived: boolean,
  requestMeta: { ip?: string | null; userAgent?: string | null } = {},
): QuestionRow {
  const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow | undefined;
  if (!existing) throw notFound('Question not found.');
  if (actor.institutionId !== null && existing.institution_id !== actor.institutionId) {
    throw notFound('Question not found.');
  }
  db.prepare('UPDATE questions SET status = ?, archived_at = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(
    archived ? 'ARCHIVED' : 'ACTIVE',
    archived ? nowIso() : null,
    actor.id,
    nowIso(),
    id,
  );
  recordAudit(db, {
    institutionId: existing.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: archived ? 'question.archived' : 'question.restored',
    category: 'question',
    resourceType: 'question',
    resourceId: id,
    description: archived ? `Archived question #${id}` : `Restored question #${id}`,
    ...requestMeta,
  });
  return getQuestion(db, id) as QuestionRow;
}

/** Hard delete is only allowed when nothing references the question. */
export function deleteQuestion(
  db: Db,
  actor: { id: number; institutionId: number | null; roleCode: string; fullName: string },
  id: number,
  requestMeta: { ip?: string | null; userAgent?: string | null } = {},
): void {
  const existing = db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow | undefined;
  if (!existing) throw notFound('Question not found.');
  if (actor.institutionId !== null && existing.institution_id !== actor.institutionId) {
    throw notFound('Question not found.');
  }
  const refs = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM exam_questions WHERE question_id = ?) AS exams,
         (SELECT COUNT(*) FROM quiz_questions WHERE question_id = ?) AS quizzes,
         (SELECT COUNT(*) FROM answers WHERE question_id = ?) AS answers,
         (SELECT COUNT(*) FROM attempt_questions WHERE question_id = ?) AS papers`,
    )
    .get(id, id, id, id) as { exams: number; quizzes: number; answers: number; papers: number };

  if (refs.exams + refs.quizzes + refs.answers + refs.papers > 0) {
    throw conflict(
      'This question is referenced by examinations, quizzes, or historical attempts. Archive it instead of deleting it.',
    );
  }

  db.transaction(() => {
    db.prepare('DELETE FROM question_options WHERE question_id = ?').run(id);
    db.prepare('DELETE FROM questions WHERE id = ?').run(id);
  })();

  recordAudit(db, {
    institutionId: existing.institution_id,
    userId: actor.id,
    actorName: actor.fullName,
    actorRole: actor.roleCode,
    action: 'question.deleted',
    category: 'question',
    resourceType: 'question',
    resourceId: id,
    description: `Deleted unused question #${id}`,
    ...requestMeta,
  });
}
