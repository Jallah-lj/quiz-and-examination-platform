/** API payload types. Field naming mirrors the server (snake_case for raw rows). */

export type RoleCode = 'super_admin' | 'institution_admin' | 'teacher' | 'student';
export type QuestionType = 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'ESSAY' | 'FILL_BLANK';
export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type ExamStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'UNDER_REVIEW' | 'PUBLISHED' | 'ARCHIVED';
export type QuizStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'CLOSED' | 'ARCHIVED';
export type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'UNDER_REVIEW' | 'GRADED' | 'EXPIRED' | 'VOID';
export type Outcome = 'PASSED' | 'FAILED' | 'PENDING';
export type ExamType = 'QUIZ' | 'MIDTERM' | 'FINAL' | 'PRACTICAL' | 'ASSIGNMENT' | 'CERTIFICATION' | 'ENTRANCE';

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  MCQ: 'Multiple choice',
  TRUE_FALSE: 'True / False',
  SHORT_ANSWER: 'Short answer',
  ESSAY: 'Essay',
  FILL_BLANK: 'Fill in the blank',
};

export const EXAM_TYPE_LABELS: Record<ExamType, string> = {
  QUIZ: 'Class quiz',
  MIDTERM: 'Midterm examination',
  FINAL: 'Final examination',
  PRACTICAL: 'Practical assessment',
  ASSIGNMENT: 'Assignment',
  CERTIFICATION: 'Certification',
  ENTRANCE: 'Entrance examination',
};

export interface SessionUser {
  id: number;
  fullName: string;
  email: string;
  role: RoleCode;
  roleName: string;
  institutionId: number | null;
  permissions: string[];
  student: {
    id: number;
    student_code: string;
    class_id: number | null;
    class_name: string | null;
    department_name: string | null;
  } | null;
  teacher: {
    id: number;
    staff_code: string;
    designation: string | null;
    department_id: number | null;
    department_name: string | null;
  } | null;
  institution: { id: number; name: string; code: string; type: string; timezone: string } | null;
}

export interface MeResponse {
  authenticated: boolean;
  /** Why an unauthenticated answer was given: no session presented, or one rejected. */
  sessionStatus?: 'valid' | 'unresolved' | 'none';
  csrfToken: string | null;
  unreadNotifications?: number;
  user: SessionUser | null;
}

export interface LoginResponse {
  user: SessionUser;
  csrfToken: string;
  expiresAt: string;
  /** Present when the server allows the bearer-token transport (cookie-blocked clients). */
  sessionToken?: string;
  tokenTransport?: 'bearer';
}

export interface Institution {
  id: number;
  name: string;
  code: string;
  type: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  timezone: string;
  logo_url: string | null;
  status: string;
  is_demo: number;
  created_at: string;
  updated_at: string;
  student_count?: number;
  teacher_count?: number;
  exam_count?: number;
}

export interface Department {
  id: number;
  institution_id: number;
  name: string;
  code: string;
  description: string | null;
  head_user_id: number | null;
  status: string;
  institution_name?: string;
  head_name?: string | null;
  class_count?: number;
  subject_count?: number;
  teacher_count?: number;
}

export interface ClassRow {
  id: number;
  institution_id: number;
  department_id: number | null;
  name: string;
  code: string;
  level: string | null;
  academic_year: string;
  class_teacher_id: number | null;
  capacity: number | null;
  room: string | null;
  status: string;
  department_name?: string | null;
  class_teacher_name?: string | null;
  student_count?: number;
  exam_count?: number;
}

export interface Subject {
  id: number;
  institution_id: number;
  department_id: number | null;
  name: string;
  code: string;
  description: string | null;
  credit_hours: number | null;
  status: string;
  department_name?: string | null;
  question_count?: number;
  bank_count?: number;
  exam_count?: number;
  teacher_count?: number;
}

export interface Group {
  id: number;
  institution_id: number;
  class_id: number | null;
  name: string;
  description: string | null;
  class_name?: string | null;
  member_count?: number;
  created_at: string;
}

export interface Student {
  id: number;
  institution_id: number;
  user_id: number;
  student_code: string;
  class_id: number | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  date_of_birth: string | null;
  gender: string | null;
  status: string;
  admission_date?: string | null;
  class_name?: string | null;
  department_name?: string | null;
  full_name?: string;
  email?: string;
  phone?: string | null;
  attempts?: number;
  average_percentage?: number | null;
  class_code?: string | null;
}

