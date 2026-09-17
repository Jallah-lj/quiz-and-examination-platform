-- ============================================================================
-- ExamSys — core schema
-- SQLite (WAL). Timestamps are stored as ISO-8601 UTC strings ("YYYY-MM-DDTHH:MM:SS.sssZ").
-- All foreign keys are enforced (PRAGMA foreign_keys = ON, set per connection).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Institutions & platform level
-- ---------------------------------------------------------------------------
CREATE TABLE institutions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  code            TEXT    NOT NULL UNIQUE,
  type            TEXT    NOT NULL DEFAULT 'school',      -- school | university | training_center | certification_body | organisation
  email           TEXT,
  phone           TEXT,
  address         TEXT,
  city            TEXT,
  country         TEXT,
  timezone        TEXT    NOT NULL DEFAULT 'UTC',
  logo_url        TEXT,
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  is_demo         INTEGER NOT NULL DEFAULT 0,
  settings        TEXT    NOT NULL DEFAULT '{}',
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE INDEX idx_institutions_status ON institutions(status);

-- ---------------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,      -- super_admin | institution_admin | teacher | student
  name        TEXT    NOT NULL,
  description TEXT,
  scope       TEXT    NOT NULL CHECK (scope IN ('platform','institution','self')),
  is_system   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL
);

CREATE TABLE permissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,      -- e.g. exam.create
  name        TEXT    NOT NULL,
  category    TEXT    NOT NULL,
  description TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_permissions_category ON permissions(category);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- Users, sessions, credentials
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id       INTEGER REFERENCES institutions(id) ON DELETE RESTRICT,  -- NULL for platform staff
  role_id              INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  full_name            TEXT    NOT NULL,
  email                TEXT    NOT NULL UNIQUE,
  password_hash        TEXT    NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'active'
                         CHECK (status IN ('pending','active','suspended','disabled')),
  phone                TEXT,
  avatar_url           TEXT,
  email_verified_at    TEXT,
  last_login_at        TEXT,
  failed_login_count   INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  deleted_at           TEXT
);
CREATE INDEX idx_users_institution ON users(institution_id);
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_name ON users(full_name);

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  csrf_hash    TEXT    NOT NULL,
  user_agent   TEXT,
  ip_address   TEXT,
  created_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  revoked_at   TEXT,
  revoked_reason TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  expires_at TEXT    NOT NULL,
  used_at    TEXT,
  requested_ip TEXT,
  created_at TEXT    NOT NULL
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

CREATE TABLE email_verifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    NOT NULL UNIQUE,
  email       TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  verified_at TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_email_verifications_user ON email_verifications(user_id);

CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL,
  ip_address TEXT,
  success    INTEGER NOT NULL,
  reason     TEXT,
  created_at TEXT    NOT NULL
);
CREATE INDEX idx_login_attempts_email_time ON login_attempts(email, created_at);
CREATE INDEX idx_login_attempts_ip_time ON login_attempts(ip_address, created_at);

-- ---------------------------------------------------------------------------
-- Academic structure
-- ---------------------------------------------------------------------------
CREATE TABLE departments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  code           TEXT    NOT NULL,
  description    TEXT,
  head_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  UNIQUE (institution_id, code)
);
CREATE INDEX idx_departments_institution ON departments(institution_id);

CREATE TABLE classes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id    INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  department_id     INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  name              TEXT    NOT NULL,
  code              TEXT    NOT NULL,
  level             TEXT,
  academic_year     TEXT    NOT NULL,
  class_teacher_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  capacity          INTEGER,
  room              TEXT,
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE INDEX idx_classes_institution ON classes(institution_id);
CREATE UNIQUE INDEX idx_classes_unique_code ON classes(institution_id, code, academic_year);
CREATE INDEX idx_classes_department ON classes(department_id);

