/**
 * Development seed data.
 *
 * Everything created here belongs to institutions flagged `is_demo = 1` and every
 * demo account carries the `demo.` email prefix so demonstration data can never be
 * confused with real records.
 *
 * Usage:  npm run seed --workspace server            (idempotent, skips if seeded)
 *         npm run reset --workspace server           (drops the database file and reseeds)
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './index';
import { closeDb, getDb } from './index';
import { hashPassword } from '../lib/crypto';
import { bootstrapPlatform, syncRolesAndPermissions } from './bootstrap';
import { nowIso, addDays, addHours } from '../lib/time';
import { isObjectiveType, parseAnswerConfig, round2, type AnswerKey } from '../lib/answer-key';
import { finaliseAttempt } from '../services/attempts';
import { finalizeGrading, saveGrade, type GradingActor } from '../services/grading';

const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Password1';
const RESET = process.argv.includes('--reset');

function daysFromNow(days: number, hours = 0): string {
  return addHours(addDays(nowIso(), days), hours);
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20240917);
const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];
const randomInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;

interface SeedResult {
  institutionId: number;
  counts: Record<string, number>;
  credentials: { role: string; email: string; password: string }[];
}

export async function seedDatabase(db: Db): Promise<SeedResult> {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM institutions WHERE is_demo = 1").get() as { c: number };
  if (existing.c > 0) {
    const institutionId = (
      db.prepare('SELECT id FROM institutions WHERE is_demo = 1 ORDER BY id LIMIT 1').get() as { id: number }
    ).id;
    return {
      institutionId,
      counts: { note: 0 },
      credentials: [],
    };
  }

  await bootstrapPlatform(db);
  const timestamp = nowIso();
  const counts: Record<string, number> = {};

  // ---------------------------------------------------------------- institution
  const institutionInfo = db
    .prepare(
      `INSERT INTO institutions (name, code, type, email, phone, address, city, country, timezone, status, is_demo, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'active', 1, ?, ?)`,
    )
    .run(
      'Northgate Institute of Technology',
      'NIT',
      'university',
      'registry@northgate.edu',
      '+1 202 555 0148',
      '14 Northgate Avenue',
      'Springfield',
      'United States',
      'UTC',
      timestamp,
      timestamp,
    );
  const institutionId = Number(institutionInfo.lastInsertRowid);

  // ------------------------------------------------------------- grading scheme
  const schemeId = createGradingScheme(db, institutionId);

  // ---------------------------------------------------------------- departments
  const departments = [
    { name: 'Computer Science', code: 'CS', description: 'Software engineering, data and networks.' },
    { name: 'Mathematics', code: 'MTH', description: 'Pure and applied mathematics.' },
    { name: 'Business Studies', code: 'BUS', description: 'Accounting, management and economics.' },
  ].map((department) => {
    const info = db
      .prepare(
        `INSERT INTO departments (institution_id, name, code, description, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(institutionId, department.name, department.code, department.description, timestamp, timestamp);
    return { id: Number(info.lastInsertRowid), ...department };
  });
  counts.departments = departments.length;

  // --------------------------------------------------------------------- users
  const roleId = (code: string) =>
    (db.prepare('SELECT id FROM roles WHERE code = ?').get(code) as { id: number }).id;
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const institutionAdminInfo = db
    .prepare(
      `INSERT INTO users (institution_id, role_id, full_name, email, password_hash, status, phone, email_verified_at, created_at, updated_at)
       VALUES (?,?,?,?,?, 'active', ?, ?, ?, ?)`,
    )
    .run(
      institutionId,
      roleId('institution_admin'),
      'Dr. Amelia Hart',
      'demo.admin@northgate.edu',
      passwordHash,
      '+1 202 555 0100',
      timestamp,
      timestamp,
      timestamp,
    );
  const institutionAdminId = Number(institutionAdminInfo.lastInsertRowid);

  const teacherSeed = [
    { name: 'Prof. Daniel Osei', email: 'demo.teacher1@northgate.edu', department: 0, designation: 'Senior Lecturer', specialization: 'Algorithms & Data Structures' },
    { name: 'Dr. Priya Raman', email: 'demo.teacher2@northgate.edu', department: 0, designation: 'Lecturer', specialization: 'Databases and Web Systems' },
    { name: 'Mr. Samuel Whitfield', email: 'demo.teacher3@northgate.edu', department: 1, designation: 'Lecturer', specialization: 'Applied Mathematics' },
    { name: 'Ms. Helena Okafor', email: 'demo.teacher4@northgate.edu', department: 2, designation: 'Senior Lecturer', specialization: 'Financial Accounting' },
    { name: 'Mr. Tobias Lindqvist', email: 'demo.teacher5@northgate.edu', department: 1, designation: 'Assistant Lecturer', specialization: 'Statistics' },
  ];

  const teachers = teacherSeed.map((teacher, index) => {
    const userInfo = db
      .prepare(
        `INSERT INTO users (institution_id, role_id, full_name, email, password_hash, status, email_verified_at, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        institutionId,
        roleId('teacher'),
        teacher.name,
        teacher.email,
        passwordHash,
        timestamp,
        institutionAdminId,
        timestamp,
        timestamp,
      );
    const userId = Number(userInfo.lastInsertRowid);
    const info = db
      .prepare(
        `INSERT INTO teachers (user_id, institution_id, department_id, staff_code, designation, specialization, joined_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'active', ?, ?)`,
      )
      .run(
        userId,
        institutionId,
        departments[teacher.department].id,
        `TCH-${String(index + 1).padStart(4, '0')}`,
        teacher.designation,
        teacher.specialization,
        '2021-09-01',
        timestamp,
        timestamp,
      );
    return { id: Number(info.lastInsertRowid), userId, ...teacher };
  });
  counts.teachers = teachers.length;

  // ------------------------------------------------------------------ subjects
  const subjectSeed = [
    { name: 'Data Structures & Algorithms', code: 'CS201', department: 0, credits: 4 },
    { name: 'Database Systems', code: 'CS305', department: 0, credits: 3 },
    { name: 'Applied Mathematics', code: 'MTH101', department: 1, credits: 4 },
    { name: 'Financial Accounting', code: 'BUS210', department: 2, credits: 3 },
    { name: 'Probability & Statistics', code: 'MTH210', department: 1, credits: 3 },
  ];
  const subjects = subjectSeed.map((subject) => {
    const info = db
      .prepare(
        `INSERT INTO subjects (institution_id, department_id, name, code, description, credit_hours, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        institutionId,
        departments[subject.department].id,
        subject.name,
        subject.code,
        `Core syllabus for ${subject.name}.`,
        subject.credits,
        timestamp,
        timestamp,
      );
    return { id: Number(info.lastInsertRowid), ...subject };
  });
  counts.subjects = subjects.length;

  const subjectTeacherMap: Record<number, number> = {
    0: 0,
    1: 1,
    2: 2,
    3: 3,
    4: 4,
  };
  for (const [subjectIndex, teacherIndex] of Object.entries(subjectTeacherMap)) {
    db.prepare('INSERT INTO teacher_subjects (teacher_id, subject_id, assigned_at) VALUES (?,?,?)').run(
      teachers[teacherIndex].id,
      subjects[Number(subjectIndex)].id,
      timestamp,
    );
  }

  // ------------------------------------------------------------------- classes
  const classSeed = [
    { name: 'BSc Computer Science — Year 2', code: 'CS-Y2A', department: 0, level: 'Year 2', teacher: 0 },
    { name: 'BSc Computer Science — Year 3', code: 'CS-Y3A', department: 0, level: 'Year 3', teacher: 1 },
    { name: 'BSc Applied Mathematics — Year 1', code: 'MTH-Y1A', department: 1, level: 'Year 1', teacher: 2 },
  ];
  const academicYear = '2025/2026';
  const classes = classSeed.map((klass) => {
    const info = db
      .prepare(
        `INSERT INTO classes (institution_id, department_id, name, code, level, academic_year, class_teacher_id, capacity, room, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        institutionId,
        departments[klass.department].id,
        klass.name,
        klass.code,
        klass.level,
        academicYear,
        teachers[klass.teacher].userId,
        60,
        `Room ${randomInt(100, 320)}`,
        timestamp,
        timestamp,
      );
    return { id: Number(info.lastInsertRowid), ...klass };
  });
  counts.classes = classes.length;

  for (const klass of classes) {
    const subjectList =
      klass.department === 0
        ? [subjects[0], subjects[1], subjects[4]]
        : klass.department === 1
          ? [subjects[2], subjects[4]]
          : [subjects[3]];
    for (const subject of subjectList) {
      db.prepare(
        'INSERT OR IGNORE INTO class_subjects (class_id, subject_id, teacher_id, assigned_at) VALUES (?,?,?,?)',
      ).run(klass.id, subject.id, teachers[subjectTeacherMap[subject.id === subjects[0].id ? 0 : subject.id === subjects[1].id ? 1 : subject.id === subjects[2].id ? 2 : subject.id === subjects[3].id ? 3 : 4]].id, timestamp);
    }
  }

  // ------------------------------------------------------------------ students
  const firstNames = [
    'Aaron', 'Bianca', 'Chidi', 'Daniela', 'Emeka', 'Farida', 'Grace', 'Hassan', 'Imani', 'Jasper',
    'Kavya', 'Liam', 'Maya', 'Noor', 'Oscar', 'Priya', 'Quinn', 'Rania', 'Sofia', 'Tomas',
    'Uche', 'Valeria', 'Wesley', 'Ximena', 'Yusuf', 'Zara', 'Aisha', 'Benedict', 'Cleo', 'Dmitri',
  ];
  const lastNames = [
    'Adeyemi', 'Boateng', 'Chen', 'Duarte', 'Eriksen', 'Ferreira', 'Gupta', 'Hoffmann', 'Ibrahim', 'Jimenez',
    'Kowalski', 'Lindgren', 'Mensah', 'Nakamura', 'Oliveira', 'Petrov', 'Ramirez', 'Silva', 'Tanaka', 'Ueda',
  ];

  const students: { id: number; userId: number; name: string; classId: number }[] = [];
  for (let index = 0; index < 30; index += 1) {
    const fullName = `${firstNames[index]} ${pick(lastNames)}`;
    const email = `demo.student${String(index + 1).padStart(3, '0')}@northgate.edu`;
    const klass = classes[index % classes.length];
    const userInfo = db
      .prepare(
        `INSERT INTO users (institution_id, role_id, full_name, email, password_hash, status, phone, email_verified_at, created_by, created_at, updated_at, last_login_at)
         VALUES (?,?,?,?,?, 'active', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        institutionId,
        roleId('student'),
        fullName,
        email,
        passwordHash,
        `+1 202 555 ${String(1000 + index).slice(-4)}`,
        timestamp,
        institutionAdminId,
        timestamp,
        timestamp,
        index % 3 === 0 ? daysFromNow(-1) : null,
      );
    const userId = Number(userInfo.lastInsertRowid);
    const studentInfo = db
      .prepare(
        `INSERT INTO students (user_id, institution_id, class_id, student_code, date_of_birth, gender, guardian_name, guardian_phone, admission_date, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'active', ?, ?)`,
      )
      .run(
        userId,
        institutionId,
        klass.id,
        `NIT-2025-${String(index + 1).padStart(4, '0')}`,
        `200${randomInt(2, 6)}-0${randomInt(1, 9)}-1${randomInt(0, 9)}`,
        pick(['female', 'male', 'undisclosed']),
        `${pick(firstNames)} ${pick(lastNames)}`,
        `+1 202 555 ${String(2000 + index).slice(-4)}`,
        '2025-09-01',
        timestamp,
        timestamp,
      );
    students.push({ id: Number(studentInfo.lastInsertRowid), userId, name: fullName, classId: klass.id });
  }
  counts.students = students.length;

  // ------------------------------------------------------------------- groups
  const studyGroupInfo = db
    .prepare(
      'INSERT INTO groups (institution_id, class_id, name, description, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      institutionId,
      classes[0].id,
      'Algorithms Clinic (Springfield cohort)',
      'Candidates receiving additional tutorial support.',
      teachers[0].userId,
      timestamp,
      timestamp,
    );
  const studyGroupId = Number(studyGroupInfo.lastInsertRowid);
  const groupMembers = students.filter((s) => s.classId === classes[0].id).slice(0, 5);
  for (const member of groupMembers) {
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, student_id, added_at) VALUES (?,?,?)').run(
      studyGroupId,
      member.id,
      timestamp,
    );
  }

  // --------------------------------------------------------- question banks
  const bankSeed = [
    { subjectIndex: 0, name: 'Data Structures & Algorithms — Core Bank', teacherIndex: 0 },
    { subjectIndex: 1, name: 'Database Systems — Core Bank', teacherIndex: 1 },
    { subjectIndex: 2, name: 'Applied Mathematics — Core Bank', teacherIndex: 2 },
    { subjectIndex: 3, name: 'Financial Accounting — Core Bank', teacherIndex: 3 },
    { subjectIndex: 4, name: 'Probability & Statistics — Core Bank', teacherIndex: 4 },
  ];
  const banks = bankSeed.map((bank) => {
    const info = db
      .prepare(
        `INSERT INTO question_banks (institution_id, subject_id, name, description, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        institutionId,
        subjects[bank.subjectIndex].id,
        bank.name,
        `Authored question bank for ${subjects[bank.subjectIndex].name}.`,
        teachers[bank.teacherIndex].userId,
        timestamp,
        timestamp,
      );
    return { id: Number(info.lastInsertRowid), ...bank };
  });

  // ------------------------------------------------------------------ questions
  const questionBlueprints = buildQuestionBlueprints();
  const createdQuestions: { id: number; subjectIndex: number; type: string }[] = [];

  const insertQuestion = db.prepare(
    `INSERT INTO questions
      (institution_id, question_bank_id, subject_id, topic, type, text, explanation, marks, negative_marks,
       difficulty, status, tags, answer_config, created_by, updated_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'ACTIVE', ?, ?, ?, ?, ?, ?)`,
  );
  const insertOption = db.prepare(
    'INSERT INTO question_options (question_id, label, text, is_correct, position, created_at) VALUES (?,?,?,?,?,?)',
  );

  for (let index = 0; index < 100; index += 1) {
    const subjectIndex = index % 5;
    const blueprint = questionBlueprints[index % questionBlueprints.length];
    const bank = banks[subjectIndex];
    const topic = blueprint.topic;
    const text = blueprint.text.replace('{subject}', subjects[subjectIndex].name);
    const options = blueprint.options.map((option, optionIndex) => ({
      label: String.fromCharCode(65 + optionIndex),
      text: option.text,
      isCorrect: option.correct,
    }));
    const shuffled = options
      .map((option) => ({ option, sort: rand() }))
      .sort((a, b) => a.sort - b.sort)
      .map((entry) => entry.option);
    const answerConfig =
      blueprint.type === 'FILL_BLANK'
        ? {
            acceptedAnswers: blueprint.acceptedAnswers ?? ['answer'],
            caseSensitive: false,
            numericTolerance: 0,
          }
        : { correctOptions: shuffled.filter((o) => o.isCorrect).map((o) => o.label) };

    const info = insertQuestion.run(
      institutionId,
      bank.id,
      subjects[subjectIndex].id,
      topic,
      blueprint.type,
      text,
      blueprint.explanation,
      blueprint.marks,
      blueprint.negativeMarks ?? 0,
      index % 5 === 0 ? 'EASY' : index % 3 === 0 ? 'HARD' : 'MEDIUM',
      JSON.stringify(blueprint.tags),
      JSON.stringify(answerConfig),
      teachers[bank.teacherIndex].userId,
      teachers[bank.teacherIndex].userId,
      timestamp,
      timestamp,
    );
    const questionId = Number(info.lastInsertRowid);
    if (blueprint.type === 'MCQ') {
      shuffled.forEach((option, position) =>
        insertOption.run(questionId, option.label, option.text, option.isCorrect ? 1 : 0, position, timestamp),
      );
    }
    if (blueprint.type === 'TRUE_FALSE') {
      insertOption.run(questionId, 'A', 'True', shuffled[0].isCorrect ? 1 : 0, 0, timestamp);
      insertOption.run(questionId, 'B', 'False', shuffled[1].isCorrect ? 1 : 0, 1, timestamp);
    }
    createdQuestions.push({ id: questionId, subjectIndex, type: blueprint.type });
  }
  /*
   * Written questions are created outside the objective cycle above, because a paper either
   * carries written work or it does not. Two rules follow from how the application works:
   *
   *  - An attempt only rests in UNDER_REVIEW while written answers still need marking; a
   *    fully objective paper is graded the moment it is submitted, so seeding "awaiting
   *    marking" attempts against one would describe a state the API cannot reach.
   *  - Papers whose results are already published stay fully objective here, so every
   *    released mark is backed by answers an examiner actually marked.
   */
  const writtenBlueprints = buildWrittenBlueprints();
  const writtenQuestions: { id: number; subjectIndex: number; type: string; marks: number }[] = [];
  for (let subjectIndex = 0; subjectIndex < subjects.length; subjectIndex += 1) {
    const bank = banks[subjectIndex];
    for (const blueprint of writtenBlueprints) {
      const info = insertQuestion.run(
        institutionId,
        bank.id,
        subjects[subjectIndex].id,
        blueprint.topic,
        blueprint.type,
        blueprint.text.replace('{subject}', subjects[subjectIndex].name),
        blueprint.explanation,
        blueprint.marks,
        0,
        blueprint.difficulty,
        JSON.stringify(blueprint.tags),
        // The same answer key the application writes for a written question.
        JSON.stringify({ manual: true }),
        teachers[bank.teacherIndex].userId,
        teachers[bank.teacherIndex].userId,
        timestamp,
        timestamp,
      );
      writtenQuestions.push({
        id: Number(info.lastInsertRowid),
        subjectIndex,
        type: blueprint.type,
        marks: blueprint.marks,
      });
    }
  }
  counts.questions = createdQuestions.length + writtenQuestions.length;

  // Questions as a paper reads them — a paper may override the bank's marks and penalties.
  const questionRows = new Map(
    (
      db
        .prepare(
          'SELECT id, type, text, marks, negative_marks FROM questions WHERE institution_id = ? ORDER BY id',
        )
        .all(institutionId) as {
        id: number;
        type: string;
        text: string;
        marks: number;
        negative_marks: number;
      }[]
    ).map((row) => [row.id, row]),
  );

  // -------------------------------------------------------------------- quizzes
  const quizSeed = [
    { subjectIndex: 0, teacherIndex: 0, classIndex: 0, title: 'Algorithms Warm-up Quiz', count: 5, minutes: 15, offset: -6, written: 0, markedWritten: 0, immediate: true, sitters: 6 },
    { subjectIndex: 1, teacherIndex: 1, classIndex: 1, title: 'SQL Fundamentals Check', count: 5, minutes: 20, offset: -3, written: 1, markedWritten: 1, immediate: false, sitters: 8 },
    { subjectIndex: 2, teacherIndex: 2, classIndex: 2, title: 'Calculus Refresher Quiz', count: 5, minutes: 15, offset: 2, written: 0, markedWritten: 0, immediate: false, sitters: 0 },
    { subjectIndex: 3, teacherIndex: 3, classIndex: 0, title: 'Accounting Principles Quiz', count: 5, minutes: 20, offset: 5, written: 0, markedWritten: 0, immediate: false, sitters: 0 },
    { subjectIndex: 4, teacherIndex: 4, classIndex: 1, title: 'Probability Basics Quiz', count: 5, minutes: 15, offset: 8, written: 0, markedWritten: 0, immediate: false, sitters: 0 },
  ];

  const quizzes = quizSeed.map((quiz, index) => {
    const subjectQuestions = createdQuestions.filter((q) => q.subjectIndex === quiz.subjectIndex);
    const selected = subjectQuestions.slice(0, quiz.count);
    // A quiz that needs marking carries written questions from its own subject.
    const written = writtenQuestions
      .filter((question) => question.subjectIndex === quiz.subjectIndex)
      .slice(0, quiz.written)
      .map((question, position) => ({
        questionId: question.id,
        marks: question.marks,
        marked: position < quiz.markedWritten,
      }));
    const availableFrom = daysFromNow(quiz.offset - 4);
    const availableUntil = daysFromNow(quiz.offset + 14);
    // Availability drives the lifecycle state, exactly as the scheduler would derive it.
    const nowMs = Date.now();
    const status =
      nowMs < new Date(availableFrom).getTime()
        ? 'SCHEDULED'
        : nowMs > new Date(availableUntil).getTime()
          ? 'CLOSED'
          : 'ACTIVE';
    const questionCount = selected.length + written.length;
    const totalMarks = round2(
      selected.reduce((sum, question) => sum + (questionRows.get(question.id)?.marks ?? 0), 0) +
        written.reduce((sum, question) => sum + question.marks, 0),
    );

    const info = db
      .prepare(
        `INSERT INTO quizzes
          (institution_id, subject_id, class_id, created_by, title, description, instructions, question_count,
           time_limit_minutes, max_attempts, pass_percentage, randomize_questions, randomize_options,
           immediate_results, show_correct_answers, allow_review, negative_marking, available_from,
           available_until, result_release_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        institutionId,
        subjects[quiz.subjectIndex].id,
        classes[quiz.classIndex].id,
        teachers[quiz.teacherIndex].userId,
        quiz.title,
        `Short formative assessment for ${subjects[quiz.subjectIndex].name}.`,
        'Answer all questions. You may flag questions for review before submitting.',
        questionCount,
        quiz.minutes,
        2,
        50,
        index % 2 === 0 ? 1 : 0,
        index % 3 === 0 ? 1 : 0,
        quiz.immediate ? 1 : 0,
        1,
        1,
        1,
        availableFrom,
        availableUntil,
        // A paper released on submit needs no separate release date; the rest are released
        // once their marking window has passed.
        quiz.immediate ? null : index < 2 ? daysFromNow(-2) : daysFromNow(quiz.offset + 15),
        status,
        timestamp,
        timestamp,
      );
    const quizId = Number(info.lastInsertRowid);
    const insertPaperQuestion = db.prepare(
      'INSERT INTO quiz_questions (quiz_id, question_id, position, marks, negative_marks) VALUES (?,?,?,?,?)',
    );
    selected.forEach((question, position) => {
      const row = questionRows.get(question.id);
      insertPaperQuestion.run(quizId, question.id, position + 1, row?.marks ?? 1, row?.negative_marks ?? 0);
    });
    written.forEach((question, position) => {
      insertPaperQuestion.run(quizId, question.questionId, selected.length + position + 1, question.marks, 0);
    });
    db.prepare(
      'INSERT INTO quiz_assignments (quiz_id, class_id, assigned_by, assigned_at) VALUES (?,?,?,?)',
    ).run(quizId, classes[quiz.classIndex].id, teachers[quiz.teacherIndex].userId, timestamp);
    return {
      id: quizId,
      ...quiz,
      questionIds: selected.map((q) => q.id),
      written,
      totalMarks,
      status,
      classId: classes[quiz.classIndex].id,
      timeLimitMinutes: quiz.minutes,
      passPercentage: 50,
    };
  });
  counts.quizzes = quizzes.length;

  // --------------------------------------------------------------- examinations
  const examSeed = [
    {
      subjectIndex: 0,
      teacherIndex: 0,
      classIndex: 0,
      name: 'Midterm Examination — Data Structures & Algorithms',
      code: 'CS201-MID-2025',
      type: 'MIDTERM',
      start: -2,
      status: 'ACTIVE',
      questions: 12,
      duration: 60,
      passPercent: 50,
      // Two written questions, neither marked yet: this is the paper the marking queue is for.
      written: 2,
      markedWritten: 0,
      sitters: 6,
    },
    {
      subjectIndex: 1,
      teacherIndex: 1,
      classIndex: 1,
      name: 'Final Examination — Database Systems',
      code: 'CS305-FIN-2025',
      type: 'FINAL',
      start: 6,
      status: 'SCHEDULED',
      questions: 10,
      duration: 90,
      passPercent: 50,
      // Not open yet, so it carries no submissions — a paper cannot be sat before it starts.
      written: 0,
      markedWritten: 0,
      sitters: 0,
    },
    {
      subjectIndex: 4,
      teacherIndex: 4,
      classIndex: 2,
      name: 'Statistics Continuous Assessment',
      code: 'MTH210-CA-2025',
      type: 'ASSIGNMENT',
      start: -12,
      status: 'PUBLISHED',
      questions: 8,
      duration: 45,
      passPercent: 45,
      // Results are out, so every question on this paper is objective and machine-scored.
      written: 0,
      markedWritten: 0,
      sitters: 10,
    },
  ];

  const exams = examSeed.map((exam) => {
    const subjectQuestions = createdQuestions.filter((q) => q.subjectIndex === exam.subjectIndex);
    const objective = subjectQuestions.slice(0, exam.questions);
    const written = writtenQuestions
      .filter((question) => question.subjectIndex === exam.subjectIndex)
      .slice(0, exam.written)
      .map((question, position) => ({
        questionId: question.id,
        marks: question.marks,
        marked: position < exam.markedWritten,
      }));
    const totalMarks = round2(
      objective.reduce((sum, question) => sum + (questionRows.get(question.id)?.marks ?? 0), 0) +
        written.reduce((sum, question) => sum + question.marks, 0),
    );
    const passMarks = round2((totalMarks * exam.passPercent) / 100);

    const info = db
      .prepare(
        `INSERT INTO exams
          (institution_id, subject_id, class_id, created_by, name, code, academic_year, semester, exam_type,
           duration_minutes, start_at, end_at, total_marks, pass_marks, max_attempts, instructions,
           randomize_questions, randomize_options, negative_marking, grading_scheme_id, result_release_at,
           status, published_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        institutionId,
        subjects[exam.subjectIndex].id,
        classes[exam.classIndex].id,
        teachers[exam.teacherIndex].userId,
        exam.name,
        exam.code,
        academicYear,
        'Semester 1',
        exam.type,
        exam.duration,
        daysFromNow(exam.start, -1),
        daysFromNow(exam.start + 9),
        totalMarks,
        passMarks,
        1,
        [
          'Read every question carefully before answering.',
          'The timer is controlled by the examination server and cannot be paused.',
          'Answers are saved automatically; you may revisit questions at any time before submitting.',
          'Submitting ends the attempt permanently.',
        ].join('\n'),
        exam.subjectIndex % 2 === 0 ? 1 : 0,
        exam.subjectIndex % 3 === 0 ? 1 : 0,
        1,
        schemeId,
        // A published paper releases what it has; the others stay withheld until marking ends.
        exam.status === 'PUBLISHED' ? daysFromNow(exam.start + 4) : daysFromNow(exam.start + 10),
        exam.status,
        exam.status === 'PUBLISHED' ? daysFromNow(exam.start + 4) : null,
        timestamp,
        timestamp,
      );
    const examId = Number(info.lastInsertRowid);
    const insertPaperQuestion = db.prepare(
      'INSERT INTO exam_questions (exam_id, question_id, position, marks, negative_marks) VALUES (?,?,?,?,?)',
    );
    objective.forEach((question, position) => {
      const row = questionRows.get(question.id);
      insertPaperQuestion.run(examId, question.id, position + 1, row?.marks ?? 1, row?.negative_marks ?? 0);
    });
    written.forEach((question, position) => {
      insertPaperQuestion.run(examId, question.questionId, objective.length + position + 1, question.marks, 0);
    });
    db.prepare('INSERT INTO exam_assignments (exam_id, class_id, assigned_by, assigned_at) VALUES (?,?,?,?)').run(
      examId,
      classes[exam.classIndex].id,
      teachers[exam.teacherIndex].userId,
      timestamp,
    );
    return {
      id: examId,
      ...exam,
      totalMarks,
      passMarks,
      questionIds: objective.map((q) => q.id),
      written,
      assignedClassId: classes[exam.classIndex].id,
    };
  });
  counts.exams = exams.length;

  /*
   * Sample submissions.
   *
   * Only papers that are genuinely open are sat: a SCHEDULED examination has not started, so
   * seeding submissions against it would contradict the application's own "no early start"
   * rule. Each attempt is graded through the production path and therefore always carries the
   * result row that `submit` writes.
   */
  const graders = teachers.map((teacher) => ({ id: teacher.userId, name: teacher.name }));
  const papers: SeedPaper[] = [
    ...exams
      .filter((exam) => exam.status === 'ACTIVE' || exam.status === 'PUBLISHED')
      .map((exam) => ({
        kind: 'exam' as const,
        id: exam.id,
        questionIds: [...exam.questionIds, ...exam.written.map((question) => question.questionId)],
        written: exam.written,
        totalMarks: exam.totalMarks,
        durationMinutes: exam.duration,
        classId: exam.assignedClassId,
        participants: exam.sitters,
        startedDaysAgo: exam.status === 'PUBLISHED' ? 11 : 1,
        spreadDays: 2,
        grader: graders[exam.teacherIndex],
      })),
    ...quizzes
      .filter((quiz) => quiz.status === 'ACTIVE')
      .map((quiz) => ({
        kind: 'quiz' as const,
        id: quiz.id,
        questionIds: [...quiz.questionIds, ...quiz.written.map((question) => question.questionId)],
        written: quiz.written,
        totalMarks: quiz.totalMarks,
        durationMinutes: quiz.timeLimitMinutes,
        classId: quiz.classId,
        participants: quiz.sitters,
        startedDaysAgo: Math.abs(quiz.offset),
        spreadDays: 3,
        grader: graders[quiz.teacherIndex],
      })),
  ];

  const seeded = createSampleAttempts(db, papers, students, institutionId);
  counts.attempts = seeded.attempts;
  counts.results = seeded.results;
  counts.awaiting_marking = seeded.pending;

  // --------------------------------------------------------------- notifications
  const notificationSeeds = [
    { type: 'exam_assigned', title: 'New examination assigned', body: 'Midterm Examination — Data Structures & Algorithms is now open.', link: '/examinations' },
    { type: 'result_published', title: 'Result published', body: 'Your Statistics Continuous Assessment result is available.', link: '/results' },
  ];
  for (const student of students.slice(0, 12)) {
    for (const notification of notificationSeeds) {
      db.prepare(
        `INSERT INTO notifications (institution_id, user_id, type, title, body, link, severity, created_at)
         VALUES (?,?,?,?,?,?, 'info', ?)`,
      ).run(
        institutionId,
        student.userId,
        notification.type,
        notification.title,
        notification.body,
        notification.link,
        daysFromNow(-1),
      );
    }
  }

  db.prepare(
    `INSERT INTO audit_logs (institution_id, user_id, actor_name, actor_role, action, category, resource_type, description, metadata, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    institutionId,
    institutionAdminId,
    'Dr. Amelia Hart',
    'institution_admin',
    'institution.created',
    'institution',
    'institution',
    'Seeded demonstration institution with sample academic data',
    JSON.stringify({ seeded: true, demo: true }),
    timestamp,
  );

  return {
    institutionId,
    counts,
    credentials: [
      { role: 'Institution Administrator', email: 'demo.admin@northgate.edu', password: DEMO_PASSWORD },
      ...teacherSeed.map((teacher, index) => ({
        role: `Teacher / Examiner (${index + 1})`,
        email: teacher.email,
        password: DEMO_PASSWORD,
      })),
      { role: 'Student / Candidate (1–30)', email: 'demo.student001@northgate.edu … demo.student030@northgate.edu', password: DEMO_PASSWORD },
    ],
  };
}

function createGradingScheme(db: Db, institutionId: number): number {
  const info = db
    .prepare(
      `INSERT INTO grading_schemes (institution_id, name, description, is_default, pass_percentage, created_at, updated_at)
       VALUES (?,?,?, 1, 50, ?, ?)`,
    )
    .run(
      institutionId,
      'Northgate standard scale',
      'Institutional grading scale: A+ 90–100, A 80–89, B 70–79, C 60–69, D 50–59, F below 50.',
      nowIso(),
      nowIso(),
    );
  const schemeId = Number(info.lastInsertRowid);
  const bands: [string, number, number, number, string][] = [
    ['A+', 90, 100, 4, 'Outstanding'],
    ['A', 80, 89.99, 4, 'Excellent'],
    ['B', 70, 79.99, 3, 'Very good'],
    ['C', 60, 69.99, 2, 'Good'],
    ['D', 50, 59.99, 1, 'Satisfactory'],
    ['F', 0, 49.99, 0, 'Fail'],
  ];
  const insert = db.prepare(
    'INSERT INTO grading_bands (scheme_id, grade, min_percentage, max_percentage, points, remark, position) VALUES (?,?,?,?,?,?,?)',
  );
  bands.forEach((band, index) => insert.run(schemeId, band[0], band[1], band[2], band[3], band[4], index));
  return schemeId;
}

/**
 * A paper as it was served, with the written work it carries and which of that work has
 * already been marked.
 */
interface SeedPaper {
  kind: 'exam' | 'quiz';
  id: number;
  /** Every question on the paper, in the order it was served. */
  questionIds: number[];
  written: { questionId: number; marks: number; marked: boolean }[];
  totalMarks: number;
  durationMinutes: number;
  classId: number;
  /** How many candidates sat it (never more than the class has). */
  participants: number;
  startedDaysAgo: number;
  /** Submissions are spread over this many days, so the dashboards show a real series. */
  spreadDays: number;
  grader: { id: number; name: string };
}

/** A plausible candidate answer for a written question. */
function writtenAnswerText(type: string, prompt: string, seed: number): string {
  const first = prompt.replace(/\s+/g, ' ').replace(/\.$/, '');
  if (type === 'ESSAY') {
    return [
      `${first} — answered in three parts.`,
      'First the definition and the assumptions it rests on, because the rest of the argument only holds while those do.',
      `Then the worked example, taken step by step, with the intermediate values checked against the expected order of magnitude (working reference ${seed}).`,
      'Finally the limitations: one worked example shows the method is sound, but it does not by itself prove the general case.',
    ].join('\n\n');
  }
  return `${first} — stated briefly, with the defining property and one worked step (working reference ${seed}).`;
}

/**
 * Seeds submissions through the same code path the application uses.
 *
 * Answer sheets are written the way `saveAnswer` writes them, and `finaliseAttempt` then
 * auto-grades the objective answers, totals the marks and writes the result row — so a
 * seeded attempt is indistinguishable from one a candidate submitted, and no seeded
 * submission can be left without the result the dashboard depends on. Papers with written
 * work are marked by an examiner through `saveGrade`/`finalizeGrading`, which also leaves the
 * `grading_history` trail the marking interface shows; anything left unmarked stays in
 * UNDER_REVIEW with a PENDING result, which is exactly how the API parks it.
 */
function createSampleAttempts(
  db: Db,
  papers: SeedPaper[],
  students: { id: number; userId: number; name: string; classId: number }[],
  institutionId: number,
): { attempts: number; results: number; pending: number } {
  let attempts = 0;
  let results = 0;
  let pending = 0;

  for (const paper of papers) {
    if (!paper.participants) continue;
    const cohort = students.filter((student) => student.classId === paper.classId).slice(0, paper.participants);
    const actor: GradingActor = {
      id: paper.grader.id,
      institutionId,
      roleCode: 'teacher',
      fullName: paper.grader.name,
    };

    cohort.forEach((student, index) => {
      const startedAt = daysFromNow(-(paper.startedDaysAgo + (index % paper.spreadDays)), randomInt(1, 6));
      const durationHours = paper.durationMinutes / 60;
      const expiresAt = addHours(startedAt, durationHours);
      const submittedAt = addHours(startedAt, Math.max(0.25, Math.min(durationHours, 0.9)));

      const attemptId = Number(
        db
          .prepare(
            `INSERT INTO attempts
              (institution_id, exam_id, quiz_id, student_id, attempt_no, status, started_at, expires_at,
               last_activity_at, submitted_at, submit_reason, max_marks, created_at, updated_at)
             VALUES (?,?,?,?, 1, 'SUBMITTED', ?,?,?,?, 'manual', ?,?,?)`,
          )
          .run(
            institutionId,
            paper.kind === 'exam' ? paper.id : null,
            paper.kind === 'quiz' ? paper.id : null,
            student.id,
            startedAt,
            expiresAt,
            submittedAt,
            submittedAt,
            paper.totalMarks,
            startedAt,
            submittedAt,
          ).lastInsertRowid,
      );

      // ------------------------------------------------------- the paper, frozen per attempt
      const insertPaper = db.prepare(
        `INSERT INTO attempt_questions
          (attempt_id, question_id, position, question_type, question_text, marks, negative_marks,
           is_objective, correct_answer, snapshot)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      const insertAnswer = db.prepare(
        `INSERT INTO answers
          (attempt_id, question_id, selected_options, answer_text, is_flagged, max_marks, save_count, created_at, updated_at)
         VALUES (?,?,?,?, 0, ?, ?,?,?)`,
      );

      paper.questionIds.forEach((questionId, position) => {
        const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId) as any;
        const options = db
          .prepare('SELECT label, text, is_correct FROM question_options WHERE question_id = ? ORDER BY position')
          .all(questionId) as { label: string; text: string; is_correct: number }[];
        const config = parseAnswerConfig(question.answer_config) as AnswerKey & Record<string, unknown>;
        const correct: AnswerKey = {
          correctOptions: (config.correctOptions ?? []).map((label) => String(label).toUpperCase()),
          acceptedAnswers: config.acceptedAnswers ?? [],
          caseSensitive: Boolean(config.caseSensitive),
          allowPartial: Boolean(config.allowPartial),
          numericTolerance: config.numericTolerance ?? 0,
        };
        insertPaper.run(
          attemptId,
          questionId,
          position + 1,
          question.type,
          question.text,
          question.marks,
          question.negative_marks,
          isObjectiveType(question.type) ? 1 : 0,
          JSON.stringify(correct),
          JSON.stringify({
            options: options.map((option) => ({ label: option.label, text: option.text })),
            answerConfig: config,
            explanation: question.explanation,
            topic: question.topic,
            difficulty: question.difficulty,
          }),
        );

        if (!isObjectiveType(question.type)) return;

        // Not every candidate answers every question; a skipped question simply has no row
        // and scores nothing, exactly as the grader treats it.
        if (rand() > 0.95) return;
        const labels = options.map((option) => option.label);
        const correctLabels = correct.correctOptions ?? [];
        const wrongLabels = labels.filter((label) => !correctLabels.includes(label));
        const gotItRight = rand() < 0.72;
        const selected = correctLabels.length
          ? gotItRight
            ? correctLabels
            : [pick(wrongLabels.length ? wrongLabels : labels)]
          : [];
        insertAnswer.run(
          attemptId,
          questionId,
          JSON.stringify(selected),
          // A fill-in-the-blank answer is text, not a selection.
          question.type === 'FILL_BLANK'
            ? gotItRight
              ? correct.acceptedAnswers?.[0] ?? 'answer'
              : 'not sure'
            : null,
          question.marks,
          randomInt(1, 4),
          startedAt,
          submittedAt,
        );
      });

      // -------------------------- written answers: handed in, and marked only if they should be
      for (const plan of paper.written) {
        const question = db.prepare('SELECT type, text FROM questions WHERE id = ?').get(plan.questionId) as {
          type: string;
          text: string;
        };
        insertAnswer.run(
          attemptId,
          plan.questionId,
          '[]',
          writtenAnswerText(question.type, question.text, attempts + plan.questionId),
          plan.marks,
          1,
          startedAt,
          submittedAt,
        );
      }

      // Auto-grades the objective answers, totals the marks, writes the result row, and
      // either completes the attempt or parks it in review with a PENDING result.
      const submission = finaliseAttempt(db, null, attemptId);

      if (submission.requiresManualGrading) {
        if (!paper.written.every((plan) => plan.marked)) {
          pending += 1; // left in the marking queue
        } else {
          for (const plan of paper.written) {
            const answer = db
              .prepare('SELECT id FROM answers WHERE attempt_id = ? AND question_id = ?')
              .get(attemptId, plan.questionId) as { id: number };
            const awarded = round2(plan.marks * (0.6 + rand() * 0.3));
            saveGrade(db, actor, attemptId, answer.id, {
              awardedMarks: awarded,
              comment:
                awarded >= plan.marks * 0.8
                  ? 'Well argued and correctly applied; keep the working visible for partial credit.'
                  : 'The method is right but the working is thin — state the assumptions next time.',
            });
          }
          finalizeGrading(db, actor, attemptId);
        }
      }

      attempts += 1;
      results += 1;
    });
  }

  return { attempts, results, pending };
}

