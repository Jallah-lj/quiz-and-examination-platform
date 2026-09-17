import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import DashboardPage from './DashboardPage';
import PlatformDashboardPage from './PlatformDashboardPage';
import type { AdminDashboard, PlatformDashboard, StudentDashboard, TeacherDashboard } from '../../types';

const user = {
  id: 1,
  fullName: 'Ada Admin',
  email: 'ada@example.test',
  role: 'institution_admin' as const,
  institution: { id: 2, name: 'Northgate Institute of Technology' },
};

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user, hasPermission: () => true }),
}));

/** Candidate payload: one open paper, one released result and a live attempt. */
function studentPayload(): StudentDashboard {
  return {
    student: {
      id: 9,
      student_code: 'NIT-2025-0009',
      class_id: 1,
      full_name: 'Sofia Mensah',
      class_name: 'BSc Computer Science — Year 2',
      department_name: 'Computing',
      institution_name: 'Northgate Institute of Technology',
    },
    serverTime: '2026-09-17T09:00:00.000Z',
    stats: {
      total_attempts: 3,
      in_progress: 1,
      awaiting_release: 1,
      graded: 1,
      passed: 1,
      failed: 0,
      average_percentage: 62.5,
      best_percentage: 62.5,
      availableExams: 1,
      upcomingExams: 1,
      availableQuizzes: 0,
    },
    attention: [
      {
        key: 'resume',
        severity: 'warning',
        title: '1 attempt(s) still running',
        detail: 'The server clock keeps running whether or not the page is open.',
        link: '/my-attempts',
      },
    ],
    nextDeadline: {
      kind: 'EXAM',
      id: 5,
      title: 'Midterm Examination — Data Structures',
      paper_code: 'CS201-MID',
      subject_name: 'Data Structures',
      due_at: '2026-09-17T10:30:00.000Z',
      start_at: '2026-09-17T09:30:00.000Z',
      action: 'resume',
    },
    subjectPerformance: [
      { subject: 'Probability & Statistics', results: 1, average_percentage: 62.5, passed: 1, best_percentage: 62.5 },
    ],
    scoreTrend: [{ at: '2026-09-10T09:00:00.000Z', percentage: 62.5, grade: 'B', paper_title: 'Statistics CA', label: '09-10' }],
    limitReached: [],
    availableExams: [],
    upcomingExams: [],
    availableQuizzes: [],
    recentResults: [],
    history: [],
    unreadNotifications: 0,
  };
}

/** Administrator payload covering the pipeline, movement and exception panels. */
function adminPayload(): AdminDashboard {
  return {
    serverTime: '2026-09-17T09:00:00.000Z',
    counts: {
      students: 30,
      teachers: 5,
      subjects: 6,
      classes: 3,
      departments: 3,
      exams: 3,
      active_exams: 1,
      questions: 100,
      quizzes: 5,
      live_attempts: 2,
      awaiting_grading: 0,
      published_results: 10,
    },
    // Nine passes and one failure is what the stored results actually say; the grade
    // scale separately awards an F to anything under 50%, which is why one paper that
    // passed its 45% pass mark is still graded F (see passMarkConflicts below).
    passRate: { graded: 10, passed: 9, failed: 1, average_percentage: 53.25, passRate: 90 },
    recentActivity: [],
    performanceBySubject: [{ subject: 'Probability & Statistics', results: 10, average_percentage: 53.25, passed: 9 }],
    gradeDistribution: [
      { grade: 'C', count: 2 },
      { grade: 'D', count: 6 },
      { grade: 'F', count: 2 },
    ],
    submissionsByDay: [
      { day: '2026-09-15', submissions: 0 },
      { day: '2026-09-16', submissions: 6 },
    ],
    classPerformance: [{ id: 3, class_name: 'BSc Applied Mathematics — Year 1', students: 10, average_percentage: 53.25 }],
    attention: [
      {
        key: 'pending',
        severity: 'info',
        title: '1 account(s) awaiting approval',
        detail: 'Self-registered accounts cannot sign in until an administrator activates them.',
        link: '/users?status=pending',
      },
      {
        key: 'no-questions',
        severity: 'danger',
        title: '1 paper(s) without questions',
        detail: 'A paper cannot be scheduled until questions are added.',
        link: '/examinations?status=DRAFT',
      },
    ],
    gradingBacklog: { ungraded_answers: 0, attempts: 0, oldest_waiting: null, queue: 3, awaiting_results: 0 },
    paperIntegrity: {
      exams_without_questions: 1,
      scheduled_without_candidates: 0,
      pending_accounts: 1,
      exams_ending_soon: 0,
      pass_mark_in_failing_band: 1,
    },
    passMarkConflicts: [
      {
        id: 3,
        name: 'Statistics Continuous Assessment',
        code: 'STA-CA1',
        total_marks: 20,
        pass_marks: 9,
        pass_percentage: 45,
        lowest_passing_band: 50,
      },
    ],
    examPipeline: [
      { status: 'DRAFT', count: 1, window_open: 0 },
      { status: 'ACTIVE', count: 1, window_open: 1 },
      { status: 'PUBLISHED', count: 1, window_open: 0 },
    ],
    upcomingExams: [],
    examPerformance: [
      {
        id: 3,
        name: 'Continuous Assessment — Probability',
        code: 'MTH210-CA-2025',
        status: 'PUBLISHED',
        total_marks: 40,
        pass_marks: 20,
        subject_name: 'Probability & Statistics',
        attempts: 10,
        published: 10,
        average_percentage: 53.25,
        pass_rate: 90,
      },
    ],
    atRiskStudents: [],
    deltas: {
      submissions: { current: 6, previous: 4, days: 14, changePercent: 50 },
      publishedResults: { current: 10, previous: 0, days: 30, changePercent: null },
    },
  };
}