CREATE TABLE students (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  class_id       INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  student_code   TEXT    NOT NULL,
  date_of_birth  TEXT,
  gender         TEXT,
  guardian_name  TEXT,
  guardian_phone TEXT,
  admission_date TEXT,
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','graduated','suspended')),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_students_unique_code ON students(institution_id, student_code);
CREATE INDEX idx_students_institution ON students(institution_id);
CREATE INDEX idx_students_class ON students(class_id);
CREATE INDEX idx_students_status ON students(status);

CREATE TABLE teachers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  staff_code     TEXT    NOT NULL,
  designation    TEXT,
  specialization TEXT,
  joined_at      TEXT,
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_teachers_unique_code ON teachers(institution_id, staff_code);
CREATE INDEX idx_teachers_institution ON teachers(institution_id);
CREATE INDEX idx_teachers_department ON teachers(department_id);

CREATE TABLE groups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  class_id       INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  description    TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX idx_groups_institution ON groups(institution_id);
CREATE INDEX idx_groups_class ON groups(class_id);

CREATE TABLE group_members (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  added_at   TEXT    NOT NULL,
  PRIMARY KEY (group_id, student_id)
);

CREATE TABLE subjects (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  name           TEXT    NOT NULL,
  code           TEXT    NOT NULL,
  description    TEXT,
  credit_hours   REAL,
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  UNIQUE (institution_id, code)
);
CREATE INDEX idx_subjects_institution ON subjects(institution_id);

CREATE TABLE teacher_subjects (
  teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  assigned_at TEXT   NOT NULL,
  PRIMARY KEY (teacher_id, subject_id)
);

CREATE TABLE class_subjects (
  class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
  assigned_at TEXT   NOT NULL,
  PRIMARY KEY (class_id, subject_id)
);

-- ---------------------------------------------------------------------------
-- Question bank
-- ---------------------------------------------------------------------------
CREATE TABLE question_banks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  subject_id     INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  name           TEXT    NOT NULL,
  description    TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX idx_qbanks_institution ON question_banks(institution_id);
CREATE INDEX idx_qbanks_subject ON question_banks(subject_id);

CREATE TABLE questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id  INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  question_bank_id INTEGER NOT NULL REFERENCES question_banks(id) ON DELETE RESTRICT,
  subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  topic           TEXT,
  type            TEXT    NOT NULL
                    CHECK (type IN ('MCQ','TRUE_FALSE','SHORT_ANSWER','ESSAY','FILL_BLANK')),
  text            TEXT    NOT NULL,
  explanation     TEXT,
  marks           REAL    NOT NULL DEFAULT 1 CHECK (marks >= 0),
  negative_marks  REAL    NOT NULL DEFAULT 0 CHECK (negative_marks >= 0),
  difficulty      TEXT    NOT NULL DEFAULT 'MEDIUM' CHECK (difficulty IN ('EASY','MEDIUM','HARD')),
  status          TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  tags            TEXT    NOT NULL DEFAULT '[]',           -- JSON array of strings
  answer_config   TEXT    NOT NULL DEFAULT '{}',           -- JSON: {caseSensitive, allowPartial, numericTolerance, acceptedAnswers[]}
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  archived_at     TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE INDEX idx_questions_institution ON questions(institution_id);
CREATE INDEX idx_questions_bank ON questions(question_bank_id);
CREATE INDEX idx_questions_subject ON questions(subject_id);
CREATE INDEX idx_questions_type ON questions(type);
CREATE INDEX idx_questions_difficulty ON questions(difficulty);
CREATE INDEX idx_questions_status ON questions(status);
CREATE INDEX idx_questions_topic ON questions(topic);

CREATE TABLE question_options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label       TEXT    NOT NULL,          -- A, B, C, D...
  text        TEXT    NOT NULL,
  is_correct  INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_question_options_question ON question_options(question_id);

-- ---------------------------------------------------------------------------
-- Quizzes
-- ---------------------------------------------------------------------------
CREATE TABLE quizzes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id        INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  subject_id            INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  class_id              INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  created_by            INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title                 TEXT    NOT NULL,
  description           TEXT,
  instructions          TEXT,
  question_count        INTEGER NOT NULL CHECK (question_count > 0),
  time_limit_minutes    INTEGER NOT NULL CHECK (time_limit_minutes > 0),
  max_attempts          INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
  pass_percentage       REAL    NOT NULL DEFAULT 50 CHECK (pass_percentage BETWEEN 0 AND 100),
  randomize_questions   INTEGER NOT NULL DEFAULT 0,
  randomize_options     INTEGER NOT NULL DEFAULT 0,
  immediate_results     INTEGER NOT NULL DEFAULT 0,
  show_correct_answers  INTEGER NOT NULL DEFAULT 0,
  allow_review          INTEGER NOT NULL DEFAULT 1,
  negative_marking      INTEGER NOT NULL DEFAULT 0,
  available_from        TEXT    NOT NULL,
  available_until       TEXT    NOT NULL,
  result_release_at     TEXT,
  status                TEXT    NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT','SCHEDULED','ACTIVE','CLOSED','ARCHIVED')),
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);
CREATE INDEX idx_quizzes_institution ON quizzes(institution_id);
CREATE INDEX idx_quizzes_status ON quizzes(status);
CREATE INDEX idx_quizzes_subject ON quizzes(subject_id);

