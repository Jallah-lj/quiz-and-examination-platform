/**
 * Examination / quiz attempt engine.
 *
 * The server is the single authority for timing, eligibility and marking:
 *  - the paper served to a candidate is a frozen snapshot (historical reproducibility);
 *  - remaining time is always derived from `attempts.expires_at`;
 *  - answers can only be written while the attempt is IN_PROGRESS and not expired;
 *  - submission locks the attempt and grades objective answers deterministically.
 */
import type { Db } from '../db';
import { env } from '../config/env';
import {
  AnswerKey,
  gradeObjective,
  isObjectiveType,
  parseAnswerConfig,
  QuestionType,
  round2,
} from '../lib/answer-key';
import { conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { computeFinalScore, resolveScheme } from '../lib/grading';
import { addMinutes, minIso, nowIso, secondsBetween } from '../lib/time';
import type { AuthedRequest } from '../types';
import { createNotification } from './notifications';

export interface AttemptActor {
  id: number;
  institutionId: number | null;
  roleCode: string;
  fullName: string;
  studentId: number | null;
}

interface PaperRow {
  id: number;
  type: QuestionType;
  text: string;
  explanation: string | null;
  marks: number;
  negative_marks: number;
  answer_config: string;
  topic: string | null;
  difficulty: string;
}

interface SnapshotQuestion {
  questionId: number;
  type: QuestionType;
  text: string;
  explanation: string | null;
  topic: string | null;
  difficulty: string;
  marks: number;
  negativeMarks: number;
  options: { label: string; text: string }[];
  answerConfig: Record<string, unknown>;
  correct: AnswerKey;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function snapshotQuestion(row: PaperRow, randomizeOptions: boolean): SnapshotQuestion {
  const options = row.type === 'MCQ' || row.type === 'TRUE_FALSE'
    ? (row as unknown as { options?: { label: string; text: string }[] }).options ?? []
    : [];
  const ordered = randomizeOptions ? shuffle(options) : options;
  const config = parseAnswerConfig(row.answer_config) as AnswerKey & Record<string, unknown>;
  return {
    questionId: row.id,
    type: row.type,
    text: row.text,
    explanation: row.explanation,
    topic: row.topic,
    difficulty: row.difficulty,
    marks: row.marks,
    negativeMarks: row.negative_marks,
    options: ordered.map((o) => ({ label: o.label, text: o.text })),
    answerConfig: config as Record<string, unknown>,
    correct: {
      correctOptions: (config.correctOptions ?? []).map((l) => String(l).toUpperCase()),
      acceptedAnswers: config.acceptedAnswers ?? [],
      caseSensitive: Boolean(config.caseSensitive),
      allowPartial: Boolean(config.allowPartial),
      numericTolerance: config.numericTolerance ?? 0,
    },
  };
}

/** Loads the source paper for an exam or quiz. */
function loadExamPaper(db: Db, examId: number): PaperRow[] {
  return db
    .prepare(
      `SELECT q.id, q.type, q.text, q.explanation, COALESCE(ev.marks, q.marks) AS marks,
              COALESCE(ev.negative_marks, q.negative_marks) AS negative_marks,
              q.answer_config, q.topic, q.difficulty
         FROM exam_questions ev
         JOIN questions q ON q.id = ev.question_id
        WHERE ev.exam_id = ?
        ORDER BY ev.position ASC, q.id ASC`,
    )
    .all(examId) as PaperRow[];
}

function attachOptions(db: Db, rows: PaperRow[]): void {
  if (!rows.length) return;
  const placeholders = rows.map(() => '?').join(',');
  const options = db
    .prepare(
      `SELECT question_id, label, text FROM question_options
        WHERE question_id IN (${placeholders}) ORDER BY position ASC, label ASC`,
    )
    .all(...rows.map((r) => r.id)) as { question_id: number; label: string; text: string }[];
  const byQuestion = new Map<number, { label: string; text: string }[]>();
  for (const option of options) {
    const list = byQuestion.get(option.question_id) ?? [];
    list.push({ label: option.label, text: option.text });
    byQuestion.set(option.question_id, list);
  }
  for (const row of rows) {
    (row as unknown as { options: { label: string; text: string }[] }).options =
      byQuestion.get(row.id) ?? [];
  }
}

function loadQuizPaper(db: Db, quizId: number, randomize: boolean, limit: number): PaperRow[] {
  const rows = db
    .prepare(
      `SELECT q.id, q.type, q.text, q.explanation, qq.marks AS marks, qq.negative_marks AS negative_marks,
              q.answer_config, q.topic, q.difficulty, qq.position
         FROM quiz_questions qq
         JOIN questions q ON q.id = qq.question_id
        WHERE qq.quiz_id = ? AND q.status = 'ACTIVE'
        ORDER BY qq.position ASC, q.id ASC`,
    )
    .all(quizId) as PaperRow[];
  const pool = randomize ? shuffle(rows) : rows;
  return pool.slice(0, limit);
}

export interface StartAttemptResult {
  attemptId: number;
  targetKind: 'exam' | 'quiz';
  targetId: number;
  attemptNo: number;
  status: string;
  startedAt: string;
  expiresAt: string;
  serverTime: string;
  remainingSeconds: number;
  resumed: boolean;
}

function assertStudentContext(actor: AttemptActor): number {
  if (actor.roleCode !== 'student' || !actor.studentId) {
    throw forbidden('Only candidates can sit an examination.');
  }
  return actor.studentId;
}

function isAssigned(db: Db, studentId: number, kind: 'exam' | 'quiz', targetId: number): boolean {
  const student = db
    .prepare('SELECT class_id, institution_id FROM students WHERE id = ?')
    .get(studentId) as { class_id: number | null; institution_id: number } | undefined;
  if (!student) return false;
  const table = kind === 'exam' ? 'exam_assignments' : 'quiz_assignments';
  const column = kind === 'exam' ? 'exam_id' : 'quiz_id';

  // A candidate is eligible when the paper is assigned to them directly or to their class.
  const direct = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${table}
        WHERE ${column} = @targetId AND (student_id = @studentId OR class_id = @classId)`,
    )
    .get({ targetId, studentId, classId: student.class_id ?? -1 }) as { c: number };
  if (direct.c > 0) return true;

  const groups = db
    .prepare('SELECT group_id FROM group_members WHERE student_id = ?')
    .all(studentId) as { group_id: number }[];
  if (!groups.length) return false;
  const placeholders = groups.map(() => '?').join(',');
  const viaGroup = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${table}
        WHERE ${column} = ? AND group_id IN (${placeholders})`,
    )
    .get(targetId, ...groups.map((g) => g.group_id)) as { c: number };
  return viaGroup.c > 0;
}

/** Lazily advances a SCHEDULED examination whose window has opened. */
export function ensureExamIsOpen(db: Db, examId: number, now: string): void {
  const exam = db.prepare('SELECT id, status, start_at, end_at FROM exams WHERE id = ?').get(examId) as
    | { id: number; status: string; start_at: string; end_at: string }
    | undefined;
  if (!exam) return;
  if (exam.status === 'SCHEDULED' && now >= exam.start_at && now <= exam.end_at) {
    db.prepare("UPDATE exams SET status = 'ACTIVE', updated_at = ? WHERE id = ? AND status = 'SCHEDULED'").run(
      now,
      examId,
    );
  }
}

export function ensureQuizIsOpen(db: Db, quizId: number, now: string): void {
  const quiz = db
    .prepare('SELECT id, status, available_from, available_until FROM quizzes WHERE id = ?')
    .get(quizId) as
    | { id: number; status: string; available_from: string; available_until: string }
    | undefined;
  if (!quiz) return;
  if (quiz.status === 'SCHEDULED' && now >= quiz.available_from && now <= quiz.available_until) {
    db.prepare("UPDATE quizzes SET status = 'ACTIVE', updated_at = ? WHERE id = ? AND status = 'SCHEDULED'").run(
      now,
      quizId,
    );
  }
  if ((quiz.status === 'ACTIVE' || quiz.status === 'SCHEDULED') && now > quiz.available_until) {
    db.prepare("UPDATE quizzes SET status = 'CLOSED', updated_at = ? WHERE id = ?").run(now, quizId);
  }
}

export function startAttempt(
  db: Db,
  actor: AttemptActor,
  target: { examId?: number; quizId?: number },
  meta: { ip?: string | null; userAgent?: string | null } = {},
): StartAttemptResult {
  const studentId = assertStudentContext(actor);
  const now = nowIso();

  const student = db
    .prepare('SELECT id, institution_id, status FROM students WHERE id = ?')
    .get(studentId) as { id: number; institution_id: number; status: string } | undefined;
  if (!student) throw notFound('Candidate profile not found.');
  if (student.status !== 'active') throw forbidden('Your candidate account is not active.');

  const kind: 'exam' | 'quiz' = target.examId ? 'exam' : 'quiz';
  const targetId = target.examId ?? target.quizId;
  if (!targetId) throw unprocessable('Specify an examination or quiz to start.');

  // Resume an unfinished attempt rather than creating a duplicate one.
  const existing = db
    .prepare(
      `SELECT id, status, started_at, expires_at, attempt_no FROM attempts
        WHERE student_id = ? AND status = 'IN_PROGRESS' AND ${kind === 'exam' ? 'exam_id' : 'quiz_id'} = ?
        ORDER BY attempt_no DESC LIMIT 1`,
    )
    .get(studentId, targetId) as
    | { id: number; status: string; started_at: string; expires_at: string; attempt_no: number }
    | undefined;

  if (existing) {
    if (secondsBetween(now, existing.expires_at) <= 0) {
      submitAttempt(db, actor, existing.id, 'time_expired', { auto: true });
      throw conflict('Your previous attempt for this paper has expired and was submitted automatically.');
    }
    return {
      attemptId: existing.id,
      targetKind: kind,
      targetId,
      attemptNo: existing.attempt_no,
      status: existing.status,
      startedAt: existing.started_at,
      expiresAt: existing.expires_at,
      serverTime: now,
      remainingSeconds: secondsBetween(now, existing.expires_at),
      resumed: true,
    };
  }

  let institutionId: number;
  let durationMinutes: number;
  let maxAttempts: number;
  let windowEnd: string;
  let randomizeQuestions: boolean;
  let randomizeOptions: boolean;
  let paperRows: PaperRow[];
  let allowStarted: boolean;

  if (kind === 'exam') {
    const exam = db
      .prepare(
        `SELECT id, institution_id, status, duration_minutes, max_attempts, start_at, end_at,
                randomize_questions, randomize_options, name
           FROM exams WHERE id = ?`,
      )
      .get(targetId) as
      | {
          id: number;
          institution_id: number;
          status: string;
          duration_minutes: number;
          max_attempts: number;
          start_at: string;
          end_at: string;
          randomize_questions: number;
          randomize_options: number;
          name: string;
        }
      | undefined;
    if (!exam) throw notFound('Examination not found.');
    if (exam.institution_id !== student.institution_id) {
      throw forbidden('This examination belongs to another institution.');
    }
    ensureExamIsOpen(db, exam.id, now);
    const refreshed = db.prepare('SELECT status FROM exams WHERE id = ?').get(exam.id) as { status: string };
    if (refreshed.status === 'DRAFT') throw forbidden('This examination has not been scheduled yet.');
    if (refreshed.status === 'ARCHIVED') throw forbidden('This examination has been archived.');
    if (now < exam.start_at) {
      throw forbidden(`This examination opens on ${new Date(exam.start_at).toUTCString()}.`);
    }
    if (now > exam.end_at) {
      throw forbidden('The examination window has closed. Please contact your examiner.');
    }
    if (!isAssigned(db, studentId, 'exam', exam.id)) {
      throw forbidden('This examination has not been assigned to you.');
    }
    paperRows = loadExamPaper(db, exam.id);
    attachOptions(db, paperRows);
    institutionId = exam.institution_id;
    durationMinutes = exam.duration_minutes;
    maxAttempts = exam.max_attempts;
    windowEnd = exam.end_at;
    randomizeQuestions = Boolean(exam.randomize_questions);
    randomizeOptions = Boolean(exam.randomize_options);
    allowStarted = true;
  } else {
    const quiz = db
      .prepare(
        `SELECT id, institution_id, status, time_limit_minutes, max_attempts, available_from, available_until,
                randomize_questions, randomize_options, question_count, title
           FROM quizzes WHERE id = ?`,
      )
      .get(targetId) as
      | {
          id: number;
          institution_id: number;
          status: string;
          time_limit_minutes: number;
          max_attempts: number;
          available_from: string;
          available_until: string;
          randomize_questions: number;
          randomize_options: number;
          question_count: number;
          title: string;
        }
      | undefined;
    if (!quiz) throw notFound('Quiz not found.');
    if (quiz.institution_id !== student.institution_id) {
      throw forbidden('This quiz belongs to another institution.');
    }
    ensureQuizIsOpen(db, quiz.id, now);
    const refreshed = db.prepare('SELECT status FROM quizzes WHERE id = ?').get(quiz.id) as { status: string };
    if (refreshed.status === 'DRAFT') throw forbidden('This quiz is not available yet.');
    if (refreshed.status === 'ARCHIVED') throw forbidden('This quiz has been archived.');
    if (refreshed.status === 'CLOSED' || now > quiz.available_until) {
      throw forbidden('This quiz is closed.');
    }
    if (now < quiz.available_from) {
      throw forbidden(`This quiz opens on ${new Date(quiz.available_from).toUTCString()}.`);
    }
    if (!isAssigned(db, studentId, 'quiz', quiz.id)) {
      throw forbidden('This quiz has not been assigned to you.');
    }
    paperRows = loadQuizPaper(db, quiz.id, Boolean(quiz.randomize_questions), quiz.question_count);
    attachOptions(db, paperRows);
    institutionId = quiz.institution_id;
    durationMinutes = quiz.time_limit_minutes;
    maxAttempts = quiz.max_attempts;
    windowEnd = quiz.available_until;
    randomizeQuestions = Boolean(quiz.randomize_questions);
    randomizeOptions = Boolean(quiz.randomize_options);
    allowStarted = true;
  }

  if (!allowStarted) throw forbidden('This paper cannot be started right now.');
  if (!paperRows.length) throw unprocessable('This paper has no questions yet. Please contact your examiner.');

  const attemptsUsed = db
    .prepare(
      `SELECT COUNT(*) AS c FROM attempts
        WHERE student_id = ? AND ${kind === 'exam' ? 'exam_id' : 'quiz_id'} = ?
          AND status NOT IN ('IN_PROGRESS','VOID')`,
    )
    .get(studentId, targetId) as { c: number };
  if (attemptsUsed.c >= maxAttempts) {
    throw conflict(
      `You have used all ${maxAttempts} permitted attempt(s) for this paper. Contact your examiner if you need another.`,
    );
  }

  // The paper is frozen here: later edits to the source question never change this attempt.
  const orderedRows = randomizeQuestions ? shuffle(paperRows) : paperRows;
  const snapshots = orderedRows.map((row) => snapshotQuestion(row, randomizeOptions));
  const maxMarks = round2(snapshots.reduce((sum, s) => sum + s.marks, 0));

  const startedAt = now;
  // Duration can never extend beyond the examination availability window.
  const expiresAt = minIso(addMinutes(startedAt, durationMinutes), windowEnd);
  if (secondsBetween(startedAt, expiresAt) <= 0) {
    throw forbidden('There is not enough time left in the examination window to start an attempt.');
  }

  const attemptNo = attemptsUsed.c + 1;

  const attemptId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO attempts
          (institution_id, exam_id, quiz_id, student_id, attempt_no, status, started_at, expires_at,
           last_activity_at, ip_address, user_agent, max_marks, created_at, updated_at)
         VALUES (?,?,?,?,?, 'IN_PROGRESS', ?,?,?,?,?,?,?,?)`,
      )
      .run(
        institutionId,
        kind === 'exam' ? targetId : null,
        kind === 'quiz' ? targetId : null,
        studentId,
        attemptNo,
        startedAt,
        expiresAt,
        startedAt,
        meta.ip ?? null,
        meta.userAgent ?? null,
        maxMarks,
        startedAt,
        startedAt,
      );
    const newAttemptId = Number(info.lastInsertRowid);

    const insertPaper = db.prepare(
      `INSERT INTO attempt_questions
        (attempt_id, question_id, position, question_type, question_text, marks, negative_marks,
         is_objective, correct_answer, snapshot)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    snapshots.forEach((snapshot, index) => {
      insertPaper.run(
        newAttemptId,
        snapshot.questionId,
        index + 1,
        snapshot.type,
        snapshot.text,
        snapshot.marks,
        snapshot.negativeMarks,
        isObjectiveType(snapshot.type) ? 1 : 0,
        JSON.stringify(snapshot.correct),
        JSON.stringify({
          options: snapshot.options,
          answerConfig: snapshot.answerConfig,
          explanation: snapshot.explanation,
          topic: snapshot.topic,
          difficulty: snapshot.difficulty,
        }),
      );
    });
    return newAttemptId;
  })();

  return {
    attemptId,
    targetKind: kind,
    targetId,
    attemptNo,
    status: 'IN_PROGRESS',
    startedAt,
    expiresAt,
    serverTime: now,
    remainingSeconds: secondsBetween(now, expiresAt),
    resumed: false,
  };
}

