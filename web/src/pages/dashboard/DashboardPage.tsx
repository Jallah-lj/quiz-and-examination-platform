import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatMark, formatPercentage, formatRelative } from '../../lib/format';
import { Badge, Button, Card, DataTable, Loading, PageHeader, ProgressBar, StatCard, StatusBadge, type Column } from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { BarChart, DonutChart, LineChart } from '../../components/charts';
import { AttentionPanel, DeadlineBanner, PipelineStrip, StatDelta } from '../../components/dashboard';
import { StartAttemptDialog, type StartAttemptTarget } from '../../components/StartAttemptDialog';
import type {
  AdminDashboard,
  StudentDashboard as StudentDashboardData,
  TeacherDashboard as TeacherDashboardData,
} from '../../types';

export default function DashboardPage() {
  const { user } = useAuth();
  if (!user) return <Loading />;
  if (user.role === 'super_admin') return <Navigate to="/platform" replace />;
  if (user.role === 'student') return <StudentDashboard />;
  if (user.role === 'teacher') return <TeacherDashboard />;
  return <AdminDashboardView />;
}

/** `passed / graded` as a percentage, or null when nothing has been graded yet. */
function passRate(passed: number, graded: number): number | null {
  if (graded <= 0) return null;
  return Math.round((passed / graded) * 10000) / 100;
}

