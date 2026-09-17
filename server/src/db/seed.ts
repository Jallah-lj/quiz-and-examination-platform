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
import { gradeObjective, round2, type AnswerKey } from '../lib/answer-key';
import { computeFinalScore, resolveScheme } from '../lib/grading';

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
  counts.questions = createdQuestions.length;

  // -------------------------------------------------------------------- quizzes
  const quizSeed = [
    { subjectIndex: 0, teacherIndex: 0, classIndex: 0, title: 'Algorithms Warm-up Quiz', count: 5, minutes: 15, offset: -6 },
    { subjectIndex: 1, teacherIndex: 1, classIndex: 1, title: 'SQL Fundamentals Check', count: 5, minutes: 20, offset: -3 },
    { subjectIndex: 2, teacherIndex: 2, classIndex: 2, title: 'Calculus Refresher Quiz', count: 5, minutes: 15, offset: 2 },
    { subjectIndex: 3, teacherIndex: 3, classIndex: 0, title: 'Accounting Principles Quiz', count: 5, minutes: 20, offset: 5 },
    { subjectIndex: 4, teacherIndex: 4, classIndex: 1, title: 'Probability Basics Quiz', count: 5, minutes: 15, offset: 8 },
  ];

  const quizzes = quizSeed.map((quiz, index) => {
    const subjectQuestions = createdQuestions.filter((q) => q.subjectIndex === quiz.subjectIndex);
    const selected = subjectQuestions.slice(0, 8);
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
        quiz.count,
        quiz.minutes,
        2,
        50,
        index % 2 === 0 ? 1 : 0,
        index % 3 === 0 ? 1 : 0,
        1,
        1,
        1,
        1,
        availableFrom,
        availableUntil,
        index < 2 ? daysFromNow(-2) : daysFromNow(quiz.offset + 15),
        status,
        timestamp,
        timestamp,
      );
    const quizId = Number(info.lastInsertRowid);
    selected.forEach((question, position) => {
      db.prepare(
        'INSERT INTO quiz_questions (quiz_id, question_id, position, marks, negative_marks) VALUES (?,?,?,?,?)',
      ).run(quizId, question.id, position + 1, 1, 0.25);
    });
    db.prepare(
      'INSERT INTO quiz_assignments (quiz_id, class_id, assigned_by, assigned_at) VALUES (?,?,?,?)',
    ).run(quizId, classes[quiz.classIndex].id, teachers[quiz.teacherIndex].userId, timestamp);
    return {
      id: quizId,
      ...quiz,
      questionIds: selected.map((q) => q.id),
      timeLimitMinutes: quiz.minutes,
      passPercentage: 50,
      titleResolved: quiz.title,
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
    },
  ];

  const exams = examSeed.map((exam) => {
    const subjectQuestions = createdQuestions.filter((q) => q.subjectIndex === exam.subjectIndex);
    const objective = subjectQuestions.slice(0, exam.questions);
    const totalMarks = round2(
      objective.reduce((sum, question) => {
        const row = db.prepare('SELECT marks FROM questions WHERE id = ?').get(question.id) as { marks: number };
        return sum + row.marks;
      }, 0),
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
        exam.status === 'PUBLISHED' ? daysFromNow(exam.start + 4) : daysFromNow(exam.start + 10),
        exam.status,
        exam.status === 'PUBLISHED' ? daysFromNow(exam.start + 4) : null,
        timestamp,
        timestamp,
      );
    const examId = Number(info.lastInsertRowid);
    objective.forEach((question, position) => {
      const row = db.prepare('SELECT marks, negative_marks FROM questions WHERE id = ?').get(question.id) as {
        marks: number;
        negative_marks: number;
      };
      db.prepare(
        'INSERT INTO exam_questions (exam_id, question_id, position, marks, negative_marks) VALUES (?,?,?,?,?)',
      ).run(examId, question.id, position + 1, row.marks, row.negative_marks);
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
      assignedClassId: classes[exam.classIndex].id,
    };
  });
  counts.exams = exams.length;

  // -------------------------------------------------------- sample quiz attempts
  const quizAttemptsCreated = createSampleQuizAttempts(db, quizzes, students, institutionId);
  counts.quizAttempts = quizAttemptsCreated;

  // -------------------------------------------------------- sample exam attempts
  const examResult = createSampleExamAttempts(db, exams, students, institutionId);
  counts.examAttempts = examResult.attempts;
  counts.results = examResult.results;

  // --------------------------------------------------------------- notifications
  const notificationSeeds = [
    { type: 'exam_assigned', title: 'New examination assigned', body: 'Midterm Examination — Data Structures & Algorithms is now open.', link: '/student/examinations' },
    { type: 'result_published', title: 'Result published', body: 'Your Statistics Continuous Assessment result is available.', link: '/student/results' },
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

function createSampleQuizAttempts(
  db: Db,
  quizzes: { id: number; questionIds: number[]; timeLimitMinutes: number; passPercentage: number }[],
  students: { id: number; userId: number }[],
  institutionId: number,
): number {
  let created = 0;
  for (const quiz of quizzes.slice(0, 4)) {
    const participants = students.slice(0, randomInt(4, 9));
    for (const student of participants) {
      const startedAt = daysFromNow(-5 + (created % 5), randomInt(0, 6));
      const submittedAt = addHours(startedAt, 0.4);
      const expiresAt = addHours(startedAt, quiz.timeLimitMinutes / 60);
      const attemptInfo = db
        .prepare(
          `INSERT INTO attempts
            (institution_id, quiz_id, student_id, attempt_no, status, started_at, expires_at, last_activity_at,
             submitted_at, submit_reason, max_marks, created_at, updated_at)
           VALUES (?,?,?, 1, 'SUBMITTED', ?,?,?,?, 'manual', ?,?,?)`,
        )
        .run(
          institutionId,
          quiz.id,
          student.id,
          startedAt,
          expiresAt,
          submittedAt,
          submittedAt,
          quiz.questionIds.length,
          startedAt,
          submittedAt,
        );
      const attemptId = Number(attemptInfo.lastInsertRowid);
      try {
        gradeSampleObjectiveAttempt(db, attemptId, quiz.questionIds, institutionId, quiz.passPercentage, null);
        created += 1;
      } catch {
        db.prepare('DELETE FROM attempts WHERE id = ?').run(attemptId);
      }
    }
  }
  return created;
}

function createSampleExamAttempts(
  db: Db,
  exams: { id: number; questionIds: number[]; assignedClassId: number; status: string; passMarks: number; totalMarks: number }[],
  students: { id: number; userId: number; classId: number }[],
  institutionId: number,
): { attempts: number; results: number } {
  let attempts = 0;
  let results = 0;

  for (const exam of exams) {
    const cohort = students.filter((student) => student.classId === exam.assignedClassId);
    const participants = cohort.slice(0, Math.min(cohort.length, exam.status === 'PUBLISHED' ? cohort.length : 6));

    for (const student of participants) {
      const startedAt = exam.status === 'PUBLISHED' ? daysFromNow(-11, randomInt(1, 4)) : daysFromNow(-1, randomInt(0, 5));
      const submittedAt = addHours(startedAt, 0.75);
      const expiresAt = addHours(startedAt, 1.5);
      const status = exam.status === 'PUBLISHED' ? 'GRADED' : exam.status === 'ACTIVE' ? 'UNDER_REVIEW' : 'SUBMITTED';

      const attemptInfo = db
        .prepare(
          `INSERT INTO attempts
            (institution_id, exam_id, student_id, attempt_no, status, started_at, expires_at, last_activity_at,
             submitted_at, submit_reason, max_marks, created_at, updated_at)
           VALUES (?,?,?, 1, ?, ?,?,?,?, 'manual', ?,?,?)`,
        )
        .run(
          institutionId,
          exam.id,
          student.id,
          status,
          startedAt,
          expiresAt,
          submittedAt,
          submittedAt,
          exam.totalMarks,
          startedAt,
          submittedAt,
        );
      const attemptId = Number(attemptInfo.lastInsertRowid);
      try {
        const graded = gradeSampleObjectiveAttempt(
          db,
          attemptId,
          exam.questionIds,
          institutionId,
          (exam.passMarks / Math.max(1, exam.totalMarks)) * 100,
          exam,
        );
        attempts += 1;
        if (graded.resultCreated) results += 1;
      } catch {
        db.prepare('DELETE FROM attempts WHERE id = ?').run(attemptId);
      }
    }
  }

  return { attempts, results };
}

/**
 * Generates a realistic answer sheet with a controlled mix of correct, incorrect and
 * blank answers, then runs the real grading pipeline so seeded data matches the
 * behaviour of the live application.
 */
function gradeSampleObjectiveAttempt(
  db: Db,
  attemptId: number,
  questionIds: number[],
  institutionId: number,
  passPercentage: number,
  exam: { id: number; passMarks: number; totalMarks: number } | null,
): { resultCreated: boolean } {
  const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as any;
  const timestamp = attempt.submitted_at;
  let maxMarks = 0;

  questionIds.forEach((questionId, index) => {
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId) as any;
    if (!question) return;
    const options = db
      .prepare('SELECT label, text, is_correct FROM question_options WHERE question_id = ? ORDER BY position')
      .all(questionId) as { label: string; text: string; is_correct: number }[];
    const config = JSON.parse(question.answer_config ?? '{}');
    const correctLabels = (config.correctOptions ?? (options.filter((o) => o.is_correct).map((o) => o.label))) as string[];

    maxMarks += question.marks;

    db.prepare(
      `INSERT INTO attempt_questions
        (attempt_id, question_id, position, question_type, question_text, marks, negative_marks, is_objective, correct_answer, snapshot)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      attemptId,
      questionId,
      index + 1,
      question.type,
      question.text,
      question.marks,
      question.negative_marks,
      ['MCQ', 'TRUE_FALSE', 'FILL_BLANK'].includes(question.type) ? 1 : 0,
      JSON.stringify(config),
      JSON.stringify({
        options: options.map((o) => ({ label: o.label, text: o.text })),
        answerConfig: config,
        explanation: question.explanation,
        topic: question.topic,
        difficulty: question.difficulty,
      }),
    );

    const dice = rand();
    if (dice > 0.92) return; // left unanswered
    const chooseCorrect = dice < 0.62;
    const labels = options.map((o) => o.label);
    const wrongLabels = labels.filter((label) => !correctLabels.includes(label));
    const selected = chooseCorrect
      ? correctLabels
      : wrongLabels.length
        ? [pick(wrongLabels)]
        : [pick(labels)];

    db.prepare(
      `INSERT INTO answers (attempt_id, question_id, selected_options, is_correct, awarded_marks, max_marks,
                            auto_graded, graded_at, save_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 1, ?, ?, ?, ?)`,
    ).run(
      attemptId,
      questionId,
      JSON.stringify(selected),
      0,
      0,
      question.marks,
      timestamp,
      randomInt(1, 4),
      attempt.started_at,
      timestamp,
    );
  });

  db.prepare('UPDATE attempts SET max_marks = ? WHERE id = ?').run(maxMarks, attemptId);

  // Deterministic grading through the production code path.
  const answerRows = db
    .prepare(
      `SELECT an.id, an.question_id, an.selected_options, an.answer_text, aq.question_type, aq.marks,
              aq.negative_marks, aq.correct_answer, aq.is_objective
         FROM answers an
         JOIN attempt_questions aq ON aq.attempt_id = an.attempt_id AND aq.question_id = an.question_id
        WHERE an.attempt_id = ?`,
    )
    .all(attemptId) as any[];

  let objective = 0;
  for (const answer of answerRows) {
    if (!answer.is_objective) continue;
    const key = JSON.parse(answer.correct_answer ?? '{}') as AnswerKey;
    const result = gradeObjective(
      answer.question_type,
      { selectedOptions: JSON.parse(answer.selected_options ?? '[]'), answerText: answer.answer_text },
      key,
      answer.marks,
      answer.negative_marks,
    );
    objective += result.awarded;
    db.prepare('UPDATE answers SET is_correct = ?, awarded_marks = ?, auto_graded = 1, graded_at = ? WHERE id = ?').run(
      result.isCorrect ? 1 : 0,
      result.awarded,
      timestamp,
      answer.id,
    );
  }

  objective = round2(objective);
  const scheme = resolveScheme(db, institutionId, null);
  const totalMarks = exam ? exam.totalMarks : maxMarks;
  const finalScore = computeFinalScore({
    totalMarks,
    obtainedMarks: objective,
    passMark: exam ? exam.passMarks : round2((passPercentage / 100) * maxMarks),
    bands: scheme.bands,
  });

  const isPublished = attempt.status === 'GRADED';
  db.prepare(
    `UPDATE attempts SET objective_marks = ?, total_marks = ?, obtained_marks = ?, percentage = ?, grade = ?,
            passed = ?, graded_at = ?, result_published_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    objective,
    totalMarks,
    objective,
    finalScore.percentage,
    finalScore.grade,
    finalScore.outcome === 'PASSED' ? 1 : 0,
    timestamp,
    isPublished ? timestamp : null,
    timestamp,
    attemptId,
  );

  if (attempt.status === 'UNDER_REVIEW' || attempt.status === 'SUBMITTED') return { resultCreated: false };

  try {
    db.prepare(
      `INSERT INTO results
        (attempt_id, institution_id, exam_id, quiz_id, student_id, subject_id, total_marks, obtained_marks,
         percentage, grade, points, outcome, scheme_id, is_published, published_at, created_at, updated_at)
       VALUES (?,?,
               (SELECT exam_id FROM attempts WHERE id = ?),
               (SELECT quiz_id FROM attempts WHERE id = ?),
               (SELECT student_id FROM attempts WHERE id = ?),
               COALESCE((SELECT subject_id FROM exams WHERE id = (SELECT exam_id FROM attempts WHERE id = ?)),
                        (SELECT subject_id FROM quizzes WHERE id = (SELECT quiz_id FROM attempts WHERE id = ?))),
               ?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      attemptId,
      institutionId,
      attemptId,
      attemptId,
      attemptId,
      attemptId,
      attemptId,
      finalScore.totalMarks,
      finalScore.obtainedMarks,
      finalScore.percentage,
      finalScore.grade,
      finalScore.points,
      finalScore.outcome,
      scheme.schemeId,
      isPublished ? 1 : 0,
      isPublished ? timestamp : null,
      timestamp,
      timestamp,
    );
  } catch {
    return { resultCreated: false };
  }

  return { resultCreated: true };
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