CREATE TABLE quiz_questions (
  quiz_id      INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  position     INTEGER NOT NULL DEFAULT 0,
  marks        REAL    NOT NULL DEFAULT 1,
  negative_marks REAL  NOT NULL DEFAULT 0,
  PRIMARY KEY (quiz_id, question_id)
);

-- ---------------------------------------------------------------------------
-- Examinations
-- ---------------------------------------------------------------------------
CREATE TABLE exams (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id        INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  subject_id            INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  class_id              INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  created_by            INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name                  TEXT    NOT NULL,
  code                  TEXT    NOT NULL,
  academic_year         TEXT    NOT NULL,
  semester              TEXT,
  exam_type             TEXT    NOT NULL DEFAULT 'FINAL'
                          CHECK (exam_type IN ('QUIZ','MIDTERM','FINAL','PRACTICAL','ASSIGNMENT','CERTIFICATION','ENTRANCE')),
  duration_minutes      INTEGER NOT NULL CHECK (duration_minutes BETWEEN 1 AND 600),
  start_at              TEXT    NOT NULL,
  end_at                TEXT    NOT NULL,
  total_marks           REAL    NOT NULL CHECK (total_marks > 0),
  pass_marks            REAL    NOT NULL DEFAULT 50 CHECK (pass_marks >= 0),
  max_attempts          INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts > 0),
  instructions          TEXT,
  randomize_questions   INTEGER NOT NULL DEFAULT 0,
  randomize_options     INTEGER NOT NULL DEFAULT 0,
  negative_marking      INTEGER NOT NULL DEFAULT 0,
  grading_scheme_id     INTEGER REFERENCES grading_schemes(id) ON DELETE SET NULL,
  result_release_at     TEXT,
  status                TEXT    NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT','SCHEDULED','ACTIVE','UNDER_REVIEW','PUBLISHED','ARCHIVED')),
  published_at          TEXT,
  archived_at           TEXT,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  CHECK (end_at > start_at),
  CHECK (pass_marks <= total_marks)
);
CREATE INDEX idx_exams_institution ON exams(institution_id);
CREATE INDEX idx_exams_status ON exams(status);
CREATE INDEX idx_exams_subject ON exams(subject_id);
CREATE INDEX idx_exams_class ON exams(class_id);
CREATE INDEX idx_exams_created_by ON exams(created_by);
CREATE INDEX idx_exams_start ON exams(start_at);

CREATE TABLE exam_questions (
  exam_id        INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  position       INTEGER NOT NULL DEFAULT 0,
  marks          REAL    NOT NULL DEFAULT 1,
  negative_marks REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (exam_id, question_id)
);
CREATE INDEX idx_exam_questions_question ON exam_questions(question_id);

CREATE TABLE exam_assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  class_id    INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  student_id  INTEGER REFERENCES students(id) ON DELETE CASCADE,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TEXT    NOT NULL,
  CHECK ((class_id IS NOT NULL) + (group_id IS NOT NULL) + (student_id IS NOT NULL) = 1)
);
CREATE INDEX idx_exam_assignments_exam ON exam_assignments(exam_id);
CREATE INDEX idx_exam_assignments_class ON exam_assignments(class_id);
CREATE INDEX idx_exam_assignments_group ON exam_assignments(group_id);
CREATE INDEX idx_exam_assignments_student ON exam_assignments(student_id);