interface WrittenBlueprint {
  type: 'SHORT_ANSWER' | 'ESSAY';
  topic: string;
  text: string;
  marks: number;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  explanation: string;
  tags: string[];
}

/**
 * Four written blueprints per subject — one short answer and one essay, twice — so the
 * marking queue, the manual-grading history and the written-answer review screens all have
 * genuine, ungraded candidate work to work with.
 */
function buildWrittenBlueprints(): WrittenBlueprint[] {
  return [
    {
      type: 'SHORT_ANSWER',
      topic: 'Complexity and cost',
      text: 'State the average-case cost of the core operation you would use in {subject}, and justify the answer in two or three sentences.',
      marks: 5,
      difficulty: 'MEDIUM',
      explanation: 'Award full marks for the correct growth rate together with a one-line justification of why it holds.',
      tags: ['written', 'analysis'],
    },
    {
      type: 'ESSAY',
      topic: 'Trade-offs and design',
      text: 'Discuss how {subject} balances competing constraints in practice. Support your answer with at least two worked examples and state where your reasoning stops being valid.',
      marks: 15,
      difficulty: 'HARD',
      explanation: 'Award marks for a correct argument, two concrete examples and an explicit statement of the limits of the approach.',
      tags: ['written', 'essay'],
    },
    {
      type: 'SHORT_ANSWER',
      topic: 'Method and verification',
      text: 'Show the two steps you would take to solve a standard problem in {subject}, and say how you would check that the result is right.',
      marks: 5,
      difficulty: 'MEDIUM',
      explanation: 'Award marks for a correct method and for naming a real verification step.',
      tags: ['written', 'method'],
    },
    {
      type: 'ESSAY',
      topic: 'Theory in practice',
      text: 'Explain how a core idea from {subject} is applied outside the classroom, and where that application breaks down.',
      marks: 15,
      difficulty: 'MEDIUM',
      explanation: 'Award marks for correct use of the concept, a concrete case, and a stated limitation.',
      tags: ['written', 'application'],
    },
  ];
}