export interface AttemptPaper {
  attempt: {
    id: number;
    attemptNo: number;
    status: string;
    startedAt: string;
    expiresAt: string;
    submittedAt: string | null;
    submitReason: string | null;
    maxMarks: number;
    examId: number | null;
    quizId: number | null;
    title: string;
    code: string | null;
    instructions: string | null;
    durationMinutes: number;
    totalMarks: number;
    passMarks: number;
    allowReview: number;
    showCorrectAnswers: number;
    institutionName: string;
    integrityFlags: unknown[];
    studentName: string;
    studentCode: string;
  };
  serverTime: string;
  remainingSeconds: number;
  graceSeconds: number;
  questions: AttemptQuestionView[];
  answers: Record<string, AttemptAnswerView>;
  progress: { answered: number; unanswered: number; flagged: number; total: number };
}

export interface AttemptQuestionView {
  questionId: number;
  position: number;
  type: QuestionType;
  text: string;
  marks: number;
  negativeMarks: number;
  objective: boolean;
  options: { label: string; text: string }[];
  answerConfig: Record<string, unknown>;
}

export interface AttemptAnswerView {
  questionId: number;
  selectedOptions: string[];
  answerText: string | null;
  isFlagged: boolean;
  updatedAt: string | null;
}

function loadAttemptRow(db: Db, attemptId: number) {
  return db
    .prepare(
      `SELECT a.*, e.name AS exam_name, e.code AS exam_code, e.instructions AS exam_instructions,
              e.duration_minutes AS exam_duration, e.total_marks AS exam_total_marks, e.pass_marks AS exam_pass_marks,
              e.status AS exam_status, e.result_release_at AS exam_result_release,
              qz.title AS quiz_title, qz.instructions AS quiz_instructions,
              qz.time_limit_minutes AS quiz_duration, qz.pass_percentage AS quiz_pass_percentage,
              qz.allow_review, qz.show_correct_answers, qz.result_release_at AS quiz_result_release,
              i.name AS institution_name, s.student_code, u.full_name AS student_name
         FROM attempts a
         LEFT JOIN exams e ON e.id = a.exam_id
         LEFT JOIN quizzes qz ON qz.id = a.quiz_id
         JOIN institutions i ON i.id = a.institution_id
         JOIN students s ON s.id = a.student_id
         JOIN users u ON u.id = s.user_id
        WHERE a.id = ?`,
    )
    .get(attemptId) as any;
}

