import { Link, Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { formatDate, formatDateTime, formatMark, formatPercentage, formatRelative } from '../../lib/format';
import { Alert, Badge, Button, Card, DataTable, Loading, PageHeader, ProgressBar, StatCard, StatusBadge, type Column } from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { BarChart, DonutChart } from '../../components/charts';
import { StartAttemptDialog, type StartAttemptTarget } from '../../components/StartAttemptDialog';
import { useState } from 'react';
import type {
  AdminDashboard,
  AttemptListItem,
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
          <Link className="btn" to="/my-attempts">
            Attempt history
          </Link>
        }
      />

      <div className="stat-grid">
        <StatCard label="Examinations available now" value={stats.availableExams} tone="accent" />
        <StatCard label="Upcoming examinations" value={stats.upcomingExams} />
        <StatCard label="Quizzes open" value={stats.availableQuizzes} />
        <StatCard
          label="Average score"
          value={formatPercentage(stats.average_percentage)}
          meta={`${stats.passed} passed · ${stats.failed} failed`}
          tone={stats.average_percentage >= 50 ? 'success' : 'warning'}
        />
      </div>

      {stats.in_progress > 0 ? (
        <Alert tone="warning" title="You have an attempt in progress">
          Resume it from the attempt history below. The server clock keeps running whether or not the page is open.
        </Alert>
      ) : null}

      <Card
        title="Available now"
        description="Examinations you can start immediately. Starting an attempt begins the countdown."
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
                  <span>
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
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        setTarget({
                          kind: 'exam',
                          id: row.id,
                          title: row.name,
                          instructions: null,
                          durationMinutes: row.duration_minutes,
                          totalMarks: row.total_marks,
                          maxAttempts: row.max_attempts,
                          attemptsUsed: row.my_attempts,
                          endAt: row.end_at,
                        })
                      }
                    >
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
                { key: 'marks', header: 'Score', align: 'right', render: (row) => `${formatMark(row.obtained_marks)} / ${formatMark(row.total_marks)}` },
                { key: 'percentage', header: '%', align: 'right', render: (row) => formatPercentage(row.percentage) },
                { key: 'grade', header: 'Grade', render: (row) => row.grade ?? '—' },
                { key: 'outcome', header: 'Outcome', render: (row) => <StatusBadge status={row.outcome} /> },
              ]}
            />
          )}
        </Card>
      </div>

      <Card title="Upcoming examinations" flush>
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

      <StartAttemptDialog target={target} open={Boolean(target)} onClose={() => setTarget(null)} />
    </div>
  );
}