interface Blueprint {
  type: 'MCQ' | 'TRUE_FALSE' | 'FILL_BLANK';
  topic: string;
  text: string;
  options: { text: string; correct: boolean }[];
  marks: number;
  negativeMarks?: number;
  explanation: string;
  tags: string[];
  acceptedAnswers?: string[];
}

/** 20 reusable blueprints → 100 questions across five subjects. */
function buildQuestionBlueprints(): Blueprint[] {
  return [
    {
      type: 'MCQ',
      topic: 'Complexity analysis',
      text: 'In {subject}, which notation describes the tightest upper bound on an algorithm\'s running time?',
      options: [
        { text: 'Big-O notation', correct: true },
        { text: 'Big-Omega notation', correct: false },
        { text: 'Big-Theta notation', correct: false },
        { text: 'Little-o notation', correct: false },
      ],
      marks: 3,
      negativeMarks: 1,
      explanation: 'Big-O bounds an algorithm from above; Big-Theta describes a tight bound and Big-Omega a lower bound.',
      tags: ['complexity', 'theory'],
    },
    {
      type: 'MCQ',
      topic: 'Data structures',
      text: 'Which data structure provides last-in-first-out access?',
      options: [
        { text: 'Stack', correct: true },
        { text: 'Queue', correct: false },
        { text: 'Linked list', correct: false },
        { text: 'Binary heap', correct: false },
      ],
      marks: 2,
      negativeMarks: 0.5,
      explanation: 'A stack pushes and pops from the same end, so the most recent item leaves first.',
      tags: ['data-structures'],
    },
    {
      type: 'TRUE_FALSE',
      topic: 'Data structures',
      text: 'A balanced binary search tree offers O(log n) average-case search.',
      options: [
        { text: 'True', correct: true },
        { text: 'False', correct: false },
      ],
      marks: 2,
      explanation: 'Balancing keeps the height logarithmic, which bounds the search path.',
      tags: ['trees'],
    },
    {
      type: 'FILL_BLANK',
      topic: 'Normalisation',
      text: 'In relational design, a table is in ______ normal form when every non-key attribute depends on the whole primary key.',
      options: [],
      marks: 3,
      explanation: 'Second normal form removes partial dependencies on a composite primary key.',
      tags: ['database', 'normalisation'],
      acceptedAnswers: ['second', '2', '2NF', 'second normal form'],
    },
    {
      type: 'MCQ',
      topic: 'SQL',
      text: 'Which SQL clause filters rows after aggregation has been applied?',
      options: [
        { text: 'HAVING', correct: true },
        { text: 'WHERE', correct: false },
        { text: 'ORDER BY', correct: false },
        { text: 'GROUP BY', correct: false },
      ],
      marks: 3,
      negativeMarks: 1,
      explanation: 'WHERE filters rows before grouping; HAVING filters aggregated groups.',
      tags: ['sql'],
    },
    {
      type: 'MCQ',
      topic: 'Transactions',
      text: 'Which property guarantees that a committed transaction survives a system failure?',
      options: [
        { text: 'Durability', correct: true },
        { text: 'Atomicity', correct: false },
        { text: 'Isolation', correct: false },
        { text: 'Consistency', correct: false },
      ],
      marks: 3,
      negativeMarks: 1,
      explanation: 'Durability is the "D" in ACID and is provided by write-ahead logging.',
      tags: ['acid', 'transactions'],
    },
    {
      type: 'MCQ',
      topic: 'Differentiation',
      text: 'What is the derivative of ln(x) with respect to x, for x > 0?',
      options: [
        { text: '1/x', correct: true },
        { text: 'x', correct: false },
        { text: 'ln(x)/x', correct: false },
        { text: 'e^x', correct: false },
      ],
      marks: 2,
      negativeMarks: 0.5,
      explanation: 'The natural logarithm and the reciprocal are derivative pairs.',
      tags: ['calculus'],
    },
    {
      type: 'FILL_BLANK',
      topic: 'Sequences',
      text: 'The sum of the first n positive integers is given by n(n+1)/______ .',
      options: [],
      marks: 2,
      explanation: 'The closed form of the arithmetic series 1+2+…+n is n(n+1)/2.',
      tags: ['series'],
      acceptedAnswers: ['2'],
    },
    {
      type: 'MCQ',
      topic: 'Financial statements',
      text: 'Under the accrual basis of accounting, revenue is recognised when:',
      options: [
        { text: 'The performance obligation is satisfied', correct: true },
        { text: 'Cash is received', correct: false },
        { text: 'The invoice is printed', correct: false },
        { text: 'The budget is approved', correct: false },
      ],
      marks: 3,
      negativeMarks: 1,
      explanation: 'Accrual accounting recognises revenue when control of the goods or services transfers.',
      tags: ['accrual', 'revenue'],
    },
    {
      type: 'MCQ',
      topic: 'Accounting equation',
      text: 'The accounting equation states that assets equal:',
      options: [
        { text: 'Liabilities + equity', correct: true },
        { text: 'Liabilities − equity', correct: false },
        { text: 'Equity − liabilities', correct: false },
        { text: 'Revenue + expenses', correct: false },
      ],
      marks: 2,
      negativeMarks: 0.5,
      explanation: 'The balance sheet identity is Assets = Liabilities + Equity.',
      tags: ['fundamentals'],
    },
    {
      type: 'TRUE_FALSE',
      topic: 'Depreciation',
      text: 'Straight-line depreciation allocates an equal amount of depreciation to each period of an asset\'s useful life.',
      options: [
        { text: 'True', correct: true },
        { text: 'False', correct: false },
      ],
      marks: 2,
      explanation: 'The straight-line method spreads the depreciable amount evenly across periods.',
      tags: ['depreciation'],
    },
    {
      type: 'MCQ',
      topic: 'Probability',
      text: 'Two fair coins are tossed. What is the probability of obtaining exactly one head?',
      options: [
        { text: '1/2', correct: true },
        { text: '1/4', correct: false },
        { text: '3/4', correct: false },
        { text: '1/3', correct: false },
      ],
      marks: 2,
      negativeMarks: 0.5,
      explanation: 'Of the four equally likely outcomes, two (HT and TH) contain exactly one head.',
      tags: ['probability'],
    },
    {
      type: 'FILL_BLANK',
      topic: 'Descriptive statistics',
      text: 'For the data set 2, 4, 4, 6 the arithmetic mean is ______ .',
      options: [],
      marks: 2,
      explanation: 'The total is 16 and there are four observations, giving a mean of 4.',
      tags: ['mean'],
      acceptedAnswers: ['4'],
    },
    {
      type: 'MCQ',
      topic: 'Distributions',
      text: 'Which measure is most resistant to extreme outliers?',
      options: [
        { text: 'Median', correct: true },
        { text: 'Mean', correct: false },
        { text: 'Range', correct: false },
        { text: 'Variance', correct: false },
      ],
      marks: 3,
      negativeMarks: 1,
      explanation: 'The median depends on position rather than magnitude, so outliers move it less.',
      tags: ['robust-statistics'],
    },
    {
      type: 'MCQ',
      topic: 'Hashing',
      text: 'The principal purpose of a hash function in a hash table is to:',
      options: [
        { text: 'Map a key to a bucket index', correct: true },
        { text: 'Sort the keys', correct: false },
        { text: 'Compress the stored values', correct: false },
        { text: 'Encrypt the keys', correct: false },
      ],
      marks: 3,
      negativeMarks: 1,
      explanation: 'A hash function converts a key into an index used to address the bucket array.',
      tags: ['hashing'],
    },
    {
      type: 'TRUE_FALSE',
      topic: 'Graph theory',
      text: 'Dijkstra\'s algorithm requires non-negative edge weights to guarantee correct shortest paths.',
      options: [
        { text: 'True', correct: true },
        { text: 'False', correct: false },
      ],
      marks: 3,
      explanation: 'With negative weights the greedy choice is no longer safe; Bellman-Ford is used instead.',
      tags: ['graphs', 'shortest-path'],
    },
    {
      type: 'MCQ',
      topic: 'Indexing',
      text: 'The main benefit of a B-tree index on a frequently searched column is:',
      options: [
        { text: 'Faster equality and range lookups', correct: true },
        { text: 'Smaller row storage', correct: false },
        { text: 'Stronger encryption', correct: false },
        { text: 'Automatic data archiving', correct: false },
      ],
      marks: 3,
      negativeMarks: 1,
      explanation: 'A balanced tree index reduces the number of pages examined for a lookup.',
      tags: ['index', 'performance'],
    },
    {
      type: 'FILL_BLANK',
      topic: 'Integration',
      text: 'The integral of 2x with respect to x is x² plus a constant of integration, usually written ______ .',
      options: [],
      marks: 2,
      explanation: 'The "+ C" records the arbitrary constant of an indefinite integral.',
      tags: ['calculus'],
      acceptedAnswers: ['C', '+C', 'c'],
    },
    {
      type: 'MCQ',
      topic: 'Sampling',
      text: 'Which sampling method divides the population into homogeneous groups before drawing a sample?',
      options: [
        { text: 'Stratified sampling', correct: true },
        { text: 'Simple random sampling', correct: false },
        { text: 'Convenience sampling', correct: false },
        { text: 'Snowball sampling', correct: false },
      ],
      marks: 3,
      negativeMarks: 1,
      explanation: 'Stratification partitions the population by a shared characteristic before sampling.',
      tags: ['sampling', 'methodology'],
    },
    {
      type: 'TRUE_FALSE',
      topic: 'Recursion',
      text: 'Every recursive algorithm can be rewritten iteratively using an explicit stack.',
      options: [
        { text: 'True', correct: true },
        { text: 'False', correct: false },
      ],
      marks: 2,
      explanation: 'Recursion relies on a call stack that can always be modelled explicitly.',
      tags: ['recursion'],
    },
  ];
}