/**
 * Loads the running paper. Correct answers and explanations are only included when the
 * caller may review them (submitted attempt + review permitted + result released).
 */
export function getAttemptPaper(db: Db, attemptId: number): AttemptPaper {
  const row = loadAttemptRow(db, attemptId);
  if (!row) throw notFound('Attempt not found.');
  const now = nowIso();

  const questionRows = db
    .prepare(
      `SELECT question_id, position, question_type, question_text, marks, negative_marks, is_objective, snapshot
         FROM attempt_questions WHERE attempt_id = ? ORDER BY position ASC`,
    )
    .all(attemptId) as any[];

  const answers = db
    .prepare('SELECT question_id, selected_options, answer_text, is_flagged, updated_at FROM answers WHERE attempt_id = ?')
    .all(attemptId) as any[];

  const answerMap: Record<string, AttemptAnswerView> = {};
  for (const answer of answers) {
    answerMap[String(answer.question_id)] = {
      questionId: answer.question_id,
      selectedOptions: JSON.parse(answer.selected_options) as string[],
      answerText: answer.answer_text,
      isFlagged: Boolean(answer.is_flagged),
      updatedAt: answer.updated_at,
    };
  }

  const isExam = row.exam_id !== null;
  const questions: AttemptQuestionView[] = questionRows.map((q) => {
    const snapshot = JSON.parse(q.snapshot);
    return {
      questionId: q.question_id,
      position: q.position,
      type: q.question_type,
      text: q.question_text,
      marks: q.marks,
      negativeMarks: q.negative_marks,
      objective: Boolean(q.is_objective),
      options: snapshot.options ?? [],
      answerConfig:
        q.question_type === 'FILL_BLANK'
          ? { caseSensitive: Boolean(snapshot.answerConfig?.caseSensitive) }
          : {},
    };
  });

  const answeredCount = questions.filter((q) => {
    const answer = answerMap[String(q.questionId)];
    if (!answer) return false;
    return answer.selectedOptions.length > 0 || (answer.answerText ?? '').trim().length > 0;
  }).length;

  return {
    attempt: {
      id: row.id,
      attemptNo: row.attempt_no,
      status: row.status,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      submittedAt: row.submitted_at,
      submitReason: row.submit_reason,
      maxMarks: row.max_marks,
      examId: row.exam_id,
      quizId: row.quiz_id,
      title: isExam ? row.exam_name : row.quiz_title,
      code: isExam ? row.exam_code : null,
      instructions: isExam ? row.exam_instructions : row.quiz_instructions,
      durationMinutes: isExam ? row.exam_duration : row.quiz_duration,
      totalMarks: isExam ? row.exam_total_marks : row.max_marks,
      passMarks: isExam
        ? row.exam_pass_marks
        : round2((Number(row.quiz_pass_percentage ?? 50) / 100) * Number(row.max_marks)),
      allowReview: isExam ? 1 : row.allow_review,
      showCorrectAnswers: isExam ? 1 : row.show_correct_answers,
      institutionName: row.institution_name,
      integrityFlags: JSON.parse(row.integrity_flags ?? '[]'),
      studentName: row.student_name,
      studentCode: row.student_code,
    },
    serverTime: now,
    remainingSeconds: Math.max(0, secondsBetween(now, row.expires_at)),
    graceSeconds: env.attemptClockGraceSeconds,
    questions,
    answers: answerMap,
    progress: {
      answered: answeredCount,
      unanswered: questions.length - answeredCount,
      flagged: answers.filter((a) => a.is_flagged).length,
      total: questions.length,
    },
  };
}