export interface Teacher {
  id: number;
  institution_id: number;
  user_id: number;
  staff_code: string;
  department_id: number | null;
  designation: string | null;
  specialization: string | null;
  status: string;
  full_name?: string;
  email?: string;
  phone?: string | null;
  department_name?: string | null;
  subject_count?: number;
  exam_count?: number;
  subjects?: { id: number; name: string; code: string }[];
}

export interface QuestionBank {
  id: number;
  institution_id: number;
  subject_id: number;
  name: string;
  description: string | null;
  created_by: number | null;
  status: string;
  created_at: string;
  updated_at: string;
  subject_name?: string;
  subject_code?: string;
  created_by_name?: string | null;
  active_questions?: number;
  total_questions?: number;
}

export interface QuestionListItem {
  id: number;
  type: QuestionType;
  text: string;
  topic: string | null;
  marks: number;
  negative_marks: number;
  difficulty: Difficulty;
  status: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  subject_id: number;
  question_bank_id: number;
  subject_name?: string;
  bank_name?: string;
  created_by_name?: string | null;
  option_count?: number;
  used_in_exams?: number;
  used_in_quizzes?: number;
}

export interface QuestionOption {
  id?: number;
  label: string;
  text: string;
  is_correct: number | boolean;
  position: number;
}

export interface QuestionDetail {
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
  difficulty: Difficulty;
  status: string;
  tags: string;
  answer_config: string;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
  options: QuestionOption[];
  answerKey: {
    correctOptions?: string[];
    acceptedAnswers?: string[];
    caseSensitive?: boolean;
    allowPartial?: boolean;
    numericTolerance?: number;
  };
}

export interface Quiz {
  id: number;
  institution_id: number;
  subject_id: number;
  class_id: number | null;
  created_by: number | null;
  title: string;
  description: string | null;
  instructions: string | null;
  question_count: number;
  time_limit_minutes: number;
  max_attempts: number;
  pass_percentage: number;
  randomize_questions: number;
  randomize_options: number;
  immediate_results: number;
  show_correct_answers: number;
  allow_review: number;
  negative_marking: number;
  available_from: string;
  available_until: string;
  result_release_at: string | null;
  status: QuizStatus;
  created_at: string;
  updated_at: string;
  subject_name?: string;
  class_name?: string | null;
  created_by_name?: string | null;
  attached_questions?: number;
  assignments?: number;
  attempt_count?: number;
  average_percentage?: number;
}

export interface Exam {
  id: number;
  institution_id: number;
  subject_id: number;
  class_id: number | null;
  created_by: number | null;
  name: string;
  code: string;
  academic_year: string;
  semester: string | null;
  exam_type: ExamType;
  duration_minutes: number;
  start_at: string;
  end_at: string;
  total_marks: number;
  pass_marks: number;
  max_attempts: number;
  instructions: string | null;
  randomize_questions: number;
  randomize_options: number;
  negative_marking: number;
  grading_scheme_id: number | null;
  result_release_at: string | null;
  status: ExamStatus;
  published_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  subject_name?: string;
  class_name?: string | null;
  created_by_name?: string | null;
  question_count?: number;
  assignment_count?: number;
  attempt_count?: number;
  live_attempts?: number;
  awaiting_grading?: number;
  average_percentage?: number;
}

export interface ExamQuestionRow {
  id: number;
  type: QuestionType;
  text: string;
  topic: string | null;
  difficulty: Difficulty;
  default_marks: number;
  marks: number;
  negative_marks: number;
  position: number;
  subject_name?: string;
  option_count?: number;
}

export interface ExamAssignment {
  id: number;
  class_id: number | null;
  group_id: number | null;
  student_id: number | null;
  assigned_at: string;
  class_name?: string | null;
  group_name?: string | null;
  student_name?: string | null;
  student_code?: string | null;
}

export interface ExamDetail {
  exam: Exam;
  questions: ExamQuestionRow[];
  assignments: ExamAssignment[];
  gradingScheme: { id: number; name: string; pass_percentage: number } | null;
}

