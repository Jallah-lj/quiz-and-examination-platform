/**
 * Integration-test harness: boots the real Express application against an isolated
 * in-memory SQLite database seeded with a minimal but complete academic structure.
 */
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import type { Db } from '../db';
import { createTestDatabase, setDbForTesting } from '../db';
import { syncRolesAndPermissions } from '../db/bootstrap';
import apiRouter from '../routes';
import { authenticate } from '../middleware/auth';
import { errorHandler, notFoundHandler } from '../middleware/errors';
import { noStore, securityHeaders } from '../middleware/security';
import { hashPasswordSync } from '../lib/crypto';
import { addDays, nowIso } from '../lib/time';

export const TEST_PASSWORD = 'Test-Password1';

export interface Harness {
  app: Express;
  db: Db;
  fixture: Fixture;
  agent: () => request.Agent;
  login: (email: string, password?: string) => Promise<request.SuperAgentTest>;
}

export interface Fixture {
  institutionId: number;
  otherInstitutionId: number;
  adminUserId: number;
  platformUserId: number;
  teacherUserId: number;
  teacherId: number;
  studentUserId: number;
  studentId: number;
  otherStudentUserId: number;
  otherStudentId: number;
  foreignStudentUserId: number;
  foreignStudentId: number;
  classId: number;
  subjectId: number;
  bankId: number;
  objectiveQuestions: number[];
  essayQuestionId: number;
  fillBlankQuestionId: number;
  examId: number;
  groupId: number;
}

export function buildHarness(): Harness {
  const db = createTestDatabase();
  setDbForTesting(db);
  syncRolesAndPermissions(db);

  const app = express();
  app.set('etag', false);
  app.use(securityHeaders);
  app.use(express.json());
  app.use(cookieParser());
  app.use(authenticate);
  app.use('/api', noStore);
  app.use('/api', apiRouter);
  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  const fixture = seedFixture(db);

  return {
    app,
    db,
    fixture,
    agent: () => request.agent(app),
    login: async (email: string, password = TEST_PASSWORD): Promise<request.SuperAgentTest> => {
      const agent = request.agent(app) as unknown as request.SuperAgentTest;
      const response = await agent.post('/api/auth/login').send({ email, password });
      if (response.status !== 200) {
        throw new Error(`Test login failed for ${email}: ${response.status} ${JSON.stringify(response.body)}`);
      }
      // supertest stores cookies on the agent; the CSRF token is returned once.
      (agent as unknown as { set: (field: string, value: string) => void }).set(
        'x-csrf-token',
        response.body.data.csrfToken,
      );
      return agent;
    },
  };
}

function roleId(db: Db, code: string): number {
  return (db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: number }).id;
}