export function assertAttemptAccess(
  _db: Db,
  actor: AuthedRequest['user'],
  attempt: { student_id: number; institution_id: number; created_by?: number | null },
): void {
  if (!actor) throw forbidden();
  if (actor.roleCode === 'super_admin') return;
  if (actor.institutionId !== attempt.institution_id) {
    throw forbidden('You do not have permission to access this attempt.');
  }
  if (actor.roleCode === 'student' && actor.studentId !== attempt.student_id) {
    throw forbidden('You can only access your own attempts.');
  }
}

export interface SaveAnswerInput {
  selectedOptions?: string[];
  answerText?: string | null;
  isFlagged?: boolean;
}

export interface SaveAnswerResult {
  saved: boolean;
  serverTime: string;
  remainingSeconds: number;
  answer: AttemptAnswerView;
  autoSubmitted: boolean;
}

/**
 * Persists a single answer. The write is rejected once the attempt is submitted or the
 * server-side clock has expired (in which case the attempt is auto-submitted first).
 */
export function saveAnswer(
  db: Db,
  actor: AttemptActor,
  attemptId: number,
  questionId: number,
  input: SaveAnswerInput,
): SaveAnswerResult {
  const now = nowIso();
  const attempt = db
    .prepare('SELECT id, student_id, institution_id, status, expires_at, auto_submitted, exam_id, quiz_id FROM attempts WHERE id = ?')
    .get(attemptId) as
    | {
        id: number;
        student_id: number;
        institution_id: number;
        status: string;
        expires_at: string;
        auto_submitted: number;
        exam_id: number | null;
        quiz_id: number | null;
      }
    | undefined;
  if (!attempt) throw notFound('Attempt not found.');
  if (actor.roleCode === 'student' && actor.studentId !== attempt.student_id) {
    throw forbidden('You can only answer your own attempt.');
  }
  if (attempt.status !== 'IN_PROGRESS') {
    throw conflict('This attempt has been submitted and can no longer be modified.');
  }

  const remaining = secondsBetween(now, attempt.expires_at);
  if (remaining <= 0) {
    submitAttempt(db, actor, attemptId, 'time_expired', { auto: true });
    throw conflict('Your time has expired. The attempt was submitted automatically.');
  }

  const paperQuestion = db
    .prepare('SELECT question_id, question_type, snapshot FROM attempt_questions WHERE attempt_id = ? AND question_id = ?')
    .get(attemptId, questionId) as
    | { question_id: number; question_type: QuestionType; snapshot: string }
    | undefined;
  if (!paperQuestion) throw notFound('That question is not part of this attempt.');

  const snapshot = JSON.parse(paperQuestion.snapshot) as { options: { label: string; text: string }[] };
  const validLabels = new Set((snapshot.options ?? []).map((o) => o.label.toUpperCase()));
  const selected = (input.selectedOptions ?? [])
    .map((label) => String(label).trim().toUpperCase())
    .filter((label) => (validLabels.size ? validLabels.has(label) : false));
  if ((input.selectedOptions?.length ?? 0) > 0 && selected.length === 0 && validLabels.size > 0) {
    throw unprocessable('The submitted option does not belong to this question.');
  }

  const existing = db
    .prepare('SELECT id, save_count FROM answers WHERE attempt_id = ? AND question_id = ?')
    .get(attemptId, questionId) as { id: number; save_count: number } | undefined;

  const answerText = input.answerText === undefined ? undefined : (input.answerText ?? '').slice(0, 20000);

  db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE answers SET
            selected_options = COALESCE(?, selected_options),
            answer_text = CASE WHEN ? THEN ? ELSE answer_text END,
            is_flagged = COALESCE(?, is_flagged),
            save_count = save_count + 1,
            updated_at = ?
          WHERE id = ?`,
      ).run(
        input.selectedOptions ? JSON.stringify(selected) : null,
        input.answerText === undefined ? 0 : 1,
        answerText ?? null,
        input.isFlagged === undefined ? null : input.isFlagged ? 1 : 0,
        now,
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO answers
          (attempt_id, question_id, selected_options, answer_text, is_flagged, max_marks, save_count, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        attemptId,
        questionId,
        JSON.stringify(selected),
        answerText ?? null,
        input.isFlagged ? 1 : 0,
        (db
          .prepare('SELECT marks FROM attempt_questions WHERE attempt_id = ? AND question_id = ?')
          .get(attemptId, questionId) as { marks: number }).marks,
        1,
        now,
        now,
      );
    }
    db.prepare('UPDATE attempts SET last_activity_at = ?, updated_at = ? WHERE id = ?').run(now, now, attemptId);
  })();

  const saved = db
    .prepare('SELECT question_id, selected_options, answer_text, is_flagged, updated_at FROM answers WHERE attempt_id = ? AND question_id = ?')
    .get(attemptId, questionId) as any;

  return {
    saved: true,
    serverTime: now,
    remainingSeconds: Math.max(0, remaining),
    answer: {
      questionId: saved.question_id,
      selectedOptions: JSON.parse(saved.selected_options),
      answerText: saved.answer_text,
      isFlagged: Boolean(saved.is_flagged),
      updatedAt: saved.updated_at,
    },
    autoSubmitted: false,
  };
}

export function recordIntegrityEvent(
  db: Db,
  actor: AttemptActor,
  attemptId: number,
  event: { type: string; detail?: string },
): void {
  const attempt = db
    .prepare('SELECT student_id, institution_id, status, integrity_flags FROM attempts WHERE id = ?')
    .get(attemptId) as
    | { student_id: number; institution_id: number; status: string; integrity_flags: string }
    | undefined;
  if (!attempt) throw notFound('Attempt not found.');
  if (actor.roleCode === 'student' && actor.studentId !== attempt.student_id) {
    throw forbidden('You can only report activity for your own attempt.');
  }
  if (attempt.status !== 'IN_PROGRESS') return;
  const flags = JSON.parse(attempt.integrity_flags || '[]') as unknown[];
  flags.push({ type: event.type, detail: event.detail ?? null, at: nowIso(), source: 'client_reported' });
  db.prepare('UPDATE attempts SET integrity_flags = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(flags.slice(-100)),
    nowIso(),
    attemptId,
  );
}

export interface SubmissionResult {
  attemptId: number;
  status: string;
  objectiveMarks: number;
  subjectiveMarks: number;
  totalObtained: number;
  maxMarks: number;
  percentage: number;
  grade: string | null;
  outcome: string;
  requiresManualGrading: boolean;
  resultId: number | null;
  resultPublished: boolean;
}

/**
 * Submission: validated, idempotent, and it locks the attempt against further writes.
 */
export function submitAttempt(
  db: Db,
  actor: AttemptActor,
  attemptId: number,
  reason: 'manual' | 'time_expired' | 'admin_force' = 'manual',
  options: { auto?: boolean } = {},
): SubmissionResult {
  const attempt = db
    .prepare(
      `SELECT a.*, e.id AS e_id, e.total_marks AS e_total, e.pass_marks AS e_pass, e.grading_scheme_id,
              e.status AS exam_status, e.result_release_at AS exam_release, e.created_by AS exam_owner,
              qz.max_attempts AS quiz_attempts, qz.pass_percentage AS quiz_pass, qz.immediate_results,
              qz.result_release_at AS quiz_release, qz.created_by AS quiz_owner
         FROM attempts a
         LEFT JOIN exams e ON e.id = a.exam_id
         LEFT JOIN quizzes qz ON qz.id = a.quiz_id
        WHERE a.id = ?`,
    )
    .get(attemptId) as any;
  if (!attempt) throw notFound('Attempt not found.');

  if (actor.roleCode === 'student' && actor.studentId !== attempt.student_id) {
    throw forbidden('You can only submit your own attempt.');
  }
  if (actor.roleCode === 'teacher' || actor.roleCode === 'institution_admin') {
    if (actor.institutionId !== attempt.institution_id) {
      throw forbidden('You do not have permission to submit this attempt.');
    }
    if (reason !== 'admin_force') {
      throw forbidden('Examiners can only force-submit an attempt.');
    }
  }

  if (attempt.status !== 'IN_PROGRESS') {
    throw conflict('This attempt has already been submitted.');
  }

  const examStatus = attempt.exam_status as string | null;
  if (attempt.exam_id && examStatus === 'ARCHIVED') {
    throw conflict('This examination has been archived and no longer accepts submissions.');
  }

  const now = nowIso();
  const expired = secondsBetween(now, attempt.expires_at) <= 0;
  const finalReason = reason === 'manual' && expired ? 'time_expired' : reason;
  const autoSubmitted = finalReason === 'time_expired' || Boolean(options.auto);

  db.transaction(() => {
    db.prepare(
      `UPDATE attempts
          SET status = 'SUBMITTED', submitted_at = ?, submit_reason = ?, auto_submitted = ?,
              version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'IN_PROGRESS'`,
    ).run(now, finalReason, autoSubmitted ? 1 : 0, now, attemptId);
  })();

  const locked = db.prepare('SELECT status FROM attempts WHERE id = ?').get(attemptId) as { status: string };
  if (locked.status === 'IN_PROGRESS') {
    throw conflict('This attempt has already been submitted.');
  }

  return finaliseAttempt(db, actor, attemptId, {
    reason: finalReason,
    rejectedSubmission: expired && reason === 'manual',
  });
}

/** Auto-grades objective answers and recalculates totals for an attempt. */
export function gradeObjectiveAnswers(db: Db, attemptId: number): { graded: number; pending: number } {
  const paper = db
    .prepare(
      `SELECT question_id, question_type, marks, is_objective, correct_answer
         FROM attempt_questions WHERE attempt_id = ?`,
    )
    .all(attemptId) as {
    question_id: number;
    question_type: QuestionType;
    marks: number;
    is_objective: number;
    correct_answer: string | null;
  }[];

  const now = nowIso();
  let graded = 0;
  let pending = 0;

  const upsert = db.prepare(
    `INSERT INTO answers
      (attempt_id, question_id, selected_options, answer_text, is_flagged, is_correct, awarded_marks, max_marks,
       auto_graded, graded_at, save_count, created_at, updated_at)
     VALUES (?,?,?,?,0,?,?,?,1,?,0,?,?)
     ON CONFLICT(attempt_id, question_id) DO UPDATE SET
       is_correct = excluded.is_correct,
       awarded_marks = excluded.awarded_marks,
       max_marks = excluded.max_marks,
       auto_graded = 1,
       graded_at = excluded.graded_at,
       updated_at = excluded.updated_at`,
  );

  for (const question of paper) {
    const answer = db
      .prepare('SELECT id, selected_options, answer_text, awarded_marks, graded_by FROM answers WHERE attempt_id = ? AND question_id = ?')
      .get(attemptId, question.question_id) as
      | {
          id: number;
          selected_options: string;
          answer_text: string | null;
          awarded_marks: number | null;
          graded_by: number | null;
        }
      | undefined;

    if (!question.is_objective) {
      pending += 1;
      continue;
    }
    // A manually adjusted objective answer is never silently overwritten.
    if (answer?.graded_by) {
      graded += 1;
      continue;
    }

    const key = JSON.parse(question.correct_answer ?? '{}') as AnswerKey;
    const penaltyRow = db
      .prepare('SELECT negative_marks FROM attempt_questions WHERE attempt_id = ? AND question_id = ?')
      .get(attemptId, question.question_id) as { negative_marks: number };

    const result = gradeObjective(
      question.question_type,
      {
        selectedOptions: JSON.parse(answer?.selected_options ?? '[]') as string[],
        answerText: answer?.answer_text ?? null,
      },
      key,
      question.marks,
      penaltyRow.negative_marks,
    );

    upsert.run(
      attemptId,
      question.question_id,
      answer?.selected_options ?? '[]',
      answer?.answer_text ?? null,
      result.isCorrect ? 1 : 0,
      result.awarded,
      question.marks,
      now,
      now,
      now,
    );
    graded += 1;
  }

  return { graded, pending };
}

/**
 * Recomputes marks, percentage and grade for an attempt and writes/refreshes its result row.
 */
export function finaliseAttempt(
  db: Db,
  _actor: { id: number; institutionId: number | null; roleCode: string; fullName: string } | null,
  attemptId: number,
  _options: { reason?: string; rejectedSubmission?: boolean } = {},
): SubmissionResult {
  const attempt = db
    .prepare(
      `SELECT a.*, e.total_marks AS e_total, e.pass_marks AS e_pass, e.grading_scheme_id, e.result_release_at AS exam_release,
              qz.pass_percentage AS quiz_pass, qz.immediate_results, qz.result_release_at AS quiz_release
         FROM attempts a
         LEFT JOIN exams e ON e.id = a.exam_id
         LEFT JOIN quizzes qz ON qz.id = a.quiz_id
        WHERE a.id = ?`,
    )
    .get(attemptId) as any;
  if (!attempt) throw notFound('Attempt not found.');

  gradeObjectiveAnswers(db, attemptId);

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN aq.is_objective = 1 THEN COALESCE(an.awarded_marks, 0) ELSE 0 END), 0) AS objective,
         COALESCE(SUM(CASE WHEN aq.is_objective = 0 THEN COALESCE(an.awarded_marks, 0) ELSE 0 END), 0) AS subjective,
         COALESCE(SUM(aq.marks), 0) AS max_marks,
         SUM(CASE WHEN aq.is_objective = 0 AND an.awarded_marks IS NULL THEN 1 ELSE 0 END) AS ungraded_subjective
       FROM attempt_questions aq
       LEFT JOIN answers an ON an.attempt_id = aq.attempt_id AND an.question_id = aq.question_id
      WHERE aq.attempt_id = ?`,
    )
    .get(attemptId) as {
    objective: number;
    subjective: number;
    max_marks: number;
    ungraded_subjective: number;
  };

  const objective = round2(totals.objective);
  const subjective = round2(totals.subjective);
  const obtained = round2(Math.max(0, objective + subjective));
  const maxMarks = round2(totals.max_marks || attempt.max_marks);
  const requiresManualGrading = (totals.ungraded_subjective ?? 0) > 0;

  const isExam = attempt.exam_id !== null;
  const totalMarks = isExam ? Number(attempt.e_total) : maxMarks;
  const passMark = isExam
    ? Number(attempt.e_pass)
    : round2((Number(attempt.quiz_pass ?? 50) / 100) * maxMarks);

  // The grading scale is configurable per institution, and may be overridden per examination.
  const scheme = resolveScheme(db, attempt.institution_id, isExam ? attempt.grading_scheme_id : null);
  const finalScore = computeFinalScore({
    totalMarks,
    obtainedMarks: obtained,
    passMark,
    bands: scheme.bands,
  });

  const now = nowIso();
  const status = requiresManualGrading ? 'UNDER_REVIEW' : 'GRADED';
  const outcome = requiresManualGrading ? 'PENDING' : finalScore.outcome;

  const resultId = db.transaction(() => {
    db.prepare(
      `UPDATE attempts SET
          status = ?, objective_marks = ?, subjective_marks = ?, total_marks = ?, obtained_marks = ?,
          max_marks = ?, percentage = ?, grade = ?, passed = ?, graded_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      status,
      objective,
      subjective,
      obtained,
      obtained,
      maxMarks,
      finalScore.percentage,
      finalScore.grade,
      requiresManualGrading ? null : finalScore.outcome === 'PASSED' ? 1 : 0,
      requiresManualGrading ? null : now,
      now,
      attemptId,
    );

    const existingResult = db.prepare('SELECT id, is_published FROM results WHERE attempt_id = ?').get(attemptId) as
      | { id: number; is_published: number }
      | undefined;

    const publishNow =
      !requiresManualGrading &&
      (attempt.immediate_results === 1 ||
        (isExam && attempt.exam_release && attempt.exam_release <= now) ||
        (!isExam && attempt.quiz_release && attempt.quiz_release <= now));

    if (existingResult) {
      // A published result is never silently recomputed for marks; only the review fields move.
      if (!existingResult.is_published) {
        db.prepare(
          `UPDATE results SET total_marks = ?, obtained_marks = ?, percentage = ?, grade = ?, points = ?,
                  outcome = ?, scheme_id = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          finalScore.totalMarks,
          finalScore.obtainedMarks,
          finalScore.percentage,
          finalScore.grade,
          finalScore.points,
          outcome,
          scheme.schemeId,
          now,
          existingResult.id,
        );
      }
      return existingResult.id;
    }

    const info = db
      .prepare(
        `INSERT INTO results
          (attempt_id, institution_id, exam_id, quiz_id, student_id, subject_id, total_marks, obtained_marks,
           percentage, grade, points, outcome, scheme_id, is_published, published_at, created_at, updated_at)
         VALUES (?,?,?,?,?,
                 (SELECT subject_id FROM ${isExam ? 'exams' : 'quizzes'} WHERE id = ?),
                 ?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        attemptId,
        attempt.institution_id,
        attempt.exam_id,
        attempt.quiz_id,
        attempt.student_id,
        isExam ? attempt.exam_id : attempt.quiz_id,
        finalScore.totalMarks,
        finalScore.obtainedMarks,
        finalScore.percentage,
        finalScore.grade,
        finalScore.points,
        outcome,
        scheme.schemeId,
        publishNow ? 1 : 0,
        publishNow ? now : null,
        now,
        now,
      );
    return Number(info.lastInsertRowid);
  })();

  // Notifications: grading finished, and (separately) result released.
  const studentUserId = db.prepare('SELECT user_id FROM students WHERE id = ?').get(attempt.student_id) as
    | { user_id: number }
    | undefined;
  if (studentUserId && !requiresManualGrading) {
    const examName =
      (db.prepare('SELECT name FROM exams WHERE id = ?').get(attempt.exam_id) as { name: string } | undefined)?.name ??
      (db.prepare('SELECT title FROM quizzes WHERE id = ?').get(attempt.quiz_id) as { title: string } | undefined)
        ?.title ??
      'your paper';
    createNotification(db, {
      institutionId: attempt.institution_id,
      userId: studentUserId.user_id,
      type: 'grading_completed',
      title: 'Your submission has been graded',
      body: `Automatic grading for "${examName}" is complete. Results are released by your examiner.`,
      severity: 'info',
    });
  }

  const resultRow = db.prepare('SELECT is_published, outcome, grade FROM results WHERE id = ?').get(resultId) as
    | { is_published: number; outcome: string; grade: string | null }
    | undefined;

  return {
    attemptId,
    status,
    objectiveMarks: objective,
    subjectiveMarks: subjective,
    totalObtained: obtained,
    maxMarks,
    percentage: finalScore.percentage,
    grade: finalScore.grade,
    outcome: requiresManualGrading ? 'PENDING' : finalScore.outcome,
    requiresManualGrading,
    resultId,
    resultPublished: Boolean(resultRow?.is_published),
  };
}

/** Scheduled job: submits attempts whose server-side time has run out. */
export function expireAttempts(db: Db): { expired: number; ids: number[] } {
  const now = nowIso();
  const stale = db
    .prepare("SELECT id FROM attempts WHERE status = 'IN_PROGRESS' AND expires_at <= ?")
    .all(now) as { id: number }[];

  const ids: number[] = [];
  for (const row of stale) {
    try {
      submitAttempt(db, { id: 0, institutionId: null, roleCode: 'system', fullName: 'System', studentId: null }, row.id, 'time_expired', {
        auto: true,
      });
      ids.push(row.id);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[scheduler] failed to auto-submit attempt', row.id, error);
    }
  }
  return { expired: ids.length, ids };
}
