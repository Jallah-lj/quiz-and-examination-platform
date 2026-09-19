/**
 * Attempt-engine tests: server-authoritative timing, auto-save behaviour, submission
 * locking, attempt limits and deterministic auto-grading.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { buildHarness, type Fixture, type Harness } from '../test-utils/harness';
import {
  expireAttempts,
  getAttemptPaper,
  saveAnswer,
  startAttempt,
  submitAttempt,
} from './attempts';
import { addMinutes, nowIso } from '../lib/time';

let harness: Harness;
let db: Db;
let fixture: Fixture;

const studentActor = () => ({
  id: fixture.studentUserId,
  institutionId: fixture.institutionId,
  roleCode: 'student',
  fullName: 'Sam Student',
  studentId: fixture.studentId,
});

const systemActor = () => ({
  id: 0,
  institutionId: null,
  roleCode: 'system',
  fullName: 'System',
  studentId: null,
});

beforeEach(() => {
  harness = buildHarness();
  db = harness.db;
  fixture = harness.fixture;
});

afterEach(() => {
  db.close();
});

describe('starting an attempt', () => {
  it('locks the paper at start and records a server-derived expiry', () => {
    const result = startAttempt(db, studentActor(), { examId: fixture.examId });
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.attemptNo).toBe(1);

    // The paper is 30 minutes long, so the expiry is 30 minutes after the start.
    const delta = (new Date(result.expiresAt).getTime() - new Date(result.startedAt).getTime()) / 60000;
    expect(Math.round(delta)).toBe(30);
    expect(result.remainingSeconds).toBeGreaterThan(1700);

    const paper = getAttemptPaper(db, result.attemptId);
    expect(paper.questions).toHaveLength(6);
    expect(paper.attempt.maxMarks).toBe(45);
    expect(paper.progress).toMatchObject({ answered: 0, unanswered: 6, total: 6 });
  });

  it('cannot extend remaining time by starting again — the same attempt resumes', () => {
    const first = startAttempt(db, studentActor(), { examId: fixture.examId });
    // Simulate the candidate refreshing five minutes later.
    db.prepare('UPDATE attempts SET started_at = ?, expires_at = ? WHERE id = ?').run(
      addMinutes(nowIso(), -5),
      addMinutes(nowIso(), 25),
      first.attemptId,
    );

    const stored = db.prepare('SELECT expires_at FROM attempts WHERE id = ?').get(first.attemptId) as {
      expires_at: string;
    };

    const resumed = startAttempt(db, studentActor(), { examId: fixture.examId });
    expect(resumed.resumed).toBe(true);
    expect(resumed.attemptId).toBe(first.attemptId);
    // The expiry stored by the server is authoritative — resuming never extends it.
    expect(resumed.expiresAt).toBe(stored.expires_at);
    expect(resumed.remainingSeconds).toBeLessThanOrEqual(25 * 60);
  });

  it('rejects a paper that has not been assigned to the candidate', () => {
    db.prepare('DELETE FROM exam_assignments WHERE exam_id = ?').run(fixture.examId);
    expect(() => startAttempt(db, studentActor(), { examId: fixture.examId })).toThrow(/not been assigned/i);
  });

  it('rejects starting before the examination window opens', () => {
    db.prepare('UPDATE exams SET start_at = ?, status = ? WHERE id = ?').run(
      addMinutes(nowIso(), 60),
      'SCHEDULED',
      fixture.examId,
    );
    expect(() => startAttempt(db, studentActor(), { examId: fixture.examId })).toThrow(/opens on/i);
  });

  it('rejects starting after the examination window closed', () => {
    db.prepare('UPDATE exams SET end_at = ?, status = ? WHERE id = ?').run(
      addMinutes(nowIso(), -5),
      'ACTIVE',
      fixture.examId,
    );
    expect(() => startAttempt(db, studentActor(), { examId: fixture.examId })).toThrow(/closed/i);
  });

  it('blocks candidates from another institution', () => {
    const foreign = {
      ...studentActor(),
      institutionId: fixture.otherInstitutionId,
      studentId: fixture.foreignStudentId,
      id: fixture.foreignStudentUserId,
    };
    expect(() => startAttempt(db, foreign, { examId: fixture.examId })).toThrow(/another institution/i);
  });

  it('enforces the configured attempt limit', () => {
    const first = startAttempt(db, studentActor(), { examId: fixture.examId });
    submitAttempt(db, studentActor(), first.attemptId, 'manual');
    expect(() => startAttempt(db, studentActor(), { examId: fixture.examId })).toThrow(/permitted attempt/i);
  });

  it('refuses to start an examination that does not belong to the candidate institution', () => {
    const actor = studentActor();
    db.prepare('UPDATE students SET institution_id = ? WHERE id = ?').run(
      fixture.otherInstitutionId,
      fixture.studentId,
    );
    expect(() => startAttempt(db, actor, { examId: fixture.examId })).toThrow(/another institution/i);
    db.prepare('UPDATE students SET institution_id = ? WHERE id = ?').run(fixture.institutionId, fixture.studentId);
  });
});

describe('auto-save', () => {
  it('persists answers and reports progress immediately', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    const saved = saveAnswer(db, studentActor(), attempt.attemptId, fixture.objectiveQuestions[0], {
      selectedOptions: ['B'],
      isFlagged: true,
    });
    expect(saved.saved).toBe(true);
    expect(saved.answer.selectedOptions).toEqual(['B']);
    expect(saved.answer.isFlagged).toBe(true);

    const paper = getAttemptPaper(db, attempt.attemptId);
    expect(paper.progress).toMatchObject({ answered: 1, unanswered: 5, flagged: 1 });
    expect(paper.answers[String(fixture.objectiveQuestions[0])].selectedOptions).toEqual(['B']);
  });

  it('stores essay text and supports partial updates without losing other fields', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    saveAnswer(db, studentActor(), attempt.attemptId, fixture.essayQuestionId, {
      answerText: 'Indexes reduce the number of pages scanned.',
    });
    saveAnswer(db, studentActor(), attempt.attemptId, fixture.essayQuestionId, { isFlagged: true });

    const paper = getAttemptPaper(db, attempt.attemptId);
    const answer = paper.answers[String(fixture.essayQuestionId)];
    expect(answer.answerText).toContain('Indexes reduce');
    expect(answer.isFlagged).toBe(true);
  });

  it('survives a new server-side read (no reliance on browser storage)', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    saveAnswer(db, studentActor(), attempt.attemptId, fixture.fillBlankQuestionId, { answerText: 'Paris' });
    const reloaded = getAttemptPaper(db, attempt.attemptId);
    expect(reloaded.answers[String(fixture.fillBlankQuestionId)].answerText).toBe('Paris');
  });

  it('rejects an option that is not part of the question', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    expect(() =>
      saveAnswer(db, studentActor(), attempt.attemptId, fixture.objectiveQuestions[0], { selectedOptions: ['Z'] }),
    ).toThrow(/does not belong/i);
  });

  it('blocks one candidate from writing to another candidate attempt', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    const other = { ...studentActor(), studentId: fixture.otherStudentId, id: fixture.otherStudentUserId };
    expect(() =>
      saveAnswer(db, other, attempt.attemptId, fixture.objectiveQuestions[0], { selectedOptions: ['A'] }),
    ).toThrow(/your own attempt/i);
  });
});

describe('server-authoritative timing', () => {
  it('auto-submits and refuses further edits once the server clock has expired', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    // Rewind the expiry: the candidate's browser cannot influence this.
    db.prepare('UPDATE attempts SET expires_at = ? WHERE id = ?').run(addMinutes(nowIso(), -1), attempt.attemptId);

    expect(() =>
      saveAnswer(db, studentActor(), attempt.attemptId, fixture.objectiveQuestions[0], { selectedOptions: ['B'] }),
    ).toThrow(/time has expired/i);

    const row = db.prepare('SELECT status, auto_submitted, submit_reason FROM attempts WHERE id = ?').get(
      attempt.attemptId,
    ) as { status: string; auto_submitted: number; submit_reason: string };
    expect(row.status).not.toBe('IN_PROGRESS');
    expect(row.auto_submitted).toBe(1);
    expect(row.submit_reason).toBe('time_expired');
  });

  it('expires overdue attempts through the scheduled job', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    db.prepare('UPDATE attempts SET expires_at = ? WHERE id = ?').run(addMinutes(nowIso(), -2), attempt.attemptId);

    const summary = expireAttempts(db);
    expect(summary.expired).toBe(1);
    const row = db.prepare('SELECT status FROM attempts WHERE id = ?').get(attempt.attemptId) as { status: string };
    expect(['GRADED', 'UNDER_REVIEW']).toContain(row.status);
  });

  it('caps the attempt expiry at the end of the examination window', () => {
    const endAt = addMinutes(nowIso(), 10);
    db.prepare('UPDATE exams SET end_at = ? WHERE id = ?').run(endAt, fixture.examId);
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    expect(new Date(attempt.expiresAt).getTime()).toBeLessThanOrEqual(new Date(endAt).getTime());
    expect(attempt.remainingSeconds).toBeLessThanOrEqual(600);
  });
});

describe('submission', () => {
  it('grades objective answers, stores the submission and creates a result', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    // Three correct (15 marks) and one wrong (−1) leaves 14 objective marks.
    saveAnswer(db, studentActor(), attempt.attemptId, fixture.objectiveQuestions[0], { selectedOptions: ['B'] });
    saveAnswer(db, studentActor(), attempt.attemptId, fixture.objectiveQuestions[1], { selectedOptions: ['B'] });
    saveAnswer(db, studentActor(), attempt.attemptId, fixture.objectiveQuestions[2], { selectedOptions: ['B'] });
    saveAnswer(db, studentActor(), attempt.attemptId, fixture.objectiveQuestions[3], { selectedOptions: ['A'] });
    saveAnswer(db, studentActor(), attempt.attemptId, fixture.fillBlankQuestionId, { answerText: 'paris' });
    saveAnswer(db, studentActor(), attempt.attemptId, fixture.essayQuestionId, {
      answerText: 'Indexing trades storage for read performance.',
    });

    const submission = submitAttempt(db, studentActor(), attempt.attemptId, 'manual');
    expect(submission.objectiveMarks).toBe(19); // 15 + 5 (fill in the blank) − 1 penalty
    expect(submission.subjectiveMarks).toBe(0);
    expect(submission.requiresManualGrading).toBe(true);
    expect(submission.status).toBe('UNDER_REVIEW');
    expect(submission.outcome).toBe('PENDING');
    expect(submission.resultId).toBeGreaterThan(0);
    expect(submission.resultPublished).toBe(false);
  });

  it('marks the attempt as graded when the paper has no written questions', () => {
    db.prepare('DELETE FROM exam_questions WHERE exam_id = ? AND question_id = ?').run(
      fixture.examId,
      fixture.essayQuestionId,
    );
    db.prepare('UPDATE exams SET total_marks = 20, pass_marks = 10 WHERE id = ?').run(fixture.examId);
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    fixture.objectiveQuestions.forEach((questionId) =>
      saveAnswer(db, studentActor(), attempt.attemptId, questionId, { selectedOptions: ['B'] }),
    );
    const submission = submitAttempt(db, studentActor(), attempt.attemptId, 'manual');
    expect(submission.requiresManualGrading).toBe(false);
    expect(submission.status).toBe('GRADED');
    expect(submission.totalObtained).toBe(20);
    expect(submission.percentage).toBe(100);
    expect(submission.outcome).toBe('PASSED');
  });

  it('prevents editing and duplicate submission once the attempt is locked', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    saveAnswer(db, studentActor(), attempt.attemptId, fixture.objectiveQuestions[0], { selectedOptions: ['B'] });
    submitAttempt(db, studentActor(), attempt.attemptId, 'manual');

    expect(() =>
      saveAnswer(db, studentActor(), attempt.attemptId, fixture.objectiveQuestions[1], { selectedOptions: ['B'] }),
    ).toThrow(/submitted/i);
    expect(() => submitAttempt(db, studentActor(), attempt.attemptId, 'manual')).toThrow(/already been submitted/i);

    const attempts = db
      .prepare('SELECT COUNT(*) AS c FROM attempts WHERE student_id = ? AND exam_id = ?')
      .get(fixture.studentId, fixture.examId) as { c: number };
    expect(attempts.c).toBe(1);
  });

  it('refuses attempts on an archived examination', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    db.prepare("UPDATE exams SET status = 'ARCHIVED' WHERE id = ?").run(fixture.examId);
    expect(() => submitAttempt(db, studentActor(), attempt.attemptId, 'manual')).toThrow(/archived/i);
  });

  it('stops a candidate submitting another candidate attempt', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    const other = { ...studentActor(), studentId: fixture.otherStudentId, id: fixture.otherStudentUserId };
    expect(() => submitAttempt(db, other, attempt.attemptId, 'manual')).toThrow(/your own attempt/i);
  });

  it('keeps historical papers reproducible after the source question changes', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    db.prepare('UPDATE questions SET text = ?, marks = 50 WHERE id = ?').run(
      'REWRITTEN QUESTION',
      fixture.objectiveQuestions[0],
    );
    const paper = getAttemptPaper(db, attempt.attemptId);
    expect(paper.questions[0].text).toBe('Objective question 1');
    expect(paper.questions[0].marks).toBe(5);
  });

  it('allows a system-driven submission without a candidate actor', () => {
    const attempt = startAttempt(db, studentActor(), { examId: fixture.examId });
    db.prepare('UPDATE attempts SET expires_at = ? WHERE id = ?').run(addMinutes(nowIso(), -1), attempt.attemptId);
    const result = submitAttempt(db, systemActor(), attempt.attemptId, 'time_expired', { auto: true });
    expect(result.attemptId).toBe(attempt.attemptId);
    const row = db.prepare('SELECT status, auto_submitted FROM attempts WHERE id = ?').get(attempt.attemptId) as {
      status: string;
      auto_submitted: number;
    };
    expect(row.auto_submitted).toBe(1);
  });
});