function insertUser(
  db: Db,
  params: {
    institutionId: number | null;
    role: string;
    name: string;
    email: string;
    status?: string;
    lastLoginAt?: string | null;
  },
): number {
  const timestamp = nowIso();
  const info = db
    .prepare(
      `INSERT INTO users (institution_id, role_id, full_name, email, password_hash, status, email_verified_at, created_at, updated_at, last_login_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      params.institutionId,
      roleId(db, params.role),
      params.name,
      params.email,
      hashPasswordSync(TEST_PASSWORD),
      params.status ?? 'active',
      timestamp,
      timestamp,
      timestamp,
      params.lastLoginAt ?? null,
    );
  return Number(info.lastInsertRowid);
}

/** Creates two independent institutions so isolation can be tested directly. */
export function seedFixture(db: Db): Fixture {
  const timestamp = nowIso();

  const createInstitution = (name: string, code: string) => {
    const info = db
      .prepare(
        `INSERT INTO institutions (name, code, type, country, timezone, status, created_at, updated_at)
         VALUES (?,?,?,?,?, 'active', ?, ?)`,
      )
      .run(name, code, 'school', 'Testland', 'UTC', timestamp, timestamp);
    const id = Number(info.lastInsertRowid);
    const scheme = db
      .prepare(
        `INSERT INTO grading_schemes (institution_id, name, description, is_default, pass_percentage, created_at, updated_at)
         VALUES (?, 'Default scale', 'Test scale', 1, 50, ?, ?)`,
      )
      .run(id, timestamp, timestamp);
    const schemeId = Number(scheme.lastInsertRowid);
    const bands: [string, number, number][] = [
      ['A', 80, 100],
      ['B', 70, 79.99],
      ['C', 60, 69.99],
      ['D', 50, 59.99],
      ['F', 0, 49.99],
    ];
    const insertBand = db.prepare(
      'INSERT INTO grading_bands (scheme_id, grade, min_percentage, max_percentage, points, position) VALUES (?,?,?,?,?,?)',
    );
    bands.forEach((band, index) => insertBand.run(schemeId, band[0], band[1], band[2], index + 1, index));
    return id;
  };

  const institutionId = createInstitution('Alpha College', 'ALPHA');
  const otherInstitutionId = createInstitution('Beta Institute', 'BETA');

  const adminUserId = insertUser(db, {
    institutionId,
    role: 'institution_admin',
    name: 'Ada Admin',
    email: 'admin@alpha.test',
  });
  // Platform staff are not attached to a school; they administer the whole installation.
  const platformUserId = insertUser(db, {
    institutionId: null,
    role: 'super_admin',
    name: 'Pat Platform',
    email: 'platform@examsys.test',
  });
  const teacherUserId = insertUser(db, {
    institutionId,
    role: 'teacher',
    name: 'Tom Teacher',
    email: 'teacher@alpha.test',
  });
  const secondTeacherUserId = insertUser(db, {
    institutionId,
    role: 'teacher',
    name: 'Tina Other',
    email: 'teacher2@alpha.test',
  });
  const studentUserId = insertUser(db, {
    institutionId,
    role: 'student',
    name: 'Sam Student',
    email: 'student@alpha.test',
  });
  const otherStudentUserId = insertUser(db, {
    institutionId,
    role: 'student',
    name: 'Sara Student',
    email: 'student2@alpha.test',
  });
  const foreignStudentUserId = insertUser(db, {
    institutionId: otherInstitutionId,
    role: 'student',
    name: 'Fiona Foreign',
    email: 'student@beta.test',
  });
  void secondTeacherUserId;

  const departmentId = Number(
    db
      .prepare(
        `INSERT INTO departments (institution_id, name, code, created_at, updated_at) VALUES (?, 'Science', 'SCI', ?, ?)`,
      )
      .run(institutionId, timestamp, timestamp).lastInsertRowid,
  );

  const subjectId = Number(
    db
      .prepare(
        `INSERT INTO subjects (institution_id, department_id, name, code, created_at, updated_at)
         VALUES (?,?, 'Computer Science', 'CS101', ?, ?)`,
      )
      .run(institutionId, departmentId, timestamp, timestamp).lastInsertRowid,
  );

  const classId = Number(
    db
      .prepare(
        `INSERT INTO classes (institution_id, department_id, name, code, academic_year, created_at, updated_at)
         VALUES (?,?, 'Form 5A', 'F5A', '2025/2026', ?, ?)`,
      )
      .run(institutionId, departmentId, timestamp, timestamp).lastInsertRowid,
  );

  const teacherId = Number(
    db
      .prepare(
        `INSERT INTO teachers (user_id, institution_id, department_id, staff_code, status, created_at, updated_at)
         VALUES (?,?,?, 'T-001', 'active', ?, ?)`,
      )
      .run(teacherUserId, institutionId, departmentId, timestamp, timestamp).lastInsertRowid,
  );

  const createStudent = (userId: number, institution: number, code: string, classRef: number | null) =>
    Number(
      db
        .prepare(
          `INSERT INTO students (user_id, institution_id, class_id, student_code, status, created_at, updated_at)
           VALUES (?,?,?,?, 'active', ?, ?)`,
        )
        .run(userId, institution, classRef, code, timestamp, timestamp).lastInsertRowid,
    );

  const studentId = createStudent(studentUserId, institutionId, 'S-001', classId);
  const otherStudentId = createStudent(otherStudentUserId, institutionId, 'S-002', classId);
  const foreignStudentId = createStudent(foreignStudentUserId, otherInstitutionId, 'B-001', null);

  const groupId = Number(
    db
      .prepare(
        `INSERT INTO groups (institution_id, class_id, name, created_by, created_at, updated_at)
         VALUES (?,?, 'Revision group', ?, ?, ?)`,
      )
      .run(institutionId, classId, teacherUserId, timestamp, timestamp).lastInsertRowid,
  );
  db.prepare('INSERT INTO group_members (group_id, student_id, added_at) VALUES (?,?,?)').run(
    groupId,
    studentId,
    timestamp,
  );

  const bankId = Number(
    db
      .prepare(
        `INSERT INTO question_banks (institution_id, subject_id, name, created_by, created_at, updated_at)
         VALUES (?,?, 'CS101 bank', ?, ?, ?)`,
      )
      .run(institutionId, subjectId, teacherUserId, timestamp, timestamp).lastInsertRowid,
  );

  const insertQuestion = (params: {
    type: string;
    text: string;
    marks: number;
    negativeMarks?: number;
    answerConfig: Record<string, unknown>;
    options?: { label: string; text: string; correct: boolean }[];
  }) => {
    const info = db
      .prepare(
        `INSERT INTO questions
          (institution_id, question_bank_id, subject_id, topic, type, text, explanation, marks, negative_marks,
           difficulty, status, tags, answer_config, created_by, updated_by, created_at, updated_at)
         VALUES (?,?,?, 'Algorithms', ?, ?, 'Because it is.', ?, ?, 'MEDIUM', 'ACTIVE', '["test"]', ?, ?, ?, ?, ?)`,
      )
      .run(
        institutionId,
        bankId,
        subjectId,
        params.type,
        params.text,
        params.marks,
        params.negativeMarks ?? 0,
        JSON.stringify(params.answerConfig),
        teacherUserId,
        teacherUserId,
        timestamp,
        timestamp,
      );
    const questionId = Number(info.lastInsertRowid);
    const optionStmt = db.prepare(
      'INSERT INTO question_options (question_id, label, text, is_correct, position, created_at) VALUES (?,?,?,?,?,?)',
    );
    (params.options ?? []).forEach((option, index) =>
      optionStmt.run(questionId, option.label, option.text, option.correct ? 1 : 0, index, timestamp),
    );
    return questionId;
  };

  const objectiveQuestions = [1, 2, 3, 4].map((index) =>
    insertQuestion({
      type: 'MCQ',
      text: `Objective question ${index}`,
      marks: 5,
      negativeMarks: 1,
      answerConfig: { correctOptions: ['B'] },
      options: [
        { label: 'A', text: 'First option', correct: false },
        { label: 'B', text: 'Second option', correct: true },
        { label: 'C', text: 'Third option', correct: false },
        { label: 'D', text: 'Fourth option', correct: false },
      ],
    }),
  );

  const fillBlankQuestionId = insertQuestion({
    type: 'FILL_BLANK',
    text: 'The capital of France is ______.',
    marks: 5,
    answerConfig: { acceptedAnswers: ['Paris'], caseSensitive: false },
  });

  const essayQuestionId = insertQuestion({
    type: 'ESSAY',
    text: 'Discuss the role of indexing in query performance.',
    marks: 20,
    answerConfig: { manual: true },
  });

  const examId = Number(
    db
      .prepare(
        `INSERT INTO exams
          (institution_id, subject_id, class_id, created_by, name, code, academic_year, exam_type, duration_minutes,
           start_at, end_at, total_marks, pass_marks, max_attempts, instructions, randomize_questions,
           randomize_options, negative_marking, status, created_at, updated_at)
         VALUES (?,?,?,?, 'Midterm Examination', 'MT-1', '2025/2026', 'MIDTERM', 30, ?, ?, 45, 20, 1,
                 'Answer all questions.', 0, 0, 1, 'SCHEDULED', ?, ?)`,
      )
      .run(
        institutionId,
        subjectId,
        classId,
        teacherUserId,
        addDays(nowIso(), -1),
        addDays(nowIso(), 3),
        timestamp,
        timestamp,
      ).lastInsertRowid,
  );

  const insertExamQuestion = db.prepare(
    'INSERT INTO exam_questions (exam_id, question_id, position, marks, negative_marks) VALUES (?,?,?,?,?)',
  );
  [...objectiveQuestions, fillBlankQuestionId, essayQuestionId].forEach((questionId, index) =>
    insertExamQuestion.run(examId, questionId, index + 1, index === 5 ? 20 : 5, index < 4 ? 1 : 0),
  );

  db.prepare('INSERT INTO exam_assignments (exam_id, class_id, assigned_by, assigned_at) VALUES (?,?,?,?)').run(
    examId,
    classId,
    adminUserId,
    timestamp,
  );

  return {
    institutionId,
    otherInstitutionId,
    adminUserId,
    platformUserId,
    teacherUserId,
    teacherId,
    studentUserId,
    studentId,
    otherStudentUserId,
    otherStudentId,
    foreignStudentUserId,
    foreignStudentId,
    classId,
    subjectId,
    bankId,
    objectiveQuestions,
    essayQuestionId,
    fillBlankQuestionId,
    examId,
    groupId,
  };
}