CREATE TABLE quiz_assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id     INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  class_id    INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  group_id    INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  student_id  INTEGER REFERENCES students(id) ON DELETE CASCADE,
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TEXT    NOT NULL,
  CHECK ((class_id IS NOT NULL) + (group_id IS NOT NULL) + (student_id IS NOT NULL) = 1)
);
CREATE INDEX idx_quiz_assignments_quiz ON quiz_assignments(quiz_id);
CREATE INDEX idx_quiz_assignments_class ON quiz_assignments(class_id);
CREATE INDEX idx_quiz_assignments_group ON quiz_assignments(group_id);
CREATE INDEX idx_quiz_assignments_student ON quiz_assignments(student_id);

-- ---------------------------------------------------------------------------
-- Attempts, answers, grading
-- ---------------------------------------------------------------------------
CREATE TABLE attempts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id       INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  exam_id              INTEGER REFERENCES exams(id) ON DELETE RESTRICT,
  quiz_id              INTEGER REFERENCES quizzes(id) ON DELETE RESTRICT,
  student_id           INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attempt_no           INTEGER NOT NULL DEFAULT 1,
  status               TEXT    NOT NULL DEFAULT 'IN_PROGRESS'
                         CHECK (status IN ('IN_PROGRESS','SUBMITTED','UNDER_REVIEW','GRADED','EXPIRED','VOID')),
  started_at           TEXT    NOT NULL,
  expires_at           TEXT    NOT NULL,
  last_activity_at     TEXT    NOT NULL,
  submitted_at         TEXT,
  submit_reason        TEXT,                     -- manual | time_expired | admin_force
  ip_address           TEXT,
  user_agent           TEXT,
  version              INTEGER NOT NULL DEFAULT 1,
  auto_submitted       INTEGER NOT NULL DEFAULT 0,
  objective_marks      REAL    NOT NULL DEFAULT 0,
  subjective_marks     REAL    NOT NULL DEFAULT 0,
  total_marks          REAL    NOT NULL DEFAULT 0,
  obtained_marks       REAL,
  max_marks            REAL    NOT NULL DEFAULT 0,
  percentage           REAL,
  grade                TEXT,
  passed               INTEGER,
  graded_at            TEXT,
  graded_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  result_published_at  TEXT,
  result_published_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  integrity_flags      TEXT    NOT NULL DEFAULT '[]',
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  CHECK ((exam_id IS NOT NULL) + (quiz_id IS NOT NULL) = 1)
);
CREATE UNIQUE INDEX idx_attempts_unique_number ON attempts(exam_id, quiz_id, student_id, attempt_no);
CREATE INDEX idx_attempts_institution ON attempts(institution_id);
CREATE INDEX idx_attempts_student ON attempts(student_id);
CREATE INDEX idx_attempts_exam ON attempts(exam_id);
CREATE INDEX idx_attempts_quiz ON attempts(quiz_id);
CREATE INDEX idx_attempts_status ON attempts(status);
CREATE INDEX idx_attempts_expires ON attempts(status, expires_at);

-- Frozen copy of the paper served to a candidate: guarantees historical reproducibility
-- even if the source question is later edited or archived.
CREATE TABLE attempt_questions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id     INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  position       INTEGER NOT NULL,
  question_type  TEXT    NOT NULL,
  question_text  TEXT    NOT NULL,
  marks          REAL    NOT NULL,
  negative_marks REAL    NOT NULL DEFAULT 0,
  is_objective   INTEGER NOT NULL DEFAULT 0,
  correct_answer TEXT,                    -- JSON snapshot of accepted answer key
  snapshot       TEXT    NOT NULL        -- JSON snapshot of full question (options, config)
);
CREATE INDEX idx_attempt_questions_attempt ON attempt_questions(attempt_id);
CREATE UNIQUE INDEX idx_attempt_questions_unique ON attempt_questions(attempt_id, question_id);

CREATE TABLE answers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id      INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id     INTEGER NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  selected_options TEXT   NOT NULL DEFAULT '[]',   -- JSON array of option labels (MCQ / TRUE_FALSE)
  answer_text     TEXT,                            -- SHORT_ANSWER / ESSAY / FILL_BLANK
  is_flagged      INTEGER NOT NULL DEFAULT 0,
  is_correct      INTEGER,                         -- NULL until graded
  awarded_marks   REAL,                            -- NULL until graded
  max_marks       REAL    NOT NULL DEFAULT 0,
  auto_graded     INTEGER NOT NULL DEFAULT 0,
  graded_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  graded_at       TEXT,
  comment         TEXT,
  graded_version  INTEGER NOT NULL DEFAULT 0,
  save_count      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_answers_unique ON answers(attempt_id, question_id);