/** Examiner payload: one live paper with a written answer waiting to be marked. */
function teacherPayload(): TeacherDashboard {
  return {
    serverTime: '2026-09-17T09:00:00.000Z',
    scope: { institutionId: 2, role: 'teacher' },
    activeExams: [
      {
        id: 5,
        name: 'Midterm Examination — Data Structures',
        code: 'CS201-MID',
        start_at: '2026-09-15T09:00:00.000Z',
        end_at: '2026-09-24T09:00:00.000Z',
        duration_minutes: 60,
        total_marks: 33,
        status: 'ACTIVE',
        subject_name: 'Data Structures',
        class_name: 'BSc Computer Science — Year 2',
        attempts: 6,
        live: 2,
      } as TeacherDashboard['activeExams'][number],
    ],
    upcomingExams: [],
    drafts: [],
    recentSubmissions: [
      {
        id: 20,
        status: 'UNDER_REVIEW',
        submitted_at: '2026-09-16T23:40:00.000Z',
        obtained_marks: 12,
        max_marks: 33,
        percentage: 36.36,
        auto_submitted: 0,
        paper_title: 'Midterm Examination — Data Structures',
        student_name: 'Farida Petrov',
        student_code: 'NIT-2025-0006',
        kind: 'EXAM',
        grade: null,
        is_published: null,
        ungraded: 2,
      },
    ],
    awaitingGrading: { attempts: 1, ungraded_answers: 2 },
    examStats: { total_exams: 2, active: 1, draft: 1, published: 0 },
    averages: { average_percentage: 53.25, graded_results: 10 },
    questionBankStats: { active_questions: 100, my_questions: 20, banks: 5, easy: 20, medium: 53, hard: 27 },
    publishedResults: { published: 10, passed: 9, failed: 1 },
    weeklyActivity: [
      { day: '2026-09-16', submissions: 0 },
      { day: '2026-09-17', submissions: 6 },
    ],
    attention: [
      {
        key: 'explanations',
        severity: 'info',
        title: '3 of your questions have no explanation',
        detail: 'Explanations are shown to candidates during review when the paper allows it.',
        link: '/questions?mine=true&missingExplanation=true',
      },
    ],
    gradingBacklog: { oldest_submission: '2026-09-16T23:40:00.000Z', attempts: 1, ungraded_answers: 2 },
    paperHealth: { exams_without_questions: 0, scheduled_without_candidates: 0, exams_ending_soon: 1 },
    examPerformance: [
      {
        id: 5,
        name: 'Midterm Examination — Data Structures',
        code: 'CS201-MID',
        status: 'ACTIVE',
        total_marks: 33,
        pass_marks: 17,
        subject_name: 'Data Structures',
        class_name: 'BSc Computer Science — Year 2',
        question_count: 12,
        assignment_count: 1,
        attempts: 6,
        average_percentage: 0,
        pass_rate: 0,
      },
    ],
  };
}

/** Platform payload with one tenant and one exception. */
function platformPayload(): PlatformDashboard {
  return {
    serverTime: '2026-09-17T09:00:00.000Z',
    counts: {
      institutions: 1,
      active_institutions: 1,
      demo_institutions: 1,
      users: 39,
      active_users: 38,
      students: 32,
      teachers: 5,
      exams: 3,
      active_exams: 1,
      attempts: 53,
      live_attempts: 0,
      questions: 100,
      active_sessions: 4,
    },
    attention: [
      {
        key: 'pending-accounts',
        severity: 'warning',
        title: '1 account(s) awaiting approval',
        detail: 'These registrations stay inactive until an administrator approves them.',
        link: '/users?status=pending',
      },
    ],
    deltas: {
      submissions: { current: 53, previous: 0, days: 14, changePercent: null },
      signups: { current: 39, previous: 0, days: 30, changePercent: null },
    },
    loginActivity: [{ day: '2026-09-17', successful: 17, failed: 2 }],
    accountMix: [
      { status: 'active', count: 38 },
      { status: 'pending', count: 1 },
    ],
    institutionStatus: [{ status: 'active', count: 1 }],
    submissionsByDay: [{ day: '2026-09-17', submissions: 0 }],
    institutionBreakdown: [
      {
        id: 2,
        name: 'Northgate Institute of Technology',
        code: 'NIT',
        status: 'active',
        is_demo: 1,
        students: 32,
        teachers: 5,
        exams: 3,
        attempts: 53,
      },
    ],
    recentAudit: [],
  };
}