export interface ExamAttemptRow {
  id: number;
  attempt_no: number;
  status: AttemptStatus;
  started_at: string;
  expires_at: string;
  submitted_at: string | null;
  last_activity_at: string | null;
  obtained_marks: number | null;
  max_marks: number;
  percentage: number | null;
  grade: string | null;
  auto_submitted: number;
  student_name: string;
  student_code: string;
  student_id: number;
  class_name: string | null;
  is_published: number | null;
  outcome: Outcome | null;
  result_id: number | null;
  integrityFlags?: number;
}

export interface AttemptListItem {
  id: number;
  attempt_no: number;
  status: AttemptStatus;
  started_at: string;
  expires_at: string;
  submitted_at: string | null;
  obtained_marks: number | null;
  max_marks: number;
  percentage: number | null;
  grade: string | null;
  auto_submitted: number;
  paper_title: string;
  paper_code: string;
  kind: 'EXAM' | 'QUIZ';
  is_published: number | null;
  outcome: Outcome | null;
  result_id: number | null;
  student_name: string;
  student_code: string;
}

export interface GradingQueueItem {
  id: number;
  status: AttemptStatus;
  submitted_at: string | null;
  obtained_marks: number | null;
  max_marks: number;
  percentage: number | null;
  auto_submitted: number;
  paper_title: string;
  exam_code: string;
  kind: 'EXAM' | 'QUIZ';
  student_name: string;
  student_code: string;
  student_id: number;
  subject_name: string | null;
  subjective_count: number;
  ungraded_count: number;
  exam_id: number | null;
  quiz_id: number | null;
}

export interface GradingAnswer {
  id: number;
  selectedOptions: string[];
  answerText: string | null;
  isCorrect: boolean | null;
  awardedMarks: number | null;
  comment: string | null;
  autoGraded: boolean;
  isFlagged: boolean;
  answeredAt: string | null;
  gradedBy: number | null;
  gradedByName: string | null;
  gradedAt: string | null;
}

export interface GradingQuestion {
  questionId: number;
  position: number;
  type: QuestionType;
  text: string;
  marks: number;
  negativeMarks: number;
  objective: boolean;
  options: { label: string; text: string }[];
  correctAnswer: Record<string, unknown>;
  explanation?: string | null;
  answer: GradingAnswer | null;
}

export interface GradingAttempt {
  attempt: {
    id: number;
    status: AttemptStatus;
    studentName: string;
    studentCode: string;
    paperTitle: string;
    paperCode: string;
    kind: 'EXAM' | 'QUIZ';
    instructions: string | null;
    institutionName: string;
    submittedAt: string | null;
    autoSubmitted: boolean;
    startedAt: string;
    objectiveMarks: number | null;
    subjectiveMarks: number | null;
    obtainedMarks: number | null;
    maxMarks: number;
    percentage: number | null;
    grade: string | null;
    passed: number | null;
    examPassMarks: number | null;
    examTotalMarks: number | null;
    integrityFlags: { type: string; detail: string; at?: string }[];
  };
  questions: GradingQuestion[];
  history: {
    id: number;
    action: string;
    actor_name?: string | null;
    comment?: string | null;
    created_at: string;
    previous_value?: string | null;
    new_value?: string | null;
  }[];
}

export interface ResultRow {
  id: number;
  attempt_id?: number;
  total_marks: number;
  obtained_marks: number;
  percentage: number;
  grade: string | null;
  outcome: Outcome;
  is_published: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  paper_title: string;
  paper_code: string;
  kind: 'EXAM' | 'QUIZ';
  exam_type: ExamType | null;
  academic_year: string | null;
  semester: string | null;
  exam_date: string | null;
  quiz_date: string | null;
  student_name: string;
  student_code: string;
  student_id: number;
  class_name: string | null;
  subject_name: string | null;
  subject_code: string | null;
  submitted_at: string | null;
  attempt_status: AttemptStatus;
  auto_submitted: number;
  graded_by: number | null;
  examiner_name: string | null;
}

export interface ResultStats {
  attempts: number;
  passed: number;
  failed: number;
  pending: number;
  averagePercentage: number;
  highestPercentage: number;
  lowestPercentage: number;
  published: number;
}