/* ------------------------------------------------------------------ candidate */
function StudentDashboard() {
  const { user } = useAuth();
  const [target, setTarget] = useState<StartAttemptTarget | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'student'],
    queryFn: () => api.get<StudentDashboardData>('/dashboard/student'),
    refetchInterval: 60_000,
  });

  if (isLoading) return <Loading label="Loading your dashboard…" />;
  if (error || !data) return <ErrorState message="Your dashboard could not be loaded." onRetry={() => void refetch()} />;

  const { stats } = data;
  const rate = passRate(stats.passed, stats.graded);
  const deadlineExam = data.nextDeadline
    ? data.availableExams.find((exam) => exam.id === data.nextDeadline?.id && exam.in_progress === 0)
    : undefined;
  const trend = data.scoreTrend.map((point) => ({ label: point.label, value: point.percentage }));

  const startExam = (exam: StudentDashboardData['availableExams'][number]) =>
    setTarget({
      kind: 'exam',
      id: exam.id,
      title: exam.name,
      instructions: null,
      durationMinutes: exam.duration_minutes,
      totalMarks: exam.total_marks,
      maxAttempts: exam.max_attempts,
      attemptsUsed: exam.my_attempts,
      endAt: exam.end_at,
    });

  return (
    <div className="page">
      <PageHeader
        title={`Welcome, ${user?.fullName.split(' ')[0] ?? 'candidate'}`}
        description={
          data.student.class_name
            ? `${data.student.institution_name} · ${data.student.class_name} · ${data.student.student_code}`
            : `${data.student.institution_name} · ${data.student.student_code}`
        }
        actions={
          <>
            <Link className="btn" to="/my-attempts">
              Attempt history
            </Link>
            {data.unreadNotifications > 0 ? (
              <Link className="btn" to="/notifications">
                Notifications
                <Badge tone="warning">{data.unreadNotifications}</Badge>
              </Link>
            ) : null}
          </>
        }
      />

      <DeadlineBanner
        deadline={data.nextDeadline}
        serverTime={data.serverTime}
        // "Start now" is only offered when the paper really is open on this dashboard;
        // otherwise the banner links to the examination details instead.
        onStart={deadlineExam ? () => startExam(deadlineExam) : undefined}
      />

      <AttentionPanel items={data.attention} />

      <div className="stat-grid">
        <StatCard
          label="Open examinations"
          value={stats.availableExams}
          tone="accent"
          meta={`${stats.availableQuizzes} quiz${stats.availableQuizzes === 1 ? '' : 'zes'} open · ${stats.upcomingExams} upcoming`}
        />
        <StatCard
          label="Average score"
          value={stats.graded > 0 ? formatPercentage(stats.average_percentage) : 'Not released yet'}
          meta={
            stats.graded > 0
              ? `${stats.graded} graded result${stats.graded === 1 ? '' : 's'}`
              : `${stats.awaiting_release} awaiting release`
          }
        />
        <StatCard
          label="Best score"
          value={stats.graded > 0 ? formatPercentage(stats.best_percentage) : '—'}
          tone={stats.graded > 0 && stats.best_percentage >= 50 ? 'success' : 'neutral'}
          meta="Across released results"
        />
        <StatCard
          label="Pass rate"
          value={rate === null ? '—' : formatPercentage(rate)}
          tone={rate === null ? 'neutral' : rate >= 50 ? 'success' : 'warning'}
          meta={`${stats.passed} passed · ${stats.failed} failed`}
        />
      </div>

      <div className="split-2">
        <Card
          title="Score progression"
          description="Released results in the order they were taken. Only published marks appear here."
        >
          <LineChart data={trend} ariaLabel="Percentage scored in each released assessment, oldest first" />
        </Card>
        <Card title="Performance by subject" flush>
          {data.subjectPerformance.length === 0 ? (
            <div className="empty-state">
              <h3>No released results yet</h3>
              <p>
                Once your institution publishes a result, subject averages and your best score per subject are shown
                here.
              </p>
            </div>
          ) : (
            <DataTable
              rows={data.subjectPerformance}
              rowKey={(row) => row.subject}
              columns={[
                { key: 'subject', header: 'Subject' },
                { key: 'results', header: 'Results', align: 'right' },
                {
                  key: 'average',
                  header: 'Average',
                  align: 'right',
                  render: (row) => (
                    <div className="progress-cell">
                      <ProgressBar value={row.average_percentage} tone={row.average_percentage >= 50 ? 'success' : 'warning'} />
                      <span>{formatPercentage(row.average_percentage)}</span>
                    </div>
                  ),
                },
                { key: 'passed', header: 'Passed', align: 'right' },
                { key: 'best', header: 'Best', align: 'right', render: (row) => formatPercentage(row.best_percentage) },
              ]}
            />
          )}
        </Card>
      </div>

      <Card
        title="Available now"
        description="Examinations you can start immediately. Starting an attempt begins the countdown and the server keeps the time."
        flush
      >
        {data.availableExams.length === 0 ? (
          <div className="empty-state">
            <h3>No examinations are open</h3>
            <p>When an examiner schedules an examination for your class it will appear here during the availability window.</p>
          </div>
        ) : (
          <DataTable
            rows={data.availableExams}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'name',
                header: 'Examination',
                render: (row) => (
                  <div>
                    <Link to={`/examinations/${row.id}`} className="link-strong">
                      {row.name}
                    </Link>
                    <div className="text-sm text-muted">
                      {row.subject_name} · {row.code}
                    </div>
                  </div>
                ),
              },
              { key: 'duration', header: 'Duration', render: (row) => `${row.duration_minutes} min` },
              { key: 'marks', header: 'Marks', align: 'right', render: (row) => formatMark(row.total_marks) },
              {
                key: 'window',
                header: 'Closes',
                render: (row) => (
                  <span>
                    {formatDateTime(row.end_at)}
                    <div className="text-sm text-muted">{formatRelative(row.end_at)}</div>
                  </span>
                ),
              },
              {
                key: 'attempts',
                header: 'Attempts',
                render: (row) => (
                  <span className="inline">
                    {row.my_attempts} of {row.max_attempts}
                    {row.in_progress ? (
                      <Badge tone="warning" size="lg">
                        In progress
                      </Badge>
                    ) : null}
                  </span>
                ),
              },
              {
                key: 'action',
                header: '',
                align: 'right',
                render: (row) =>
                  row.in_progress ? (
                    <Link className="btn btn--primary btn--sm" to={`/my-attempts`}>
                      Resume
                    </Link>
                  ) : row.my_attempts >= row.max_attempts ? (
                    <span className="text-muted text-sm">Attempt limit reached</span>
                  ) : (
                    <Button variant="primary" size="sm" onClick={() => startExam(row)}>
                      Start
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <div className="split-2">
        <Card title="Open quizzes" description="Short assessments set by your examiners." flush>
          {data.availableQuizzes.length === 0 ? (
            <div className="empty-state">
              <h3>No quizzes open</h3>
              <p>Quizzes assigned to you appear here while their availability window is open.</p>
            </div>
          ) : (
            <DataTable
              rows={data.availableQuizzes}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'title',
                  header: 'Quiz',
                  render: (row) => (
                    <div>
                      <Link to={`/quizzes/${row.id}`} className="link-strong">
                        {row.title}
                      </Link>
                      <div className="text-sm text-muted">{row.subject_name}</div>
                    </div>
                  ),
                },
                { key: 'time', header: 'Time', render: (row) => `${row.time_limit_minutes} min` },
                { key: 'window', header: 'Closes', render: (row) => formatDateTime(row.available_until) },
                { key: 'pass', header: 'Pass', align: 'right', render: (row) => `${row.pass_percentage}%` },
                {
                  key: 'action',
                  header: '',
                  align: 'right',
                  render: (row) =>
                    row.my_attempts >= row.max_attempts ? (
                      <span className="text-muted text-sm">Attempt limit reached</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() =>
                          setTarget({
                            kind: 'quiz',
                            id: row.id,
                            title: row.title,
                            durationMinutes: row.time_limit_minutes,
                            maxAttempts: row.max_attempts,
                            attemptsUsed: row.my_attempts,
                            endAt: row.available_until,
                          })
                        }
                      >
                        Start quiz
                      </Button>
                    ),
                },
              ]}
            />
          )}
        </Card>

        <Card title="Recently released results" flush>
          {data.recentResults.length === 0 ? (
            <div className="empty-state">
              <h3>No results released</h3>
              <p>Results appear here once your institution publishes them.</p>
            </div>
          ) : (
            <DataTable
              rows={data.recentResults}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'paper',
                  header: 'Assessment',
                  render: (row) => (
                    <div>
                      <Link to={`/results/${row.id}`} className="link-strong">
                        {row.paper_title}
                      </Link>
                      <div className="text-sm text-muted">{formatDate(row.date)}</div>
                    </div>
                  ),
                },
                {
                  key: 'marks',
                  header: 'Score',
                  align: 'right',
                  render: (row) => `${formatMark(row.obtained_marks)} / ${formatMark(row.total_marks)}`,
                },
                { key: 'percentage', header: '%', align: 'right', render: (row) => formatPercentage(row.percentage) },
                { key: 'grade', header: 'Grade', render: (row) => row.grade ?? '—' },
                { key: 'outcome', header: 'Outcome', render: (row) => <StatusBadge status={row.outcome} /> },
              ]}
            />
          )}
        </Card>
      </div>

      <Card
        title="Scheduled examinations"
        description="Papers already timetabled for you. The window opens automatically at the published start time."
        flush
      >
        {data.upcomingExams.length === 0 ? (
          <div className="empty-state">
            <h3>Nothing scheduled</h3>
            <p>Examinations scheduled for the future will be listed here with their opening time.</p>
          </div>
        ) : (
          <DataTable
            rows={data.upcomingExams}
            rowKey={(row) => row.id}
            columns={[
              { key: 'name', header: 'Examination', render: (row) => row.name },
              { key: 'subject', header: 'Subject', render: (row) => row.subject_name },
              { key: 'opens', header: 'Opens', render: (row) => `${formatDateTime(row.start_at)} (${formatRelative(row.start_at)})` },
              { key: 'closes', header: 'Closes', render: (row) => formatDateTime(row.end_at) },
              { key: 'duration', header: 'Duration', render: (row) => `${row.duration_minutes} min` },
              { key: 'marks', header: 'Marks', align: 'right', render: (row) => formatMark(row.total_marks) },
            ]}
          />
        )}
      </Card>

      <Card
        title="Attempt history"
        description="Every attempt you have started, including those whose results are still withheld."
        flush
        actions={
          <Link className="btn btn--sm" to="/my-attempts">
            Full history
          </Link>
        }
      >
        <DataTable
          rows={data.history}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'paper',
              header: 'Assessment',
              render: (row) => (
                <div>
                  <strong>{row.paper_title}</strong>
                  <div className="text-sm text-muted">{row.kind === 'EXAM' ? 'Examination' : 'Quiz'}</div>
                </div>
              ),
            },
            { key: 'started', header: 'Started', render: (row) => formatDateTime(row.started_at) },
            { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
            {
              key: 'score',
              header: 'Score',
              align: 'right',
              render: (row) => (row.percentage === null ? '—' : `${formatPercentage(row.percentage)} (${row.grade ?? '—'})`),
            },
            {
              key: 'result',
              header: 'Result',
              align: 'right',
              render: (row) =>
                row.result_id && row.is_published ? (
                  <Link className="btn btn--sm" to={`/results/${row.result_id}`}>
                    View result
                  </Link>
                ) : row.status === 'IN_PROGRESS' ? (
                  <Link className="btn btn--sm" to="/my-attempts">
                    Resume
                  </Link>
                ) : (
                  <span className="text-muted text-sm">Awaiting release</span>
                ),
            },
          ]}
          empty={<p>You have not started any assessment yet.</p>}
        />
      </Card>

      {data.limitReached.length > 0 ? (
        <Card title="Attempt limits reached" description="These assessments allow no further attempts." flush>
          <DataTable
            rows={data.limitReached}
            rowKey={(row) => `${row.kind}-${row.id}`}
            columns={[
              { key: 'title', header: 'Assessment', render: (row) => row.title },
              { key: 'kind', header: 'Type', render: (row) => (row.kind === 'EXAM' ? 'Examination' : 'Quiz') },
              {
                key: 'link',
                header: '',
                align: 'right',
                render: (row) => (
                  <Link className="btn btn--sm" to={row.kind === 'EXAM' ? `/examinations/${row.id}` : `/quizzes/${row.id}`}>
                    Details
                  </Link>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      <StartAttemptDialog target={target} open={Boolean(target)} onClose={() => setTarget(null)} />
    </div>
  );
}

/* -------------------------------------------------------------------- examiner */
function TeacherDashboard() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['dashboard', 'teacher'],
    queryFn: () => api.get<TeacherDashboardData>('/dashboard/teacher'),
    refetchInterval: 120_000,
  });

  if (isLoading) return <Loading label="Loading your dashboard…" />;
  if (error || !data) return <ErrorState message="The dashboard could not be loaded." onRetry={() => void refetch()} />;

  const live = data.activeExams.reduce((sum, exam) => sum + (exam.live ?? 0), 0);
  const oldest = data.gradingBacklog.oldest_submission;

  const submissionColumns: Column<TeacherDashboardData['recentSubmissions'][number]>[] = [
    {
      key: 'student',
      header: 'Candidate',
      render: (row) => (
        <div>
          <strong>{row.student_name}</strong>
          <div className="text-sm text-muted">{row.student_code}</div>
        </div>
      ),
    },
    {
      key: 'paper',
      header: 'Assessment',
      render: (row) => (
        <div>
          {row.paper_title ?? '—'}
          <div className="text-sm text-muted">{row.kind === 'EXAM' ? 'Examination' : 'Quiz'}</div>
        </div>
      ),
    },
    { key: 'submitted', header: 'Submitted', render: (row) => (row.submitted_at ? formatDateTime(row.submitted_at) : '—') },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'ungraded',
      header: 'Unmarked',
      align: 'right',
      render: (row) => (row.ungraded > 0 ? <Badge tone="warning">{row.ungraded} answer(s)</Badge> : <span className="text-muted text-sm">None</span>),
    },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      render: (row) => (row.percentage === null ? '—' : `${formatPercentage(row.percentage)} (${row.grade ?? '—'})`),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (row) => (
        <Link className="btn btn--sm" to={`/grading/attempts/${row.id}`}>
          {row.ungraded > 0 ? 'Mark' : 'Review'}
        </Link>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Examiner dashboard"
        description={`${user?.fullName} · ${user?.institution?.name ?? 'Institution'} · server time ${formatDateTime(data.serverTime)}`}
        actions={
          <>
            <Link className="btn" to="/grading">
              Grading queue
            </Link>
            <Link className="btn btn--primary" to="/examinations/new">
              New examination
            </Link>
          </>
        }
      />

      <AttentionPanel items={data.attention} />

      <div className="stat-grid">
        <StatCard
          label="Active examinations"
          value={data.examStats.active}
          tone="accent"
          meta={`${data.examStats.total_exams} papers · ${live} attempt${live === 1 ? '' : 's'} in progress`}
        />
        <StatCard
          label="Unmarked answers"
          value={data.gradingBacklog.ungraded_answers}
          tone={data.gradingBacklog.ungraded_answers > 0 ? 'warning' : 'neutral'}
          meta={
            oldest
              ? `Oldest submission ${formatRelative(oldest)} · ${data.gradingBacklog.attempts} submission(s)`
              : 'Nothing is waiting on you'
          }
        />
        <StatCard
          label="Average score"
          value={data.averages.graded_results > 0 ? formatPercentage(data.averages.average_percentage) : '—'}
          meta={`${data.averages.graded_results} graded result(s)`}
        />
        <StatCard
          label="Published results"
          value={data.publishedResults.published}
          tone="success"
          meta={`${data.publishedResults.passed} passed · ${data.publishedResults.failed} failed`}
        />
      </div>

      <div className="split-2">
        <Card title="Submissions received" description="Attempts submitted to your papers over the last 14 days.">
          <BarChart
            ariaLabel="Submissions per day over the last two weeks"
            data={data.weeklyActivity.map((point) => ({ label: point.day.slice(5), value: point.submissions }))}
          />
        </Card>
        <Card title="Question bank mix" description="Active questions you can draw on, by difficulty.">
          <DonutChart
            ariaLabel="Active questions by difficulty"
            data={[
              { label: 'Easy', value: data.questionBankStats.easy, tone: 'success' },
              { label: 'Medium', value: data.questionBankStats.medium, tone: 'default' },
              { label: 'Hard', value: data.questionBankStats.hard, tone: 'warning' },
            ]}
          />
          <p className="text-sm text-muted">
            {data.questionBankStats.active_questions} active questions across {data.questionBankStats.banks} banks,{' '}
            {data.questionBankStats.my_questions} authored by you.
          </p>
        </Card>
      </div>

      <Card
        title="Your papers"
        description="Delivery readiness and outcomes for the papers you own or co-teach."
        flush
        actions={
          <Link className="btn btn--sm" to="/examinations">
            All examinations
          </Link>
        }
      >
        {data.examPerformance.length === 0 ? (
          <div className="empty-state">
            <h3>No papers yet</h3>
            <p>Create an examination to get started. Papers stay in draft until you schedule them.</p>
            <Link className="btn btn--primary" to="/examinations/new">
              Create examination
            </Link>
          </div>
        ) : (
          <DataTable
            rows={data.examPerformance}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'name',
                header: 'Paper',
                render: (row) => (
                  <div>
                    <Link to={`/examinations/${row.id}`} className="link-strong">
                      {row.name}
                    </Link>
                    <div className="text-sm text-muted">
                      {row.code}
                      {row.subject_name ? ` · ${row.subject_name}` : ''}
                      {row.class_name ? ` · ${row.class_name}` : ''}
                    </div>
                  </div>
                ),
              },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              {
                key: 'readiness',
                header: 'Readiness',
                render: (row) => (
                  <span className="stacked">
                    <Badge tone={row.question_count > 0 ? 'success' : 'danger'}>{row.question_count} question(s)</Badge>
                    <Badge tone={row.assignment_count > 0 ? 'success' : 'warning'}>{row.assignment_count} assignment(s)</Badge>
                  </span>
                ),
              },
              { key: 'attempts', header: 'Attempts', align: 'right', render: (row) => row.attempts },
              {
                key: 'average',
                header: 'Average',
                align: 'right',
                render: (row) => (row.attempts === 0 ? <span className="text-muted text-sm">No data</span> : formatPercentage(row.average_percentage)),
              },
              {
                key: 'pass',
                header: 'Pass rate',
                align: 'right',
                render: (row) => (row.attempts === 0 ? <span className="text-muted text-sm">No data</span> : `${row.pass_rate}%`),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) => (
                  <div className="inline">
                    <Link className="btn btn--sm" to={`/examinations/${row.id}/monitor`}>
                      Monitor
                    </Link>
                    <Link className="btn btn--sm" to={`/examinations/${row.id}`}>
                      Open
                    </Link>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        title="Marking queue"
        description="The newest submissions across your institution. Results stay withheld until every written answer is marked."
        flush
        actions={
          <>
            <Button size="sm" onClick={() => void refetch()} loading={isFetching}>
              Refresh
            </Button>
            <Link className="btn btn--sm" to="/grading">
              Full queue
            </Link>
          </>
        }
      >
        <DataTable
          columns={submissionColumns}
          rows={data.recentSubmissions}
          rowKey={(row) => row.id}
          empty={<p>No submissions have been received yet.</p>}
        />
      </Card>

      <div className="split-2">
        <Card title="Paper delivery checks" description="Structural problems that stop a paper from running." flush>
          <ul className="check-list">
            <li className="check-list__item">
              <span>Papers without questions</span>
              <Badge tone={data.paperHealth.exams_without_questions > 0 ? 'danger' : 'success'}>
                {data.paperHealth.exams_without_questions}
              </Badge>
            </li>
            <li className="check-list__item">
              <span>Scheduled without candidates</span>
              <Badge tone={data.paperHealth.scheduled_without_candidates > 0 ? 'warning' : 'success'}>
                {data.paperHealth.scheduled_without_candidates}
              </Badge>
            </li>
            <li className="check-list__item">
              <span>Closing within 24 hours</span>
              <Badge tone={data.paperHealth.exams_ending_soon > 0 ? 'warning' : 'success'}>
                {data.paperHealth.exams_ending_soon}
              </Badge>
            </li>
          </ul>
        </Card>

        <Card title="Papers opening soon" flush>
          {data.upcomingExams.length === 0 ? (
            <div className="empty-state">
              <h3>Nothing scheduled</h3>
              <p>Scheduled papers appear here with their opening time and assignments.</p>
            </div>
          ) : (
            <DataTable
              rows={data.upcomingExams}
              rowKey={(row) => row.id}
              columns={[
                {
                  key: 'name',
                  header: 'Paper',
                  render: (row) => (
                    <div>
                      <Link to={`/examinations/${row.id}`} className="link-strong">
                        {row.name}
                      </Link>
                      <div className="text-sm text-muted">{row.subject_name ?? ''}</div>
                    </div>
                  ),
                },
                { key: 'opens', header: 'Opens', render: (row) => formatDateTime(row.start_at) },
                {
                  key: 'assigned',
                  header: 'Assigned',
                  align: 'right',
                  render: (row) => `${row.assignments ?? 0}`,
                },
              ]}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- institution administrator */
function AdminDashboardView() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'admin'],
    queryFn: () => api.get<AdminDashboard>('/dashboard/admin'),
    refetchInterval: 120_000,
  });

  if (isLoading) return <Loading label="Loading institution dashboard…" />;
  if (error || !data) return <ErrorState message="The dashboard could not be loaded." onRetry={() => void refetch()} />;

  const { counts } = data;
  const rate = data.passRate.passRate ?? passRate(data.passRate.passed, data.passRate.graded);
  const oldest = data.gradingBacklog.oldest_waiting;

  return (
    <div className="page">
      <PageHeader
        title={user?.institution?.name ?? 'Institution dashboard'}
        description={`Institution overview · server time ${formatDateTime(data.serverTime)}`}
        actions={
          <>
            <Link className="btn" to="/reports">
              Reports
            </Link>
            <Link className="btn btn--primary" to="/users">
              Manage accounts
            </Link>
          </>
        }
      />

      <AttentionPanel items={data.attention} />

      <div className="stat-grid">
        <StatCard
          label="Candidates"
          value={counts.students}
          meta={`${counts.classes} classes · ${counts.departments} departments · ${counts.subjects} subjects`}
        />
        <StatCard label="Examiners" value={counts.teachers} />
        <StatCard
          label="Submissions"
          value={counts.attempts ?? 0}
          meta={<StatDelta delta={data.deltas.submissions} />}
        />
        <StatCard
          label="Results published"
          value={counts.published_results}
          tone="success"
          meta={<StatDelta delta={data.deltas.publishedResults} />}
        />
        <StatCard
          label="Awaiting grading"
          value={data.gradingBacklog.ungraded_answers}
          tone={data.gradingBacklog.ungraded_answers > 0 ? 'warning' : 'neutral'}
          meta={
            oldest
              ? `${data.gradingBacklog.attempts} submission(s) · oldest waiting since ${formatDateTime(oldest)}`
              : 'Nothing is waiting to be marked'
          }
        />
        <StatCard
          label="Pass rate"
          value={rate === null ? '—' : formatPercentage(rate)}
          tone={rate === null ? 'neutral' : rate >= 50 ? 'success' : 'danger'}
          meta={data.passRate.graded > 0 ? `${data.passRate.passed} of ${data.passRate.graded} graded results` : 'No graded results yet'}
        />
        <StatCard
          label="Average score"
          value={data.passRate.graded > 0 ? formatPercentage(data.passRate.average_percentage) : '—'}
          meta="Across graded results"
        />
        <StatCard
          label="Attempts in progress"
          value={counts.live_attempts}
          tone={counts.live_attempts > 0 ? 'accent' : 'neutral'}
          meta={`${counts.exams} examinations · ${counts.quizzes} quizzes`}
        />
      </div>

      <div className="split-2">
        <Card title="Submissions over time" description="Attempts submitted each day over the last 30 days.">
          <BarChart
            ariaLabel="Submissions per day over the last thirty days"
            data={data.submissionsByDay.map((point) => ({ label: point.day.slice(5), value: point.submissions }))}
          />
        </Card>
        <Card title="Grade distribution" description="Released results grouped by awarded grade.">
          <DonutChart
            ariaLabel="Grade distribution across released results"
            data={data.gradeDistribution.map((point) => ({
              label: point.grade,
              value: point.count,
              tone: ['A+', 'A', 'B'].includes(point.grade) ? 'success' : point.grade === 'F' ? 'danger' : 'default',
            }))}
          />
        </Card>
      </div>

      <div className="split-2">
        <Card title="Examination pipeline" description="Where every paper currently sits in its lifecycle.">
          <PipelineStrip stages={data.examPipeline} />
        </Card>
        <Card title="Delivery readiness" description="Structural checks on papers before they run." flush>
          <ul className="check-list">
            <li className="check-list__item">
              <span>Papers without questions</span>
              <Badge tone={data.paperIntegrity.exams_without_questions > 0 ? 'danger' : 'success'}>
                {data.paperIntegrity.exams_without_questions}
              </Badge>
            </li>
            <li className="check-list__item">
              <span>Scheduled without candidates</span>
              <Badge tone={data.paperIntegrity.scheduled_without_candidates > 0 ? 'warning' : 'success'}>
                {data.paperIntegrity.scheduled_without_candidates}
              </Badge>
            </li>
            <li className="check-list__item">
              <span>Closing within 24 hours</span>
              <Badge tone={data.paperIntegrity.exams_ending_soon > 0 ? 'warning' : 'success'}>
                {data.paperIntegrity.exams_ending_soon}
              </Badge>
            </li>
            <li className="check-list__item">
              <span>Accounts awaiting approval</span>
              <Badge tone={data.paperIntegrity.pending_accounts > 0 ? 'warning' : 'success'}>
                {data.paperIntegrity.pending_accounts}
              </Badge>
            </li>
          </ul>
        </Card>
      </div>

      <Card
        title="Examinations opening soon"
        description="Draft and scheduled papers, with the questions and candidate assignments already in place."
        flush
      >
        {data.upcomingExams.length === 0 ? (
          <div className="empty-state">
            <h3>Nothing scheduled</h3>
            <p>Papers appear here as soon as they are created, with the time left to prepare them.</p>
          </div>
        ) : (
          <DataTable
            rows={data.upcomingExams}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'name',
                header: 'Paper',
                render: (row) => (
                  <div>
                    <Link to={`/examinations/${row.id}`} className="link-strong">
                      {row.name}
                    </Link>
                    <div className="text-sm text-muted">
                      {row.code}
                      {row.subject_name ? ` · ${row.subject_name}` : ''}
                      {row.class_name ? ` · ${row.class_name}` : ''}
                    </div>
                  </div>
                ),
              },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              { key: 'opens', header: 'Opens', render: (row) => `${formatDateTime(row.start_at)} (${formatRelative(row.start_at)})` },
              { key: 'closes', header: 'Closes', render: (row) => formatDateTime(row.end_at) },
              {
                key: 'readiness',
                header: 'Readiness',
                render: (row) => (
                  <span className="stacked">
                    <Badge tone={row.question_count > 0 ? 'success' : 'danger'}>{row.question_count} question(s)</Badge>
                    <Badge tone={row.assignment_count > 0 ? 'success' : 'warning'}>{row.assignment_count} assignment(s)</Badge>
                  </span>
                ),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) => (
                  <Link className="btn btn--sm" to={`/examinations/${row.id}`}>
                    Open
                  </Link>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        title="Examination outcomes"
        description="Attempts, averages and pass rates for papers that are running or concluded."
        flush
      >
        {data.examPerformance.length === 0 ? (
          <div className="empty-state">
            <h3>No paper has run yet</h3>
            <p>Once an examination is active or published its results are summarised here.</p>
          </div>
        ) : (
          <DataTable
            rows={data.examPerformance}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'name',
                header: 'Paper',
                render: (row) => (
                  <div>
                    <Link to={`/examinations/${row.id}`} className="link-strong">
                      {row.name}
                    </Link>
                    <div className="text-sm text-muted">
                      {row.code}
                      {row.subject_name ? ` · ${row.subject_name}` : ''}
                    </div>
                  </div>
                ),
              },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              { key: 'attempts', header: 'Attempts', align: 'right', render: (row) => row.attempts },
              { key: 'published', header: 'Published', align: 'right', render: (row) => row.published },
              {
                key: 'average',
                header: 'Average',
                align: 'right',
                render: (row) =>
                  row.published === 0 ? <span className="text-muted text-sm">No data</span> : formatPercentage(row.average_percentage),
              },
              {
                key: 'pass',
                header: 'Pass rate',
                align: 'right',
                render: (row) =>
                  row.published === 0 ? (
                    <span className="text-muted text-sm">No data</span>
                  ) : (
                    <span className="progress-cell">
                      <ProgressBar value={row.pass_rate} tone={row.pass_rate >= 50 ? 'success' : 'warning'} />
                      <span>{row.pass_rate}%</span>
                    </span>
                  ),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) => (
                  <div className="inline">
                    <Link className="btn btn--sm" to={`/examinations/${row.id}/monitor`}>
                      Monitor
                    </Link>
                    <Link className="btn btn--sm" to={`/results?examId=${row.id}`}>
                      Results
                    </Link>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>

      <div className="split-2">
        <Card title="Performance by subject" flush>
          <DataTable
            rows={data.performanceBySubject}
            rowKey={(row) => row.subject}
            columns={[
              { key: 'subject', header: 'Subject' },
              { key: 'results', header: 'Results', align: 'right' },
              { key: 'passed', header: 'Passed', align: 'right' },
              {
                key: 'average',
                header: 'Average',
                align: 'right',
                render: (row) => (
                  <div className="progress-cell">
                    <ProgressBar value={row.average_percentage} tone={row.average_percentage >= 50 ? 'success' : 'warning'} />
                    <span>{formatPercentage(row.average_percentage)}</span>
                  </div>
                ),
              },
            ]}
            empty={<p>No results have been recorded yet.</p>}
          />
        </Card>

        <Card title="Class performance" flush>
          <DataTable
            rows={data.classPerformance}
            rowKey={(row) => row.id}
            columns={[
              { key: 'class_name', header: 'Class' },
              { key: 'students', header: 'Candidates', align: 'right' },
              {
                key: 'average',
                header: 'Average',
                align: 'right',
                render: (row) =>
                  row.average_percentage > 0 ? formatPercentage(row.average_percentage) : <span className="text-muted text-sm">No data</span>,
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) => (
                  <Link className="btn btn--sm" to={`/students?classId=${row.id}`}>
                    Candidates
                  </Link>
                ),
              },
            ]}
            empty={<p>No classes have recorded results yet.</p>}
          />
        </Card>
      </div>

      <Card
        title="Candidates needing support"
        description="Candidates whose published results average below the pass mark, with at least two graded results."
        flush
      >
        {data.atRiskStudents.length === 0 ? (
          <div className="empty-state">
            <h3>No candidate is below the pass mark</h3>
            <p>This list appears when released results show a candidate averaging under 50%.</p>
          </div>
        ) : (
          <DataTable
            rows={data.atRiskStudents}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'student',
                header: 'Candidate',
                render: (row) => (
                  <div>
                    <strong>{row.full_name}</strong>
                    <div className="text-sm text-muted">{row.student_code}</div>
                  </div>
                ),
              },
              { key: 'class', header: 'Class', render: (row) => row.class_name ?? '—' },
              { key: 'results', header: 'Graded results', align: 'right', render: (row) => row.graded_results },
              {
                key: 'average',
                header: 'Average',
                align: 'right',
                render: (row) => (
                  <div className="progress-cell">
                    <ProgressBar value={row.average_percentage} tone="danger" />
                    <span>{formatPercentage(row.average_percentage)}</span>
                  </div>
                ),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) => (
                  <Link className="btn btn--sm" to={`/students?q=${encodeURIComponent(row.student_code)}`}>
                    Open profile
                  </Link>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        title="Recent activity"
        description="The most recent audited actions in this institution."
        flush
        actions={
          <Link className="btn btn--sm" to="/audit-logs">
            Full audit log
          </Link>
        }
      >
        <DataTable
          rows={data.recentActivity}
          rowKey={(row) => row.id}
          columns={[
            { key: 'created_at', header: 'When', render: (row) => formatDateTime(row.created_at) },
            { key: 'actor', header: 'Actor', render: (row) => `${row.actor_name ?? 'System'} (${row.actor_role ?? 'system'})` },
            { key: 'description', header: 'Action', render: (row) => row.description },
            { key: 'category', header: 'Category', render: (row) => <Badge tone="outline">{row.category}</Badge> },
          ]}
          empty={<p>No activity recorded yet.</p>}
        />
      </Card>
    </div>
  );
}