/* -------------------------------------------------------------------- examiner */
function TeacherDashboard() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'teacher'],
    queryFn: () => api.get<TeacherDashboardData>('/dashboard/teacher'),
  });

  const attempts = useQuery({
    queryKey: ['attempts', 'recent'],
    queryFn: () => api.list<AttemptListItem>('/attempts', { pageSize: 8 }),
  });

  if (isLoading) return <Loading label="Loading your dashboard…" />;
  if (error || !data) return <ErrorState message="The dashboard could not be loaded." onRetry={() => void refetch()} />;

  const attemptColumns: Column<AttemptListItem>[] = [
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
          {row.paper_title}
          <div className="text-sm text-muted">
            {row.kind === 'EXAM' ? 'Examination' : 'Quiz'}
            {row.paper_code ? ` · ${row.paper_code}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'submitted', header: 'Submitted', render: (row) => (row.submitted_at ? formatDateTime(row.submitted_at) : '—') },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      render: (row) => (row.percentage === null ? '—' : `${formatPercentage(row.percentage)} (${row.grade ?? '—'})`),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={`Examiner dashboard`}
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

      {data.awaitingGrading.attempts > 0 ? (
        <Alert
          tone="warning"
          title={`${data.awaitingGrading.attempts} submission(s) awaiting manual grading`}
          action={
            <Link className="btn btn--sm" to="/grading">
              Open queue
            </Link>
          }
        >
          Subjective answers must be marked before results can be published.
        </Alert>
      ) : null}

      <div className="stat-grid">
        <StatCard label="Active examinations" value={data.examStats.active} tone="accent" meta={`${data.examStats.total_exams} total`} />
        <StatCard label="Awaiting grading" value={data.awaitingGrading.attempts} meta={`${data.awaitingGrading.ungraded_answers} unmarked answers`} tone={data.awaitingGrading.attempts ? 'warning' : 'neutral'} />
        <StatCard label="Average score" value={formatPercentage(data.averages.average_percentage)} meta={`${data.averages.graded_results} graded results`} />
        <StatCard label="Published results" value={data.publishedResults.published} meta={`${data.publishedResults.passed} passed · ${data.publishedResults.failed} failed`} tone="success" />
      </div>

      <div className="split-2">
        <Card title="Submissions this week">
          <BarChart
            ariaLabel="Submissions per day over the last two weeks"
            data={data.weeklyActivity.map((point) => ({ label: point.day.slice(5), value: point.submissions }))}
            valueSuffix=""
          />
        </Card>
        <Card title="Question bank mix">
          <DonutChart
            ariaLabel="Questions by difficulty"
            data={[
              { label: 'Easy', value: data.questionBankStats.easy, tone: 'success' },
              { label: 'Medium', value: data.questionBankStats.medium, tone: 'default' },
              { label: 'Hard', value: data.questionBankStats.hard, tone: 'warning' },
            ]}
          />
          <p className="text-sm text-muted">
            {data.questionBankStats.active_questions} active questions across {data.questionBankStats.banks} banks.
          </p>
        </Card>
      </div>

      <Card
        title="Examinations in progress"
        description="Live and scheduled papers you own or teach."
        flush
        actions={
          <Link className="btn btn--sm" to="/examinations">
            All examinations
          </Link>
        }
      >
        {data.activeExams.length === 0 && data.upcomingExams.length === 0 ? (
          <div className="empty-state">
            <h3>Nothing scheduled</h3>
            <p>Create an examination to get started. Papers stay in draft until you schedule them.</p>
            <Link className="btn btn--primary" to="/examinations/new">
              Create examination
            </Link>
          </div>
        ) : (
          <DataTable
            rows={[...data.activeExams, ...data.upcomingExams]}
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
                      {row.subject_name ?? ''} {row.class_name ? `· ${row.class_name}` : ''}
                    </div>
                  </div>
                ),
              },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              { key: 'start', header: 'Opens', render: (row) => formatDateTime(row.start_at) },
              { key: 'close', header: 'Closes', render: (row) => formatDateTime(row.end_at) },
              { key: 'attempts', header: 'Attempts', align: 'right', render: (row) => row.attempt_count ?? 0 },
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
        title="Recent submissions"
        description="Latest attempts across your institution."
        flush
        actions={
          <Button size="sm" onClick={() => void attempts.refetch()} loading={attempts.isFetching}>
            Refresh
          </Button>
        }
      >
        {attempts.error ? (
          <ErrorState message="Recent submissions could not be loaded." onRetry={() => void attempts.refetch()} />
        ) : (
          <DataTable
            columns={attemptColumns}
            rows={attempts.data?.data ?? []}
            rowKey={(row) => row.id}
            loading={attempts.isLoading}
            empty={<p>No submissions have been received yet.</p>}
          />
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------- institution administrator */
function AdminDashboardView() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'admin'],
    queryFn: () => api.get<AdminDashboard>('/dashboard/admin'),
  });

  if (isLoading) return <Loading label="Loading institution dashboard…" />;
  if (error || !data) return <ErrorState message="The dashboard could not be loaded." onRetry={() => void refetch()} />;

  const { counts } = data;

  return (
    <div className="page">
      <PageHeader
        title={user?.institution?.name ?? 'Institution dashboard'}
        description={`Institution administrator overview · server time ${formatDateTime(data.serverTime)}`}
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

      <div className="stat-grid">
        <StatCard label="Students" value={counts.students} meta={`${counts.classes} classes · ${counts.departments} departments`} />
        <StatCard label="Examiners" value={counts.teachers} />
        <StatCard label="Examinations" value={counts.exams} meta={`${counts.active_exams} active`} tone="accent" />
        <StatCard label="Quizzes" value={counts.quizzes} meta={`${counts.questions} questions in banks`} />
        <StatCard label="Submissions" value={counts.attempts ?? 0} meta={`${counts.live_attempts} in progress`} />
        <StatCard
          label="Awaiting grading"
          value={counts.awaiting_grading}
          tone={counts.awaiting_grading ? 'warning' : 'neutral'}
          meta={`${counts.published_results} results published`}
        />
        <StatCard
          label="Pass rate"
          value={`${data.passRate.passRate}%`}
          meta={`${data.passRate.passed} of ${data.passRate.graded} graded`}
          tone={data.passRate.passRate >= 50 ? 'success' : 'danger'}
        />
        <StatCard label="Average score" value={formatPercentage(data.passRate.average_percentage)} />
      </div>

      <div className="split-2">
        <Card title="Submissions over time">
          <BarChart
            ariaLabel="Submissions per day"
            data={data.submissionsByDay.map((point) => ({ label: point.day.slice(5), value: point.submissions }))}
          />
        </Card>
        <Card title="Grade distribution">
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
              { key: 'students', header: 'Students', align: 'right' },
              { key: 'average', header: 'Average', align: 'right', render: (row) => formatPercentage(row.average_percentage) },
            ]}
            empty={<p>No classes have recorded results yet.</p>}
          />
        </Card>
      </div>

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