export interface ResultDetail {
  result: {
    id: number;
    attemptId: number;
    studentName: string;
    studentCode: string;
    className: string | null;
    subjectName: string | null;
    paperTitle: string;
    paperCode: string;
    kind: 'EXAM' | 'QUIZ';
    examType: ExamType | null;
    academicYear: string | null;
    semester: string | null;
    examDate: string | null;
    submittedAt: string | null;
    totalMarks: number;
    obtainedMarks: number;
    percentage: number;
    grade: string | null;
    outcome: Outcome;
    isPublished: boolean;
    publishedAt: string | null;
    examinerName: string | null;
    attemptStatus: AttemptStatus;
    autoSubmitted: boolean;
    objectiveMarks: number | null;
    subjectiveMarks: number | null;
    integrityFlags: { type: string; detail: string }[];
    passMarks: number | null;
  };
  breakdown: {
    questionId: number;
    position: number;
    type: QuestionType;
    text: string;
    marks: number;
    objective: boolean;
    options: { label: string; text: string }[];
    answerText: string | null;
    selectedOptions: string[];
    awardedMarks: number | null;
    isCorrect: boolean | null;
    comment: string | null;
    correctAnswer: Record<string, unknown> | null;
    explanation: string | null;
  }[];
}

export interface AttemptPaper {
  attempt: {
    id: number;
    attemptNo: number;
    status: AttemptStatus;
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
    integrityFlags: { type: string; detail: string }[];
    studentName: string;
    studentCode: string;
  };
  serverTime: string;
  remainingSeconds: number;
  graceSeconds: number;
  questions: {
    questionId: number;
    position: number;
    type: QuestionType;
    text: string;
    marks: number;
    negativeMarks: number;
    objective: boolean;
    options: { label: string; text: string }[];
    answerConfig: Record<string, unknown>;
  }[];
  answers: Record<
    string,
    { questionId: number; selectedOptions: string[]; answerText: string | null; isFlagged: boolean; updatedAt: string | null }
  >;
  progress: { answered: number; unanswered: number; flagged: number; total: number };
}

export interface StartAttemptResult {
  attemptId: number;
  targetKind: 'exam' | 'quiz';
  targetId: number;
  attemptNo: number;
  status: AttemptStatus;
  startedAt: string;
  expiresAt: string;
  serverTime: string;
  remainingSeconds: number;
  resumed: boolean;
}

export interface SubmissionResult {
  attemptId: number;
  status: AttemptStatus;
  objectiveMarks: number;
  subjectiveMarks: number;
  totalObtained: number;
  maxMarks: number;
  percentage: number;
  grade: string | null;
  outcome: Outcome;
  requiresManualGrading: boolean;
  resultId: number | null;
  resultPublished: boolean;
}

export interface AuditLogRow {
  id: number;
  action: string;
  category: string;
  resource_type: string | null;
  resource_id: string | null;
  description: string;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  actor_name: string | null;
  actor_role: string | null;
  user_id: number | null;
  institution_id: number | null;
  institution_name: string | null;
}