function installFetch(payload: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/dashboard/')) {
      return new Response(JSON.stringify({ data: payload }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `No handler for ${url}` } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDashboard(role: 'institution_admin' | 'student') {
  user.role = role as typeof user.role;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('candidate dashboard', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leads with the next deadline, the work queue and real score figures', async () => {
    installFetch(studentPayload());
    renderDashboard('student');

    const banner = await screen.findByRole('region', { name: 'Next deadline' });
    expect(within(banner).getByText(/Resume: Midterm Examination — Data Structures/)).toBeInTheDocument();
    // The closing time and the time left are stated in words, not only in colour.
    expect(within(banner).getByText(/closes/)).toBeInTheDocument();
    expect(within(banner).getByText('1 hour remaining')).toBeInTheDocument();

    // Exceptions are labelled in text, never by colour alone.
    expect(screen.getByText('1 attempt(s) still running')).toBeInTheDocument();
    expect(screen.getByText('Action recommended')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Resolve' })).toHaveAttribute('href', '/my-attempts');

    const subjectRow = screen.getByRole('row', { name: /Probability & Statistics/ });
    // Average and best per subject are both shown, from the released results only.
    expect(within(subjectRow).getAllByText('62.50%')).toHaveLength(2);
    expect(screen.getByText(/1 graded result/)).toBeInTheDocument();
  });
});

describe('institution administrator dashboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the examination pipeline, period movement and exception queue', async () => {
    installFetch(adminPayload());
    renderDashboard('institution_admin');

    // Pipeline stages are counted and named.
    const pipeline = await screen.findByRole('list', { name: /lifecycle status/i });
    expect(within(pipeline).getByText('Under review')).toBeInTheDocument();
    expect(within(pipeline).getAllByText('1')).toHaveLength(3);

    // Movement is described in words; an absent earlier period is stated, not invented.
    expect(screen.getByText(/Up 50% versus the previous last 14 days/)).toBeInTheDocument();
    expect(screen.getByText(/10 in the last 30 days · no comparable earlier period/)).toBeInTheDocument();

    // Structural checks and the exception queue carry the numbers from the API.
    expect(screen.getByText('Papers without questions')).toBeInTheDocument();
    // The card reports the whole queue, not just submissions with unmarked written answers.
    expect(screen.getByText('Awaiting results')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Nothing needs marking by hand')).toBeInTheDocument();
    // The pass rate names its failures, and the grade scale explains the F bands.
    expect(screen.getByText('9 passed · 1 failed of 10 graded results')).toBeInTheDocument();
    expect(screen.getByText('Every graded result, awarded on the institution grading scale.')).toBeInTheDocument();
    // A paper that can be passed with a failing grade is reported with its numbers.
    expect(screen.getByText('Pass mark inside a failing grade band')).toBeInTheDocument();
    expect(
      screen.getByText('Statistics Continuous Assessment (passes at 45%, graded F below 50%)'),
    ).toBeInTheDocument();
    expect(screen.getByText('1 paper(s) without questions')).toBeInTheDocument();
    expect(screen.getByText('Action required')).toBeInTheDocument();

    // Outcomes table shows a real pass rate and links to the filtered result list.
    const outcomes = screen.getByRole('row', { name: /Continuous Assessment — Probability/ });
    expect(within(outcomes).getByText('90%')).toBeInTheDocument();
    expect(within(outcomes).getByRole('link', { name: 'Results' })).toHaveAttribute('href', '/results?examId=3');

    // Grade distribution: every band gets its own colour, and the figures sit with their labels.
    const gradeCard = screen.getByText('Grade distribution').closest('.card') as HTMLElement;
    const arcs = Array.from(gradeCard.querySelectorAll('circle')).map((node) => node.getAttribute('class'));
    expect(arcs).toHaveLength(3);
    expect(new Set(arcs).size).toBe(3);
    const legend = Array.from(gradeCard.querySelectorAll('.chart__legend li')).map((row) => ({
      label: row.querySelector('.chart__legend-label')?.textContent,
      value: row.querySelector('.chart__legend-value')?.textContent,
    }));
    expect(legend).toEqual([
      { label: 'C', value: '2 (20%)' },
      { label: 'D', value: '6 (60%)' },
      { label: 'F', value: '2 (20%)' },
    ]);
    // The ring states the total it is drawn from.
    expect(within(gradeCard).getByText('10')).toBeInTheDocument();

    // The two chart panels share one proportional band, not two squeezed halves.
    const band = gradeCard.parentElement as HTMLElement;
    expect(band.className).toContain('dashboard-charts');
    expect(within(band).getByText('Submissions over time')).toBeInTheDocument();

    // A panel with no qualifying records explains why instead of showing an empty chart.
    expect(screen.getByText('No candidate is below the pass mark')).toBeInTheDocument();
  });
});

