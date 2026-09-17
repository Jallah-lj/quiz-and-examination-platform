/**
 * End-to-end API tests covering the documented workflow:
 * administrator → teacher → examination → candidate attempt → grading → result release.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { buildHarness, TEST_PASSWORD, type Fixture, type Harness } from '../test-utils/harness';
import { addMinutes, nowIso } from '../lib/time';

let harness: Harness;
let db: Db;
let fixture: Fixture;

beforeEach(() => {
  harness = buildHarness();
  db = harness.db;
  fixture = harness.fixture;
});

afterEach(() => {
  db.close();
});

describe('authentication', () => {
  it('signs a user in, exposes the session and signs out', async () => {
    const agent = await harness.login('student@alpha.test');

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.authenticated).toBe(true);
    expect(me.body.data.user.email).toBe('student@alpha.test');
    expect(me.body.data.user.student.student_code).toBe('S-001');

    const logout = await agent.post('/api/auth/logout');
    expect(logout.status).toBe(200);

    const afterLogout = await agent.get('/api/auth/me');
    expect(afterLogout.body.data.authenticated).toBe(false);
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const response = await harness.agent().post('/api/auth/login').send({
      email: 'student@alpha.test',
      password: 'Wrong-Password1',
    });
    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Incorrect email or password.');

    const unknown = await harness.agent().post('/api/auth/login').send({
      email: 'nobody@alpha.test',
      password: 'Wrong-Password1',
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe('Incorrect email or password.');
  });

  it('locks the account after repeated failures and records the attempts', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.agent().post('/api/auth/login').send({
        email: 'student@alpha.test',
        password: 'Wrong-Password1',
      });
    }
    const locked = await harness.agent().post('/api/auth/login').send({
      email: 'student@alpha.test',
      password: TEST_PASSWORD,
    });
    expect(locked.status).toBe(423);
    expect(locked.body.error.message).toMatch(/locked/i);

    const failures = db
      .prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE email = ? AND success = 0')
      .get('student@alpha.test') as { c: number };
    expect(failures.c).toBeGreaterThanOrEqual(5);

    const audit = db
      .prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'auth.login_failed'")
      .get() as { c: number };
    expect(audit.c).toBeGreaterThanOrEqual(5);
  });

  it('completes the forgot/reset password flow and invalidates old sessions', async () => {
    const agent = await harness.login('student@alpha.test');

    const request = await harness.agent().post('/api/auth/forgot-password').send({ email: 'student@alpha.test' });
    expect(request.status).toBe(200);
    const token = request.body.data.resetToken as string;
    expect(token).toBeTruthy();

    const reset = await harness
      .agent()
      .post('/api/auth/reset-password')
      .send({ token, password: 'Brand-New-Pass9' });
    expect(reset.status).toBe(200);

    const sessionInvalidated = await agent.get('/api/auth/me');
    expect(sessionInvalidated.body.data.authenticated).toBe(false);

    const loginWithOld = await harness.agent().post('/api/auth/login').send({
      email: 'student@alpha.test',
      password: TEST_PASSWORD,
    });
    expect(loginWithOld.status).toBe(401);

    const loginWithNew = await harness.agent().post('/api/auth/login').send({
      email: 'student@alpha.test',
      password: 'Brand-New-Pass9',
    });
    expect(loginWithNew.status).toBe(200);
  });

  it('changes a password when the current one is supplied', async () => {
    const agent = await harness.login('student@alpha.test');
    const wrong = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'Nope-Password1', newPassword: 'Another-Password2' });
    expect(wrong.status).toBe(422);

    const ok = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'Another-Password2' });
    expect(ok.status).toBe(200);
  });

  it('validates the login payload', async () => {
    const response = await harness.agent().post('/api/auth/login').send({ email: 'not-an-email', password: '' });
    expect(response.status).toBe(422);
    expect(response.body.error.details.length).toBeGreaterThan(0);
  });
});

describe('access control', () => {
  it('requires authentication for protected endpoints', async () => {
    const response = await harness.agent().get('/api/students');
    expect(response.status).toBe(401);
  });

  it('stops a candidate from reading staff-only collections', async () => {
    const agent = await harness.login('student@alpha.test');
    for (const url of ['/api/students', '/api/teachers', '/api/audit-logs', '/api/users', '/api/grading/queue']) {
      const response = await agent.get(url);
      expect(response.status, url).toBe(403);
    }
  });

  it('stops a teacher from managing platform institutions and users', async () => {
    const agent = await harness.login('teacher@alpha.test');
    const institutions = await agent.get('/api/institutions');
    // Reading is permitted (their own institution), creating is not.
    expect(institutions.status).toBe(200);
    expect(institutions.body.data).toHaveLength(1);

    const create = await agent.post('/api/institutions').send({ name: 'Rogue', code: 'ROGUE' });
    expect(create.status).toBe(403);

    const users = await agent.get('/api/users');
    expect(users.status).toBe(403);
  });

  it('prevents a candidate from escalating privileges by crafting a request', async () => {
    const agent = await harness.login('student@alpha.test');
    const response = await agent.post('/api/users').send({
      fullName: 'Escalation Attempt',
      email: 'escalate@alpha.test',
      role: 'institution_admin',
    });
    expect(response.status).toBe(403);

    const exam = await agent.post('/api/examinations').send({
      subjectId: fixture.subjectId,
      name: 'Self-made exam',
      code: 'EVIL-1',
      academicYear: '2025/2026',
      examType: 'FINAL',
      durationMinutes: 30,
      startAt: nowIso(),
      endAt: addMinutes(nowIso(), 60),
      passMarks: 10,
      maxAttempts: 1,
      questions: [{ questionId: fixture.objectiveQuestions[0], marks: 5, negativeMarks: 0 }],
    });
    expect(exam.status).toBe(403);
  });

  it('keeps institutions isolated from one another', async () => {
    const alphaTeacher = await harness.login('teacher@alpha.test');
    const foreignExam = await alphaTeacher.get(`/api/examinations/${fixture.examId}`);
    expect(foreignExam.status).toBe(200);

    // A candidate from Beta cannot touch Alpha data even knowing the identifiers.
    const foreignStudent = await harness.login('student@beta.test');
    const attempt = await foreignStudent.post('/api/attempts').send({ examId: fixture.examId });
    expect(attempt.status).toBe(403);

    const results = await foreignStudent.get('/api/results');
    expect(results.status).toBe(200);
    expect(results.body.data).toHaveLength(0);
  });

  it('requires a CSRF token for state-changing requests', async () => {
    const agent = await harness.login('teacher@alpha.test');
    agent.set('x-csrf-token', 'definitely-not-valid');
    const response = await agent.post('/api/examinations').send({});
    expect(response.status).toBe(403);
    expect(response.body.error.message).toMatch(/session token/i);
  });
});

describe('examination lifecycle through the API', () => {
  it('creates, schedules and assigns an examination as a teacher', async () => {
    const agent = await harness.login('teacher@alpha.test');
    const create = await agent.post('/api/examinations').send({
      subjectId: fixture.subjectId,
      classId: fixture.classId,
      name: 'Unit Test — Algorithms',
      code: 'UT-ALG-1',
      academicYear: '2025/2026',
      semester: 'Semester 1',
      examType: 'QUIZ',
      durationMinutes: 45,
      startAt: addMinutes(nowIso(), 60),
      endAt: addMinutes(nowIso(), 240),
      passMarks: 10,
      maxAttempts: 2,
      instructions: 'Answer every question.',
      randomizeQuestions: true,
      negativeMarking: true,
      questions: [
        { questionId: fixture.objectiveQuestions[0], marks: 5, negativeMarks: 1 },
        { questionId: fixture.objectiveQuestions[1], marks: 5, negativeMarks: 1 },
      ],
    });
    expect(create.status).toBe(201);
    const examId = create.body.data.id as number;
    expect(create.body.data.total_marks).toBe(10);
    expect(create.body.data.status).toBe('DRAFT');

    // Scheduling requires an assignment first.
    const blocked = await agent.post(`/api/examinations/${examId}/status`).send({ status: 'SCHEDULED' });
    expect(blocked.status).toBe(422);

    const assign = await agent.post(`/api/examinations/${examId}/assign`).send({ classIds: [fixture.classId] });
    expect(assign.status).toBe(200);
    expect(assign.body.data.assigned).toBeGreaterThan(0);

    const schedule = await agent.post(`/api/examinations/${examId}/status`).send({ status: 'SCHEDULED' });
    expect(schedule.status).toBe(200);
    expect(schedule.body.data.status).toBe('SCHEDULED');

    const invalid = await agent.post(`/api/examinations/${examId}/status`).send({ status: 'PUBLISHED' });
    expect(invalid.status).toBe(422);

    const audit = db
      .prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'exam.created' AND resource_id = ?")
      .get(String(examId)) as { c: number };
    expect(audit.c).toBe(1);

    const notification = db
      .prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'exam_assigned'")
      .get() as { c: number };
    expect(notification.c).toBeGreaterThan(0);
  });

  it('rejects an examination whose end time precedes its start time', async () => {
    const agent = await harness.login('teacher@alpha.test');
    const response = await agent.post('/api/examinations').send({
      subjectId: fixture.subjectId,
      name: 'Bad window',
      code: 'BAD-1',
      academicYear: '2025/2026',
      examType: 'FINAL',
      durationMinutes: 30,
      startAt: addMinutes(nowIso(), 120),
      endAt: addMinutes(nowIso(), 60),
      passMarks: 5,
      maxAttempts: 1,
      questions: [{ questionId: fixture.objectiveQuestions[0], marks: 5, negativeMarks: 0 }],
    });
    expect(response.status).toBe(422);
    expect(response.body.error.details.some((detail: any) => /end time/i.test(detail.message))).toBe(true);
  });

  it('stops a teacher from editing another teacher examination', async () => {
    // Reassign ownership to a different teacher.
    const otherTeacher = db
      .prepare("SELECT id FROM users WHERE email = 'teacher2@alpha.test'")
      .get() as { id: number };
    db.prepare('UPDATE exams SET created_by = ? WHERE id = ?').run(otherTeacher.id, fixture.examId);

    const agent = await harness.login('teacher@alpha.test');
    const response = await agent.patch(`/api/examinations/${fixture.examId}`).send({ durationMinutes: 90 });
    expect(response.status).toBe(403);

    // Administrators may still manage it.
    const admin = await harness.login('admin@alpha.test');
    const adminResponse = await admin.patch(`/api/examinations/${fixture.examId}`).send({ durationMinutes: 90 });
    expect(adminResponse.status).toBe(200);
  });
});

describe('candidate attempt flow through the API', () => {
  it('starts, auto-saves, submits and reveals the released result', async () => {
    const student = await harness.login('student@alpha.test');

    const start = await student.post('/api/attempts').send({ examId: fixture.examId });
    expect(start.status).toBe(201);
    const attemptId = start.body.data.attemptId as number;
    expect(start.body.data.remainingSeconds).toBeGreaterThan(0);

    const paper = await student.get(`/api/attempts/${attemptId}`);
    expect(paper.status).toBe(200);
    expect(paper.body.data.questions).toHaveLength(6);
    expect(paper.body.data.attempt.studentName).toBe('Sam Student');

    for (const questionId of fixture.objectiveQuestions) {
      const save = await student
        .patch(`/api/attempts/${attemptId}/answers/${questionId}`)
        .send({ selectedOptions: ['B'] });
      expect(save.status).toBe(200);
    }
    await student
      .patch(`/api/attempts/${attemptId}/answers/${fixture.fillBlankQuestionId}`)
      .send({ answerText: 'Paris' });
    await student
      .patch(`/api/attempts/${attemptId}/answers/${fixture.essayQuestionId}`)
      .send({ answerText: 'Indexes reduce page reads.' });

    const heartbeat = await student
      .post(`/api/attempts/${attemptId}/heartbeat`)
      .send({ clientRemainingSeconds: 10 });
    expect(heartbeat.status).toBe(200);
    // The server value wins and the drift is recorded for the examiner.
    expect(heartbeat.body.data.remainingSeconds).toBeGreaterThan(100);
    const flags = JSON.parse(
      (db.prepare('SELECT integrity_flags FROM attempts WHERE id = ?').get(attemptId) as { integrity_flags: string })
        .integrity_flags,
    ) as { type: string }[];
    expect(flags.some((flag) => flag.type === 'timer_drift')).toBe(true);

    const submit = await student.post(`/api/attempts/${attemptId}/submit`).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.requiresManualGrading).toBe(true);
    expect(submit.body.data.objectiveMarks).toBe(25); // 4 × 5 marks + 5 for the fill-in-the-blank
    expect(submit.body.data.status).toBe('UNDER_REVIEW');

    const duplicate = await student.post(`/api/attempts/${attemptId}/submit`).send({});
    expect(duplicate.status).toBe(409);

    const hidden = await student.get('/api/results');
    expect(hidden.body.data).toHaveLength(0);

    // A candidate may not read a result that has not been released yet.
    const reviewTooEarly = await student.get(`/api/attempts/${attemptId}/review`);
    expect(reviewTooEarly.status).toBe(403);
    expect(reviewTooEarly.body.error.message).toMatch(/not been released/i);

    // Staff can see the pending outcome for the same attempt.
    const teacher = await harness.login('teacher@alpha.test');
    const staffReview = await teacher.get(`/api/grading/attempts/${attemptId}`);
    expect(staffReview.status).toBe(200);
    expect(staffReview.body.data.attempt.status).toBe('UNDER_REVIEW');
  });

  it('stops a candidate reading another candidate attempt', async () => {
    const sam = await harness.login('student@alpha.test');
    const start = await sam.post('/api/attempts').send({ examId: fixture.examId });
    const attemptId = start.body.data.attemptId as number;

    const sara = await harness.login('student2@alpha.test');
    const read = await sara.get(`/api/attempts/${attemptId}`);
    expect(read.status).toBe(403);

    const write = await sara
      .patch(`/api/attempts/${attemptId}/answers/${fixture.objectiveQuestions[0]}`)
      .send({ selectedOptions: ['A'] });
    expect(write.status).toBe(403);
  });

  it('serves the candidate dashboard from real records only', async () => {
    const student = await harness.login('student@alpha.test');
    const dashboard = await student.get('/api/dashboard/student');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data.availableExams).toHaveLength(1);
    expect(dashboard.body.data.stats.total_attempts).toBe(0);

    const start = await student.post('/api/attempts').send({ examId: fixture.examId });
    expect(start.status).toBe(201);

    const afterStart = await student.get('/api/dashboard/student');
    expect(afterStart.body.data.stats.in_progress).toBe(1);
    expect(afterStart.body.data.availableExams[0].in_progress).toBe(1);
  });
});

describe('manual grading and result release', () => {
  async function satExam() {
    const student = await harness.login('student@alpha.test');
    const start = await student.post('/api/attempts').send({ examId: fixture.examId });
    const attemptId = start.body.data.attemptId as number;
    for (const questionId of fixture.objectiveQuestions) {
      await student.patch(`/api/attempts/${attemptId}/answers/${questionId}`).send({ selectedOptions: ['B'] });
    }
    await student
      .patch(`/api/attempts/${attemptId}/answers/${fixture.fillBlankQuestionId}`)
      .send({ answerText: 'Paris' });
    await student
      .patch(`/api/attempts/${attemptId}/answers/${fixture.essayQuestionId}`)
      .send({ answerText: 'Indexes reduce the number of pages read per lookup.' });
    await student.post(`/api/attempts/${attemptId}/submit`).send({});
    return attemptId;
  }

  it('requires a mark for every written answer before finalising', async () => {
    const attemptId = await satExam();
    const teacher = await harness.login('teacher@alpha.test');

    const detail = await teacher.get(`/api/grading/attempts/${attemptId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.questions).toHaveLength(6);
    const essay = detail.body.data.questions.find((q: any) => q.type === 'ESSAY');
    expect(essay.answer.answerText).toContain('Indexes reduce');

    const premature = await teacher.post(`/api/grading/attempts/${attemptId}/finalize`).send({});
    expect(premature.status).toBe(422);

    const grade = await teacher
      .post(`/api/grading/attempts/${attemptId}/answers/${essay.answer.id}`)
      .send({ awardedMarks: 15.5, comment: 'Strong answer, could mention selectivity.' });
    expect(grade.status).toBe(200);
    expect(grade.body.data.awardedMarks).toBe(15.5);

    const finalise = await teacher.post(`/api/grading/attempts/${attemptId}/finalize`).send({});
    expect(finalise.status).toBe(200);
    expect(finalise.body.data.objectiveMarks).toBe(25);
    expect(finalise.body.data.subjectiveMarks).toBe(15.5);
    expect(finalise.body.data.totalObtained).toBe(40.5);
    expect(finalise.body.data.percentage).toBeCloseTo(90, 1);
    expect(finalise.body.data.outcome).toBe('PASSED');

    const history = await teacher.get(`/api/grading/attempts/${attemptId}/history`);
    expect(history.body.data.length).toBeGreaterThanOrEqual(2);
    const graded = history.body.data.find((entry: any) => entry.action === 'grade');
    expect(graded.previousMarks).toBeNull();
    expect(graded.awardedMarks).toBe(15.5);
    expect(graded.comment).toContain('Strong answer');
  });

  it('clamps an awarded mark to the question maximum', async () => {
    const attemptId = await satExam();
    const teacher = await harness.login('teacher@alpha.test');
    const detail = await teacher.get(`/api/grading/attempts/${attemptId}`);
    const essay = detail.body.data.questions.find((q: any) => q.type === 'ESSAY');

    const grade = await teacher
      .post(`/api/grading/attempts/${attemptId}/answers/${essay.answer.id}`)
      .send({ awardedMarks: 500 });
    expect(grade.body.data.awardedMarks).toBe(20);
  });

  it('publishes results and only then exposes them to the candidate', async () => {
    const attemptId = await satExam();
    const teacher = await harness.login('teacher@alpha.test');
    const detail = await teacher.get(`/api/grading/attempts/${attemptId}`);
    const essay = detail.body.data.questions.find((q: any) => q.type === 'ESSAY');
    await teacher
      .post(`/api/grading/attempts/${attemptId}/answers/${essay.answer.id}`)
      .send({ awardedMarks: 18, comment: 'Excellent.' });
    await teacher.post(`/api/grading/attempts/${attemptId}/finalize`).send({});

    const student = await harness.login('student@alpha.test');
    const before = await student.get('/api/results');
    expect(before.body.data).toHaveLength(0);

    const publish = await teacher.post('/api/examinations/' + fixture.examId + '/publish-results').send({});
    expect(publish.status).toBe(200);
    expect(publish.body.data.published).toBe(1);

    const after = await student.get('/api/results');
    expect(after.body.data).toHaveLength(1);
    const result = after.body.data[0];
    expect(result.percentage).toBeCloseTo(95.56, 1);
    expect(result.outcome).toBe('PASSED');

    const detailResponse = await student.get(`/api/results/${result.id}`);
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.data.breakdown.length).toBe(6);
    expect(detailResponse.body.data.result.examinerName).toBeTruthy();

    const notification = db
      .prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'result_published'")
      .get() as { c: number };
    expect(notification.c).toBeGreaterThan(0);
  });

  it('blocks publishing while written answers remain unmarked', async () => {
    await satExam();
    const teacher = await harness.login('teacher@alpha.test');
    const response = await teacher.post(`/api/examinations/${fixture.examId}/publish-results`).send({});
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/unmarked/i);
  });

  it('withholds a result again when it is unpublished', async () => {
    const attemptId = await satExam();
    const teacher = await harness.login('teacher@alpha.test');
    const detail = await teacher.get(`/api/grading/attempts/${attemptId}`);
    const essay = detail.body.data.questions.find((q: any) => q.type === 'ESSAY');
    await teacher.post(`/api/grading/attempts/${attemptId}/answers/${essay.answer.id}`).send({ awardedMarks: 10 });
    await teacher.post(`/api/grading/attempts/${attemptId}/finalize`).send({});
    await teacher.post(`/api/examinations/${fixture.examId}/publish-results`).send({});

    // Unpublishing is an administrator privilege; examiners may only release results.
    const deniedUnpublish = await teacher.post('/api/results/unpublish').send({ attemptIds: [attemptId] });
    expect(deniedUnpublish.status).toBe(403);

    const admin = await harness.login('admin@alpha.test');
    const unpublish = await admin.post('/api/results/unpublish').send({ attemptIds: [attemptId] });
    expect(unpublish.status).toBe(200);

    const student = await harness.login('student@alpha.test');
    const results = await student.get('/api/results');
    expect(results.body.data).toHaveLength(0);
  });
});

describe('question bank integrity', () => {
  it('refuses to delete a question that an examination references', async () => {
    const teacher = await harness.login('teacher@alpha.test');
    const response = await teacher.delete(`/api/questions/${fixture.objectiveQuestions[0]}`);
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/archive it instead/i);

    const archived = await teacher
      .post(`/api/questions/${fixture.objectiveQuestions[0]}/archive`)
      .send({ archived: true });
    expect(archived.status).toBe(200);
    expect(archived.body.data.status).toBe('ARCHIVED');

    // The examination keeps working because the paper is snapshotted per attempt.
    expect(db.prepare('SELECT COUNT(*) AS c FROM exam_questions WHERE question_id = ?').get(fixture.objectiveQuestions[0])).toBeTruthy();
  });

  it('validates questions by type', async () => {
    const teacher = await harness.login('teacher@alpha.test');
    const noKey = await teacher.post('/api/questions').send({
      questionBankId: fixture.bankId,
      subjectId: fixture.subjectId,
      type: 'MCQ',
      text: 'Which option is correct?',
      marks: 2,
      options: [
        { label: 'A', text: 'One', isCorrect: false },
        { label: 'B', text: 'Two', isCorrect: false },
      ],
    });
    expect(noKey.status).toBe(422);
    expect(JSON.stringify(noKey.body.error.details)).toMatch(/correct option/i);

    const blank = await teacher.post('/api/questions').send({
      questionBankId: fixture.bankId,
      subjectId: fixture.subjectId,
      type: 'FILL_BLANK',
      text: 'The largest planet is ______.',
      marks: 2,
      answerConfig: { acceptedAnswers: [] },
    });
    expect(blank.status).toBe(422);
  });

  it('filters and searches the question bank', async () => {
    const teacher = await harness.login('teacher@alpha.test');
    const response = await teacher.get('/api/questions?q=Objective&type=MCQ&sort=marks&order=asc');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(4);
    expect(response.body.data[0].option_count).toBe(4);
  });
});

describe('reports and audit', () => {
  it('produces a CSV export of the candidate result report', async () => {
    const admin = await harness.login('admin@alpha.test');
    const response = await admin.get(
      `/api/reports/student-results?studentId=${fixture.studentId}&format=csv`,
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/csv/);
    expect(response.text).toContain('Candidate result report');
  });

  it('returns report data as JSON', async () => {
    const admin = await harness.login('admin@alpha.test');
    const response = await admin.get('/api/reports/pass-fail');
    expect(response.status).toBe(200);
    expect(response.body.data.columns.length).toBeGreaterThan(3);
    expect(response.body.data.generatedAt).toBeTruthy();
  });

  it('exposes audit entries to administrators only', async () => {
    const admin = await harness.login('admin@alpha.test');
    const response = await admin.get('/api/audit-logs');
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(response.body.data[0]).toHaveProperty('action');

    const teacher = await harness.login('teacher@alpha.test');
    const denied = await teacher.get('/api/audit-logs');
    expect(denied.status).toBe(403);
  });
});

describe('error handling', () => {
  it('returns a professional 404 payload for unknown endpoints', async () => {
    const response = await harness.agent().get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).not.toMatch(/stack|sqlite|at Object/i);
  });

  it('returns 404 for a missing examination without leaking internals', async () => {
    const agent = await harness.login('teacher@alpha.test');
    const response = await agent.get('/api/examinations/999999');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('does not disclose stack traces on validation errors', async () => {
    const agent = await harness.login('teacher@alpha.test');
    const response = await agent.post('/api/questions').send({ type: 'MCQ' });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\.ts:\d+/);
  });
});