CREATE INDEX idx_answers_attempt ON answers(attempt_id);
CREATE INDEX idx_answers_question ON answers(question_id);

CREATE TABLE grading_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id      INTEGER NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  attempt_id     INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  grader_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  grader_name    TEXT,
  previous_marks REAL,
  awarded_marks  REAL NOT NULL,
  previous_comment TEXT,
  comment        TEXT,
  action         TEXT NOT NULL DEFAULT 'grade',   -- grade | finalize | reopen
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_grading_history_answer ON grading_history(answer_id);
CREATE INDEX idx_grading_history_attempt ON grading_history(attempt_id);

-- ---------------------------------------------------------------------------
-- Grading schemes & results
-- ---------------------------------------------------------------------------
CREATE TABLE grading_schemes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id  INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  description     TEXT,
  is_default      INTEGER NOT NULL DEFAULT 0,
  pass_percentage REAL    NOT NULL DEFAULT 50 CHECK (pass_percentage BETWEEN 0 AND 100),
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (institution_id, name)
);
CREATE INDEX idx_grading_schemes_institution ON grading_schemes(institution_id);

CREATE TABLE grading_bands (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme_id       INTEGER NOT NULL REFERENCES grading_schemes(id) ON DELETE CASCADE,
  grade           TEXT    NOT NULL,
  min_percentage  REAL    NOT NULL CHECK (min_percentage BETWEEN 0 AND 100),
  max_percentage  REAL    NOT NULL CHECK (max_percentage BETWEEN 0 AND 100),
  points          REAL,
  remark          TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  CHECK (max_percentage >= min_percentage)
);
CREATE INDEX idx_grading_bands_scheme ON grading_bands(scheme_id);

CREATE TABLE results (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id      INTEGER NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  institution_id  INTEGER NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  exam_id         INTEGER REFERENCES exams(id) ON DELETE RESTRICT,
  quiz_id         INTEGER REFERENCES quizzes(id) ON DELETE RESTRICT,
  student_id      INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  subject_id      INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
  total_marks     REAL    NOT NULL,
  obtained_marks  REAL    NOT NULL,
  percentage      REAL    NOT NULL,
  grade           TEXT,
  points          REAL,
  outcome         TEXT    NOT NULL CHECK (outcome IN ('PASSED','FAILED','PENDING')),
  remarks         TEXT,
  scheme_id       INTEGER REFERENCES grading_schemes(id) ON DELETE SET NULL,
  is_published    INTEGER NOT NULL DEFAULT 0,
  published_at    TEXT,
  published_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);
CREATE INDEX idx_results_institution ON results(institution_id);
CREATE INDEX idx_results_student ON results(student_id);
CREATE INDEX idx_results_exam ON results(exam_id);
CREATE INDEX idx_results_quiz ON results(quiz_id);
CREATE INDEX idx_results_published ON results(is_published);
CREATE INDEX idx_results_outcome ON results(outcome);

-- ---------------------------------------------------------------------------
-- Audit logs, notifications, settings
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE SET NULL,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name     TEXT,
  actor_role     TEXT,
  action         TEXT    NOT NULL,          -- e.g. exam.created
  category       TEXT    NOT NULL DEFAULT 'general',
  resource_type  TEXT,
  resource_id    TEXT,
  description    TEXT,
  metadata       TEXT    NOT NULL DEFAULT '{}',
  ip_address     TEXT,
  user_agent     TEXT,
  created_at     TEXT    NOT NULL
);
CREATE INDEX idx_audit_logs_institution ON audit_logs(institution_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_category ON audit_logs(category);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);

CREATE TABLE notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  body           TEXT,
  link           TEXT,
  severity       TEXT    NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','critical')),
  dedupe_key     TEXT,
  read_at        TEXT,
  created_at     TEXT    NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read_at);
CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE settings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE CASCADE,
  key            TEXT    NOT NULL,
  value          TEXT    NOT NULL,
  updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_settings_scope ON settings(IFNULL(institution_id, 0), key);

-- NOTE: the `schema_migrations` bookkeeping table is created by the migration
-- runner itself so that it exists before the first migration is applied.