export interface NotificationRow {
  id: number;
  user_id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface ReportTable {
  title: string;
  subtitle?: string;
  institution?: string;
  generatedAt: string;
  generatedBy?: string;
  columns: { key: string; header: string; width?: number; align?: 'left' | 'right' }[];
  rows: Record<string, string | number | boolean | null>[];
}

export interface GradingScheme {
  id: number;
  institution_id: number | null;
  name: string;
  description: string | null;
  is_default: number;
  pass_percentage: number;
  created_at: string;
  updated_at: string;
  bands: {
    id?: number;
    scheme_id?: number;
    grade: string;
    min_percentage: number;
    max_percentage: number;
    points: number | null;
    remark: string | null;
    position: number;
  }[];
}

export interface UserRow {
  id: number;
  full_name: string;
  email: string;
  status: string;
  phone: string | null;
  last_login_at: string | null;
  created_at: string;
  institution_id: number | null;
  email_verified_at: string | null;
  role: RoleCode;
  role_name: string;
  institution_name: string | null;
  locked: number;
}

export interface RoleRow {
  id: number;
  code: RoleCode;
  name: string;
  description: string;
  scope: string;
  permissionCount: number;
  definition: { name: string; description: string; scope: string };
}

export interface PermissionRow {
  code: string;
  description: string;
  category: string;
}

/** Actionable exception raised by the dashboard aggregations, with a link to resolve it. */
export interface DashboardAttention {
  key: string;
  severity: 'info' | 'warning' | 'danger';
  title: string;
  detail: string;
  link: string;
}

/** Period-over-period movement for a headline figure. */
export interface DashboardDelta {
  current: number;
  previous: number;
  days: number;
  changePercent: number | null;
}

export interface StudentDashboard {
  student: {
    id: number;
    student_code: string;
    class_id: number | null;
    full_name: string;
    class_name: string | null;
    department_name: string | null;
    institution_name: string;
  };
  serverTime: string;
  stats: {
    total_attempts: number;
    in_progress: number;
    awaiting_release: number;
    graded: number;
    passed: number;
    failed: number;
    average_percentage: number;
    best_percentage: number;
    availableExams: number;
    upcomingExams: number;
    availableQuizzes: number;
  };
  attention: DashboardAttention[];
  nextDeadline: {
    kind: 'EXAM' | 'QUIZ';
    id: number;
    title: string;
    paper_code: string | null;
    subject_name: string | null;
    due_at: string;
    start_at: string | null;
    action: 'start' | 'resume';
  } | null;
  subjectPerformance: {
    subject: string;
    results: number;
    average_percentage: number;
    passed: number;
    best_percentage: number;
  }[];
  scoreTrend: { at: string; percentage: number; grade: string | null; paper_title: string; label: string }[];
  limitReached: { kind: 'EXAM' | 'QUIZ'; id: number; title: string }[];
  availableExams: {
    id: number;
    name: string;
    code: string;
    start_at: string;
    end_at: string;
    duration_minutes: number;
    total_marks: number;
    status: ExamStatus;
    subject_name: string;
    max_attempts: number;
    my_attempts: number;
    in_progress: number;
  }[];
  upcomingExams: {
    id: number;
    name: string;
    code: string;
    start_at: string;
    end_at: string;
    duration_minutes: number;
    total_marks: number;
    status: ExamStatus;
    subject_name: string;
  }[];
  availableQuizzes: {
    id: number;
    title: string;
    time_limit_minutes: number;
    pass_percentage: number;
    available_from: string;
    available_until: string;
    max_attempts: number;
    subject_name: string;
    my_attempts: number;
  }[];
  recentResults: {
    id: number;
    percentage: number;
    grade: string | null;
    outcome: Outcome;
    obtained_marks: number;
    total_marks: number;
    is_published: number;
    paper_title: string;
    date: string;
    subject_name: string | null;
  }[];
  history: {
    id: number;
    status: AttemptStatus;
    started_at: string;
    submitted_at: string | null;
    obtained_marks: number | null;
    max_marks: number;
    percentage: number | null;
    grade: string | null;
    paper_title: string;
    kind: 'EXAM' | 'QUIZ';
    is_published: number | null;
    outcome: Outcome | null;
    result_id: number | null;
  }[];
  unreadNotifications: number;
}

export interface AdminDashboard {
  serverTime: string;
  /** The institution this dashboard describes — not necessarily the viewer's own. */
  institution: { id: number; name: string; code: string; type: string; is_demo: number } | null;
  counts: Record<string, number>;
  passRate: { graded: number; passed: number; failed: number; average_percentage: number; passRate: number };
  recentActivity: AuditLogRow[];
  performanceBySubject: { subject: string; results: number; average_percentage: number; passed: number }[];
  gradeDistribution: { grade: string; count: number }[];
  submissionsByDay: { day: string; submissions: number }[];
  classPerformance: { id: number; class_name: string; students: number; average_percentage: number }[];
  attention: DashboardAttention[];
  gradingBacklog: {
    ungraded_answers: number;
    attempts: number;
    oldest_waiting: string | null;
    /** Submissions in the grading queue (submitted or under review). */
    queue: number;
    /** Of those, the ones grading never produced a result row for. */
    awaiting_results: number;
  };
  paperIntegrity: {
    exams_without_questions: number;
    scheduled_without_candidates: number;
    pending_accounts: number;
    exams_ending_soon: number;
    /** Papers whose pass mark falls inside a failing band of their grading scale. */
    pass_mark_in_failing_band: number;
  };
  /** Named papers behind `paperIntegrity.pass_mark_in_failing_band`. */
  passMarkConflicts: {
    id: number;
    name: string;
    code: string;
    total_marks: number;
    pass_marks: number;
    pass_percentage: number;
    lowest_passing_band: number;
  }[];
  examPipeline: { status: ExamStatus; count: number; window_open: number }[];
  upcomingExams: {
    id: number;
    name: string;
    code: string;
    status: ExamStatus;
    start_at: string;
    end_at: string;
    duration_minutes: number;
    total_marks: number;
    max_attempts: number;
    subject_name: string | null;
    class_name: string | null;
    question_count: number;
    assignment_count: number;
  }[];
  examPerformance: {
    id: number;
    name: string;
    code: string;
    status: ExamStatus;
    total_marks: number;
    pass_marks: number;
    subject_name: string | null;
    attempts: number;
    published: number;
    average_percentage: number;
    pass_rate: number;
  }[];
  atRiskStudents: {
    id: number;
    student_code: string;
    full_name: string;
    class_name: string | null;
    graded_results: number;
    average_percentage: number;
  }[];
  deltas: { submissions: DashboardDelta; publishedResults: DashboardDelta };
}

export interface TeacherDashboard {
  serverTime: string;
  scope: { institutionId: number; role: RoleCode };
  activeExams: (Exam & { attempts: number; live: number })[];
  upcomingExams: (Exam & { assignments: number })[];
  drafts: Exam[];
  recentSubmissions: {
    id: number;
    status: AttemptStatus;
    submitted_at: string | null;
    obtained_marks: number | null;
    max_marks: number;
    percentage: number | null;
    auto_submitted: number;
    paper_title: string | null;
    student_name: string;
    student_code: string;
    kind: 'EXAM' | 'QUIZ';
    grade: string | null;
    is_published: number | null;
    ungraded: number;
  }[];
  awaitingGrading: { attempts: number; ungraded_answers: number };
  examStats: { total_exams: number; active: number; draft: number; published: number };
  averages: { average_percentage: number; graded_results: number };
  questionBankStats: { active_questions: number; my_questions: number; banks: number; easy: number; medium: number; hard: number };
  publishedResults: { published: number; passed: number; failed: number };
  weeklyActivity: { day: string; submissions: number }[];
  attention: DashboardAttention[];
  gradingBacklog: { oldest_submission: string | null; attempts: number; ungraded_answers: number };
  paperHealth: { exams_without_questions: number; scheduled_without_candidates: number; exams_ending_soon: number };
  examPerformance: {
    id: number;
    name: string;
    code: string;
    status: ExamStatus;
    total_marks: number;
    pass_marks: number;
    subject_name: string | null;
    class_name: string | null;
    question_count: number;
    assignment_count: number;
    attempts: number;
    average_percentage: number;
    pass_rate: number;
  }[];
}

export interface PlatformDashboard {
  serverTime: string;
  counts: Record<string, number>;
  attention: DashboardAttention[];
  deltas: { submissions: DashboardDelta; signups: DashboardDelta };
  loginActivity: { day: string; successful: number; failed: number }[];
  accountMix: { status: string; count: number }[];
  institutionStatus: { status: string; count: number }[];
  submissionsByDay: { day: string; submissions: number }[];
  institutionBreakdown: {
    id: number;
    name: string;
    code: string;
    status: string;
    is_demo: number;
    students: number;
    teachers: number;
    exams: number;
    attempts: number;
  }[];
  recentAudit: AuditLogRow[];
}

export interface SystemInfo {
  application: string;
  environment: string;
  schemaVersion: string;
  serverTime: string;
  demoDataEnabled: boolean;
  counts: { users: number; audit_entries: number; active_sessions: number };
  limits: {
    loginMaxAttempts: number;
    loginLockMinutes: number;
    sessionTtlHours: number;
    attemptClockGraceSeconds: number;
  };
}

export interface ExamMonitor {
  exam: Exam;
  summary?: Record<string, number | string>;
  attempts?: ExamAttemptRow[];
  [key: string]: unknown;
}

export interface InstitutionSetting {
  institutionId: number;
  settings: Record<string, unknown>;
}
