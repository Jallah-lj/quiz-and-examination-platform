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

describe('study groups and paper assignments', () => {
  /** A class belonging to the second tenant, used to prove cross-institution checks. */
  const insertForeignClass = () => {
    const timestamp = nowIso();
    return Number(
      db
        .prepare(
          `INSERT INTO classes (institution_id, name, code, academic_year, created_at, updated_at)
           VALUES (?, 'Beta Class', 'B-1', '2026', ?, ?)`,
        )
        .run(fixture.otherInstitutionId, timestamp, timestamp).lastInsertRowid,
    );
  };

  it('updates a study group and records who changed it', async () => {
    const admin = await harness.login('admin@alpha.test');
    const response = await admin.patch(`/api/groups/${fixture.groupId}`).send({
      name: 'Revision group (renamed)',
      description: 'Weekly problem clinic',
      classId: fixture.classId,
    });
    expect(response.status).toBe(200);
    expect(response.body.data.name).toBe('Revision group (renamed)');
    expect(response.body.data.description).toBe('Weekly problem clinic');
    expect(response.body.data.class_id).toBe(fixture.classId);

    const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'group.updated'").get() as any;
    expect(audit).toBeTruthy();
    expect(audit.resource_id).toBe(String(fixture.groupId)); // audit rows store the id as text
    expect(audit.actor_role).toBe('institution_admin');

    const reread = await admin.get(`/api/groups/${fixture.groupId}`);
    expect(reread.body.data.group.name).toBe('Revision group (renamed)');
  });

  it('keeps a group inside its own institution and refuses a foreign class', async () => {
    const foreignClassId = insertForeignClass();
    const admin = await harness.login('admin@alpha.test');

    const crossTenantClass = await admin.patch(`/api/groups/${fixture.groupId}`).send({ classId: foreignClassId });
    expect(crossTenantClass.status).toBe(422);
    expect(crossTenantClass.body.error.message).toMatch(/same institution/i);

    // The rejected update left the group untouched.
    const untouched = db.prepare('SELECT class_id FROM groups WHERE id = ?').get(fixture.groupId) as any;
    expect(untouched.class_id).toBe(fixture.classId);

    // A group in the other tenant is not even visible to this administrator.
    const platform = await harness.login('platform@examsys.test');
    const foreign = await platform.post('/api/groups').send({
      name: 'Beta group',
      institutionId: fixture.otherInstitutionId,
    });
    expect(foreign.status).toBe(201);
    const foreignId = foreign.body.data.id;
    expect((await admin.patch(`/api/groups/${foreignId}`).send({ name: 'Hijacked group' })).status).toBe(404);
    expect((await admin.delete(`/api/groups/${foreignId}`)).status).toBe(404);
    expect((await admin.patch('/api/groups/999999').send({ name: 'Ghost group' })).status).toBe(404);
  });

  it('validates the payload and requires the group permission', async () => {
    const admin = await harness.login('admin@alpha.test');
    expect((await admin.patch(`/api/groups/${fixture.groupId}`).send({ name: 'x' })).status).toBe(422);

    const student = await harness.login('student@alpha.test');
    expect((await student.patch(`/api/groups/${fixture.groupId}`).send({ name: 'Student edit' })).status).toBe(403);
    expect((await student.delete(`/api/groups/${fixture.groupId}`)).status).toBe(403);
  });

  it('removes a group together with its membership rows', async () => {
    const admin = await harness.login('admin@alpha.test');
    const members = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(fixture.groupId) as {
      c: number;
    };
    expect(members.c).toBe(1);

    const response = await admin.delete(`/api/groups/${fixture.groupId}`);
    expect(response.status).toBe(200);
    expect(response.body.data.membersRemoved).toBe(1);

    expect(db.prepare('SELECT id FROM groups WHERE id = ?').get(fixture.groupId)).toBeUndefined();
    const leftover = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(fixture.groupId) as {
      c: number;
    };
    expect(leftover.c).toBe(0);

    const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'group.deleted'").get() as any;
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit.metadata).memberCount).toBe(1);
  });

  it('refuses to delete a group that is still assigned to a paper', async () => {
    db.prepare('INSERT INTO exam_assignments (exam_id, group_id, assigned_by, assigned_at) VALUES (?,?,?,?)').run(
      fixture.examId,
      fixture.groupId,
      fixture.adminUserId,
      nowIso(),
    );

    const admin = await harness.login('admin@alpha.test');
    const response = await admin.delete(`/api/groups/${fixture.groupId}`);
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/still assigned/i);

    // The group and the assignment that would have cascaded away are both intact.
    expect(db.prepare('SELECT id FROM groups WHERE id = ?').get(fixture.groupId)).toBeTruthy();
    const assignments = db
      .prepare('SELECT COUNT(*) AS c FROM exam_assignments WHERE group_id = ?')
      .get(fixture.groupId) as { c: number };
    expect(assignments.c).toBe(1);
  });

  it('creates a quiz, assigns it to a class and removes the assignment', async () => {
    const admin = await harness.login('admin@alpha.test');
    const created = await admin.post('/api/quizzes').send({
      subjectId: fixture.subjectId,
      classId: fixture.classId,
      title: 'Week 4 recap quiz',
      questionCount: 1,
      timeLimitMinutes: 20,
      maxAttempts: 1,
      passPercentage: 50,
      availableFrom: nowIso(),
      availableUntil: addMinutes(nowIso(), 60 * 24),
      questions: [{ questionId: fixture.objectiveQuestions[0], marks: 5, negativeMarks: 0 }],
    });
    expect(created.status).toBe(201);
    const quizId = created.body.data.id;

    const assigned = await admin.post(`/api/quizzes/${quizId}/assign`).send({ classIds: [fixture.classId] });
    expect(assigned.status).toBe(200);

    const detail = await admin.get(`/api/quizzes/${quizId}`);
    expect(detail.body.data.assignments).toHaveLength(1);
    const assignmentId = detail.body.data.assignments[0].id;

    const removed = await admin.delete(`/api/quizzes/${quizId}/assignments/${assignmentId}`);
    expect(removed.status).toBe(200);
    expect((await admin.get(`/api/quizzes/${quizId}`)).body.data.assignments).toHaveLength(0);

    const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'quiz.unassigned'").get() as any;
    expect(audit).toBeTruthy();
    expect(audit.resource_id).toBe(String(quizId));

    // Removing it twice, or under a quiz that does not exist, is a clean 404.
    expect((await admin.delete(`/api/quizzes/${quizId}/assignments/${assignmentId}`)).status).toBe(404);
    expect((await admin.delete(`/api/quizzes/999999/assignments/${assignmentId}`)).status).toBe(404);
  });

  it('refuses to unassign a quiz once a candidate has attempted it', async () => {
    const admin = await harness.login('admin@alpha.test');
    const created = await admin.post('/api/quizzes').send({
      subjectId: fixture.subjectId,
      classId: fixture.classId,
      title: 'Locked quiz',
      questionCount: 1,
      timeLimitMinutes: 15,
      maxAttempts: 1,
      passPercentage: 50,
      availableFrom: nowIso(),
      availableUntil: addMinutes(nowIso(), 60 * 24),
      questions: [{ questionId: fixture.objectiveQuestions[0], marks: 5, negativeMarks: 0 }],
    });
    const quizId = created.body.data.id;
    await admin.post(`/api/quizzes/${quizId}/assign`).send({ classIds: [fixture.classId] });
    const assignmentId = (await admin.get(`/api/quizzes/${quizId}`)).body.data.assignments[0].id;

    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO attempts (institution_id, quiz_id, student_id, status, started_at, expires_at, last_activity_at, created_at, updated_at)
       VALUES (?,?,?, 'SUBMITTED', ?, ?, ?, ?, ?)`,
    ).run(fixture.institutionId, quizId, fixture.studentId, timestamp, addMinutes(timestamp, 15), timestamp, timestamp, timestamp);

    const blocked = await admin.delete(`/api/quizzes/${quizId}/assignments/${assignmentId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/already attempted/i);
    expect((await admin.get(`/api/quizzes/${quizId}`)).body.data.assignments).toHaveLength(1);
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

describe('role dashboards', () => {
  it('surfaces the candidate work queue, next deadline and score history', async () => {
    const student = await harness.login('student@alpha.test');
    const before = await student.get('/api/dashboard/student');
    expect(before.status).toBe(200);
    expect(before.body.data.scoreTrend).toEqual([]);
    expect(typeof before.body.data.stats.best_percentage).toBe('number');
    expect(before.body.data.nextDeadline.kind).toBe('EXAM');
    expect(before.body.data.nextDeadline.action).toBe('start');

    // Starting an attempt moves the candidate into a state the panel must report.
    const start = await student.post('/api/attempts').send({ examId: fixture.examId });
    expect(start.status).toBe(201);

    const after = await student.get('/api/dashboard/student');
    const keys = after.body.data.attention.map((item: { key: string }) => item.key);
    expect(keys).toContain('resume');
    expect(after.body.data.nextDeadline.action).toBe('resume');
    expect(after.body.data.attention.every((item: { link: string }) => item.link.startsWith('/'))).toBe(true);
  });

  it('reports the failures the pass rate is measured against', async () => {
    const student = await harness.login('student@alpha.test');
    const start = await student.post('/api/attempts').send({ examId: fixture.examId });
    const attemptId = start.body.data.attemptId as number;
    for (const questionId of fixture.objectiveQuestions) {
      // 'A' is not the key the fixture marks correct, so the attempt fails once marked.
      await student.patch(`/api/attempts/${attemptId}/answers/${questionId}`).send({ selectedOptions: ['A'] });
    }
    await student
      .patch(`/api/attempts/${attemptId}/answers/${fixture.essayQuestionId}`)
      .send({ answerText: 'Covering indexes avoid the table lookup.' });
    await student.post(`/api/attempts/${attemptId}/submit`).send({});

    const teacher = await harness.login('teacher@alpha.test');
    const attempt = await teacher.get(`/api/grading/attempts/${attemptId}`);
    const essay = attempt.body.data.questions.find(
      (question: { type: string }) => question.type === 'ESSAY',
    );
    await teacher
      .post(`/api/grading/attempts/${attemptId}/answers/${essay.answer.id}`)
      .send({ awardedMarks: 0, comment: 'Not attempted.' });
    await teacher.post(`/api/grading/attempts/${attemptId}/finalize`).send({});

    const admin = await harness.login('admin@alpha.test');
    const dashboard = await admin.get('/api/dashboard/admin');
    expect(dashboard.status).toBe(200);
    const { graded, passed, failed } = dashboard.body.data.passRate;
    // The three figures must account for every graded result.
    expect(graded).toBe(passed + failed);
    expect(failed).toBe(1);
    expect(dashboard.body.data.passRate.passRate).toBe(0);
  });

  it('separates submissions awaiting a result from submissions grading never recorded', async () => {
    const student = await harness.login('student@alpha.test');
    const start = await student.post('/api/attempts').send({ examId: fixture.examId });
    const attemptId = start.body.data.attemptId as number;
    await student
      .patch(`/api/attempts/${attemptId}/answers/${fixture.essayQuestionId}`)
      .send({ answerText: 'Partial answer.' });
    await student.post(`/api/attempts/${attemptId}/submit`).send({});

    const admin = await harness.login('admin@alpha.test');
    const dashboard = await admin.get('/api/dashboard/admin');
    // The submission is queued with a pending result and one written answer to mark.
    expect(dashboard.body.data.gradingBacklog).toMatchObject({
      queue: 1,
      ungraded_answers: 1,
      awaiting_results: 0,
    });
    const marking = dashboard.body.data.attention.find((item: { key: string }) => item.key === 'grading');
    expect(marking).toBeTruthy();
    expect(marking.link).toBe('/grading');
    // Submitting records a result row, so no integrity warning is raised.
    expect(
      dashboard.body.data.attention.find((item: { key: string }) => item.key === 'missing-results'),
    ).toBeUndefined();
  });

  it('flags a paper whose pass mark falls inside a failing grade band', async () => {
    const admin = await harness.login('admin@alpha.test');
    // The fixture paper passes at 20 of 45 marks (44.44%), inside the default scale's
    // failing band, so it is reported along with the numbers behind the conflict.
    const before = await admin.get('/api/dashboard/admin');
    expect(before.body.data.paperIntegrity.pass_mark_in_failing_band).toBe(1);
    const [conflict] = before.body.data.passMarkConflicts;
    expect(conflict.id).toBe(fixture.examId);
    expect(conflict.pass_percentage).toBeCloseTo(44.44, 2);
    expect(conflict.lowest_passing_band).toBe(50);
    const item = before.body.data.attention.find(
      (entry: { key: string }) => entry.key === 'pass-mark-conflict',
    );
    expect(item.severity).toBe('warning');
    expect(item.link).toBe(`/examinations/${fixture.examId}`);

    // Raising the pass mark past the failing band clears the conflict.
    const update = await admin.patch(`/api/examinations/${fixture.examId}`).send({ passMarks: 25 });
    expect(update.status).toBe(200);

    const after = await admin.get('/api/dashboard/admin');
    expect(after.body.data.paperIntegrity.pass_mark_in_failing_band).toBe(0);
    expect(after.body.data.passMarkConflicts).toEqual([]);
    expect(
      after.body.data.attention.find((entry: { key: string }) => entry.key === 'pass-mark-conflict'),
    ).toBeUndefined();
  });

  it('reports the written answers still blocking publication, including blank ones', async () => {
    const student = await harness.login('student@alpha.test');
    const start = await student.post('/api/attempts').send({ examId: fixture.examId });
    const attemptId = start.body.data.attemptId as number;
    for (const questionId of fixture.objectiveQuestions) {
      await student.patch(`/api/attempts/${attemptId}/answers/${questionId}`).send({ selectedOptions: ['A'] });
    }
    await student
      .patch(`/api/attempts/${attemptId}/answers/${fixture.fillBlankQuestionId}`)
      .send({ answerText: 'Paris' });
    await student
      .patch(`/api/attempts/${attemptId}/answers/${fixture.essayQuestionId}`)
      .send({ answerText: 'Indexes cut the pages read per lookup.' });
    const submit = await student.post(`/api/attempts/${attemptId}/submit`).send({});
    expect(submit.status).toBe(200);
    expect(submit.body.data.status).toBe('UNDER_REVIEW');

    const teacher = await harness.login('teacher@alpha.test');
    const dashboard = await teacher.get('/api/dashboard/teacher');
    expect(dashboard.status).toBe(200);
    // The fixture paper holds exactly one written question, and it is unmarked.
    expect(dashboard.body.data.gradingBacklog).toMatchObject({ ungraded_answers: 1, attempts: 1 });
    expect(dashboard.body.data.gradingBacklog.oldest_submission).toBeTruthy();
    const flagged = dashboard.body.data.attention.find((item: { key: string }) => item.key === 'grading');
    expect(flagged.link).toBe('/grading');
    expect(dashboard.body.data.paperHealth).toMatchObject({
      exams_without_questions: expect.any(Number),
      scheduled_without_candidates: expect.any(Number),
      exams_ending_soon: expect.any(Number),
    });

    // The marking queue must agree with the dashboard and with the publication gate.
    const queue = await teacher.get('/api/grading/queue?status=pending&pageSize=50');
    const queued = queue.body.data.find((row: { id: number }) => row.id === attemptId);
    expect(queued).toMatchObject({ subjective_count: 1, ungraded_count: 1 });

    // Marking it clears both the figure and the exception that points at it.
    const detail = await teacher.get(`/api/grading/attempts/${attemptId}`);
    const essay = detail.body.data.questions.find((question: any) => question.type === 'ESSAY');
    const marked = await teacher
      .post(`/api/grading/attempts/${attemptId}/answers/${essay.answer.id}`)
      .send({ awardedMarks: 12, comment: 'Marked.' });
    expect(marked.status).toBe(200);

    const cleared = await teacher.get('/api/dashboard/teacher');
    expect(cleared.body.data.gradingBacklog.ungraded_answers).toBe(0);
    expect(
      cleared.body.data.attention.find((item: { key: string }) => item.key === 'grading'),
    ).toBeUndefined();
    const clearedQueue = await teacher.get('/api/grading/queue?status=pending&pageSize=50');
    expect(
      clearedQueue.body.data.find((row: { id: number }) => row.id === attemptId).ungraded_count,
    ).toBe(0);
  });

  it('reports institution lifecycle, movement and continuous daily series to administrators', async () => {
    const admin = await harness.login('admin@alpha.test');
    const dashboard = await admin.get('/api/dashboard/admin');
    expect(dashboard.status).toBe(200);
    const body = dashboard.body.data;

    // The pipeline must account for every examination in the institution.
    const pipelined = body.examPipeline.reduce(
      (sum: number, stage: { count: number }) => sum + stage.count,
      0,
    );
    expect(pipelined).toBe(body.counts.exams);

    expect(body.deltas.submissions).toMatchObject({
      current: expect.any(Number),
      previous: expect.any(Number),
      days: 14,
    });
    // Charts need a continuous range: one row per day, oldest first, no gaps.
    expect(body.submissionsByDay).toHaveLength(30);
    const days = body.submissionsByDay.map((row: { day: string }) => row.day);
    expect([...days].sort()).toEqual(days);
    expect(new Set(days).size).toBe(30);
    expect(Object.prototype.hasOwnProperty.call(body.submissionsByDay[0], 'submissions')).toBe(true);

    expect(body.paperIntegrity).toMatchObject({
      exams_without_questions: expect.any(Number),
      scheduled_without_candidates: expect.any(Number),
      pending_accounts: expect.any(Number),
      exams_ending_soon: expect.any(Number),
    });
    expect(body.atRiskStudents).toEqual([]);
    expect(body.attention.every((item: { link: string }) => item.link.startsWith('/'))).toBe(true);
  });

  it('keeps the platform dashboard scoped to platform staff with continuous activity series', async () => {
    const platform = await harness.login('platform@examsys.test');
    const dashboard = await platform.get('/api/dashboard/platform');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data.submissionsByDay).toHaveLength(30);
    expect(dashboard.body.data.loginActivity).toHaveLength(14);
    expect(dashboard.body.data.accountMix.length).toBeGreaterThan(0);
    expect(dashboard.body.data.deltas.signups.days).toBe(30);
    // Beta Institute has no administrator, so the exception is legitimate.
    const flagged = dashboard.body.data.attention.find(
      (item: { key: string }) => item.key === 'institutions-without-admin',
    );
    expect(flagged.title).toContain('1 active institution');

    // The internal platform office is not a tenant: adding it must not raise the count.
    db.prepare(
      `INSERT INTO institutions (name, code, status, is_demo, created_at, updated_at)
       VALUES ('Platform Office', 'PLATFORM', 'active', 0, ?, ?)`,
    ).run(nowIso(), nowIso());
    const withOffice = await platform.get('/api/dashboard/platform');
    const stillOne = withOffice.body.data.attention.find(
      (item: { key: string }) => item.key === 'institutions-without-admin',
    );
    expect(stillOne.title).toContain('1 active institution');

    const admin = await harness.login('admin@alpha.test');
    const forbidden = await admin.get('/api/dashboard/platform');
    expect(forbidden.status).toBe(403);
  });

  it('tells a candidate why their result has not been released, truthfully', async () => {
    const student = await harness.login('student@alpha.test');
    const started = await student.post('/api/attempts').send({ examId: fixture.examId });
    const attemptId = started.body.data.attemptId as number;
    await student
      .patch(`/api/attempts/${attemptId}/answers/${fixture.essayQuestionId}`)
      .send({ answerText: 'Partial.' });
    await student.post(`/api/attempts/${attemptId}/submit`).send({});

    // The paper holds a written question, so an examiner really is the reason it waits.
    const before = await student.get('/api/dashboard/student');
    const awaiting = before.body.data.attention.find((item: { key: string }) => item.key === 'awaiting');
    expect(awaiting.detail).toMatch(/1 written answer still to be marked/i);

    // Once that answer is marked the only thing left is publication, and the notice says so
    // instead of claiming someone is still marking.
    const teacher = await harness.login('teacher@alpha.test');
    const attempt = await teacher.get(`/api/grading/attempts/${attemptId}`);
    const essay = attempt.body.data.questions.find((question: { type: string }) => question.type === 'ESSAY');
    await teacher
      .post(`/api/grading/attempts/${attemptId}/answers/${essay.answer.id}`)
      .send({ awardedMarks: 5, comment: 'Marked.' });

    const after = await student.get('/api/dashboard/student');
    const notice = after.body.data.attention.find((item: { key: string }) => item.key === 'awaiting');
    expect(notice.detail).toMatch(/nothing needs marking by hand/i);
    expect(notice.detail).not.toMatch(/written answer/i);
  });

  it('makes an institution explicit for platform staff instead of reporting zeros', async () => {
    const platform = await harness.login('platform@examsys.test');

    // A platform administrator has no institution of their own: an unscoped institution
    // dashboard must say so rather than render a page of zeros.
    const unscoped = await platform.get('/api/dashboard/admin');
    expect(unscoped.status).toBe(422);
    expect(unscoped.body.error.message).toMatch(/select an institution/i);
    expect((await platform.get('/api/dashboard/teacher')).status).toBe(422);

    // Naming a real institution returns that institution's records.
    const scoped = await platform.get(`/api/dashboard/admin?institutionId=${fixture.institutionId}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.data.counts.students).toBe(2);
    expect(scoped.body.data.counts.exams).toBe(1);
    expect(scoped.body.data.pipeline ?? scoped.body.data.examPipeline).toBeTruthy();

    // The other tenant is available too, and unknown ids are rejected clearly.
    const other = await platform.get(`/api/dashboard/admin?institutionId=${fixture.otherInstitutionId}`);
    expect(other.status).toBe(200);
    expect(other.body.data.counts.students).toBe(1);
    expect((await platform.get('/api/dashboard/admin?institutionId=9999')).status).toBe(404);
    expect((await platform.get('/api/dashboard/admin?institutionId=abc')).status).toBe(422);
  });

  it('pins institution staff to their own institution', async () => {
    const admin = await harness.login('admin@alpha.test');
    expect((await admin.get(`/api/dashboard/admin?institutionId=${fixture.institutionId}`)).status).toBe(200);
    // Asking for a different tenant is refused rather than silently ignored.
    const foreign = await admin.get(`/api/dashboard/admin?institutionId=${fixture.otherInstitutionId}`);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.message).toMatch(/your own institution/i);
    // The teacher dashboard follows the same rule.
    expect((await admin.get(`/api/dashboard/teacher?institutionId=${fixture.otherInstitutionId}`)).status).toBe(403);
  });

  it('filters the question bank to questions stored without an explanation', async () => {
    const teacher = await harness.login('teacher@alpha.test');
    const author = { questionBankId: fixture.bankId, subjectId: fixture.subjectId, type: 'MCQ', marks: 2 };
    const withoutExplanation = await teacher.post('/api/questions').send({
      ...author,
      text: 'Which structure holds a LIFO order?',
      options: [
        { label: 'A', text: 'Queue', isCorrect: false, position: 0 },
        { label: 'B', text: 'Stack', isCorrect: true, position: 1 },
      ],
    });
    expect(withoutExplanation.status).toBe(201);
    const withExplanation = await teacher.post('/api/questions').send({
      ...author,
      text: 'Which structure holds a FIFO order?',
      explanation: 'A queue removes the oldest element first.',
      options: [
        { label: 'A', text: 'Stack', isCorrect: false, position: 0 },
        { label: 'B', text: 'Queue', isCorrect: true, position: 1 },
      ],
    });
    expect(withExplanation.status).toBe(201);

    const filtered = await teacher.get('/api/questions?pageSize=100&mine=true&missingExplanation=true');
    expect(filtered.status).toBe(200);
    const ids = filtered.body.data.map((question: { id: number }) => question.id);
    expect(ids).toContain(withoutExplanation.body.data.id);
    expect(ids).not.toContain(withExplanation.body.data.id);
    expect(
      filtered.body.data.every((question: { created_by_name: string }) => question.created_by_name === 'Tom Teacher'),
    ).toBe(true);
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