async function main(): Promise<void> {
  if (RESET) {
    const databaseFile =
      process.env.DATABASE_FILE ??
      path.join(__dirname, '..', '..', '..', 'data', 'examsys.sqlite');
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${databaseFile}${suffix}`;
      if (fs.existsSync(file)) fs.rmSync(file);
    }
  }

  const db = getDb();
  syncRolesAndPermissions(db);
  const result = await seedDatabase(db);

  // eslint-disable-next-line no-console
  console.log('\nSeed complete.');
  // eslint-disable-next-line no-console
  console.log(`  Institution: ${result.institutionId}`);
  // eslint-disable-next-line no-console
  console.log('  Records:', JSON.stringify(result.counts));
  if (result.credentials.length) {
    // eslint-disable-next-line no-console
    console.log('\n  Demonstration credentials (all passwords: %s)', DEMO_PASSWORD);
    for (const credential of result.credentials) {
      // eslint-disable-next-line no-console
      console.log(`    - ${credential.role.padEnd(32)} ${credential.email}`);
    }
    // eslint-disable-next-line no-console
    console.log('\n  All seeded records are marked as demo data (institutions.is_demo = 1).');
  } else {
    // eslint-disable-next-line no-console
    console.log('  Demo data already present — nothing to do. Use `npm run reset` to rebuild.');
  }
  closeDb();
}

// The seeding routine is also used by the server at boot (`ensureDemoData`), so the
// command-line entry point only runs when this file is executed directly.
if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Seeding failed:', error);
    process.exit(1);
  });
}