describe('examiner dashboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows delivery readiness, the marking queue and the data-quality exception', async () => {
    installFetch(teacherPayload());
    renderDashboard('teacher' as 'institution_admin');

    // Papers carry readiness for both questions and candidate assignments.
    const papers = await screen.findAllByRole('row', { name: /Midterm Examination — Data Structures/ });
    // The same paper appears in "Your papers" and in the marking queue; the readiness
    // badges belong to the first.
    const paperRow = papers[0];
    expect(within(paperRow).getByText('12 question(s)')).toBeInTheDocument();
    expect(within(paperRow).getByText('1 assignment(s)')).toBeInTheDocument();
    expect(within(paperRow).getByRole('link', { name: 'Monitor' })).toHaveAttribute('href', '/examinations/5/monitor');

    // The queue names the candidate and links straight to marking.
    const queueRow = screen.getByRole('row', { name: /Farida Petrov/ });
    expect(within(queueRow).getByText('2 answer(s)')).toBeInTheDocument();
    expect(within(queueRow).getByRole('link', { name: 'Mark' })).toHaveAttribute('href', '/grading/attempts/20');

    // The data-quality exception links to the filtered question list.
    expect(screen.getByText('3 of your questions have no explanation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Resolve' })).toHaveAttribute(
      'href',
      '/questions?mine=true&missingExplanation=true',
    );
    // Delivery checks state their numbers in text.
    expect(screen.getByText('Closing within 24 hours')).toBeInTheDocument();
  });
});

  it('drills into one institution on request instead of showing a page of zeros', async () => {
    // The unscoped institution endpoint answers 422 for platform staff; if this page ever
    // requests it while nothing is selected, the drill-through is broken.
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/dashboard/platform')) {
        return new Response(JSON.stringify({ data: platformPayload() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/dashboard/admin')) {
        return url.includes('institutionId=2')
          ? new Response(JSON.stringify({ data: adminPayload() }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(
              JSON.stringify({
                error: {
                  code: 'UNPROCESSABLE',
                  message: 'Select an institution to view its dashboard.',
                },
              }),
              { status: 422, headers: { 'content-type': 'application/json' } },
            );
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: url } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/platform']}>
          <PlatformDashboardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const picker = await screen.findByLabelText('Institution');
    expect(screen.getByText(/Nothing is shown until an institution is selected/i)).toBeInTheDocument();
    // Nothing institution-scoped is fetched until a tenant is chosen.
    expect(calls.some((url) => url.includes('/api/dashboard/admin'))).toBe(false);

    await user.selectOptions(picker, '2');

    // Real figures from the selected tenant, aggregated server-side.
    expect(await screen.findByText('Papers without questions')).toBeInTheDocument();
    expect(screen.getByText('1 paper(s) without questions')).toBeInTheDocument();
    expect(screen.getByText(/Up 50% versus the previous last 14 days/)).toBeInTheDocument();
    expect(calls.some((url) => url.includes('/api/dashboard/admin?institutionId=2'))).toBe(true);

    // Returning to the overview clears the tenant view again.
    await user.click(screen.getByRole('button', { name: /back to platform overview/i }));
    await waitFor(() => expect(screen.queryByText('Papers without questions')).not.toBeInTheDocument());
    expect(calls.filter((url) => url.includes('/api/dashboard/admin') && !url.includes('institutionId=2'))).toEqual([]);
  });

describe('platform dashboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports platform exceptions, institution status and where activity happens', async () => {
    installFetch(platformPayload());
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/platform']}>
          <PlatformDashboardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('1 account(s) awaiting approval')).toBeInTheDocument();
    expect(screen.getByText('Account status')).toBeInTheDocument();
    expect(screen.getByText('Pending activation')).toBeInTheDocument();
    expect(screen.getByText('Institution status')).toBeInTheDocument();
    // Movement without a comparable earlier period is stated rather than invented.
    expect(screen.getAllByText(/no comparable earlier period/)).toHaveLength(2);
    // Institution usage is ranked with a real attempt count.
    expect(screen.getAllByText('Northgate Institute of Technology').length).toBeGreaterThan(0);
    expect(screen.getAllByText('53').length).toBeGreaterThan(0);
  });
});
