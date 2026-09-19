import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { formatDateTime, formatPercentage, formatRelative } from '../../lib/format';
import { Badge, Button, Card, DataTable, Loading, PageHeader, ProgressBar, StatCard, StatusBadge } from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { DonutChart, TrendChart } from '../../components/charts';
import { AttentionPanel, PipelineStrip, StatDelta } from '../../components/dashboard';
import type { AdminDashboard } from '../../types';

/** `passed / graded` as a percentage, or null when nothing has been graded yet. */
function passRate(passed: number, graded: number): number | null {
  if (graded <= 0) return null;
  return Math.round((passed / graded) * 10000) / 100;
}

/** Grade codes that mean a fail on any scale the platform seeds or accepts. */
const FAILING_GRADES = ['F', 'FAIL', 'FAILED'];

/**
 * Institution dashboard, shared by institution administrators (their own institution) and
 * platform administrators (whichever institution they selected).
 */
export function InstitutionDashboardView({
  institutionId,
  heading,
  onBack,
}: {
  /** Platform staff name the institution to inspect; everyone else sees their own. */
  institutionId?: number;
  heading?: string;
  onBack?: () => void;
} = {}) {
  const { user } = useAuth();
  const query = institutionId ? `?institutionId=${institutionId}` : '';
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'admin', institutionId ?? 'own'],
    queryFn: () => api.get<AdminDashboard>(`/dashboard/admin${query}`),
    refetchInterval: 120_000,
  });

  if (isLoading) return <Loading label="Loading institution dashboard…" />;
  if (error || !data) return <ErrorState message="The dashboard could not be loaded." onRetry={() => void refetch()} />;

  const { counts } = data;
  const rate = data.passRate.passRate ?? passRate(data.passRate.passed, data.passRate.graded);
  const oldest = data.gradingBacklog.oldest_waiting;
  const { graded, passed, failed } = data.passRate;
  const { queue, ungraded_answers: ungradedAnswers } = data.gradingBacklog;

  /*
   * The pass rate follows each paper's own pass mark, while grades follow the institution
   * grading scale. When a paper's pass mark sits inside a failing band the two disagree,
   * so each figure states which rule produced it instead of looking contradictory.
   */
  const passRateDetail =
    graded > 0
      ? `${passed} passed${failed > 0 ? ` · ${failed} failed` : ''} of ${graded} graded result${graded === 1 ? '' : 's'}`
      : 'No graded results yet';

  const awaitingDetail =
    ungradedAnswers > 0
      ? `${ungradedAnswers} written answer${ungradedAnswers === 1 ? '' : 's'} to mark${oldest ? ` · oldest waiting since ${formatDateTime(oldest)}` : ''}`
      : queue > 0
        ? 'Nothing needs marking by hand'
        : 'Nothing is waiting to be marked';

  /*
   * The payload names the institution it describes. Platform staff viewing a tenant would
   * otherwise see their own "Platform Office" record in the heading.
   */
  const title = data.institution?.name ?? heading ?? user?.institution?.name ?? 'Institution dashboard';

  return (
    <div className="page">
      <PageHeader
        title={title}
        description={`Institution overview · server time ${formatDateTime(data.serverTime)}`}
        actions={
          <>
            {onBack ? (
              <Button size="sm" onClick={onBack}>
                Back to institutions
              </Button>
            ) : null}
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
          label="Awaiting results"
          value={queue}
          tone={ungradedAnswers > 0 ? 'warning' : queue > 0 ? 'accent' : 'neutral'}
          meta={awaitingDetail}
        />
        <StatCard
          label="Pass rate"
          value={rate === null ? '—' : formatPercentage(rate)}
          tone={rate === null ? 'neutral' : rate >= 50 ? 'success' : 'danger'}
          meta={passRateDetail}
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

      {/* The daily series carries thirty values, so it takes the wider half of the pair. */}
      <div className="dashboard-charts">
        <Card
          className="card--chart"
          title="Submissions over time"
          description="Attempts submitted each day over the last 30 days."
        >
          <TrendChart
            ariaLabel="Submissions per day over the last thirty days"
            unit="submissions"
            data={data.submissionsByDay.map((point) => ({
              label: point.day.slice(5),
              detail: point.day,
              value: point.submissions,
            }))}
          />
        </Card>
        <Card
          className="card--chart"
          title="Grade distribution"
          description="Every graded result, awarded on the institution grading scale."
        >
          <DonutChart
            ariaLabel="Grade distribution across released results"
            data={data.gradeDistribution.map((point) => ({
              label: point.grade,
              value: point.count,
              // A failing band is always red; the chart gives every other band its own
              // colour, so two grades are never drawn as the same arc.
              tone: FAILING_GRADES.includes(point.grade.trim().toUpperCase()) ? 'danger' : undefined,
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
            <li className="check-list__item">
              <span>
                Pass mark inside a failing grade band
                {data.passMarkConflicts.length > 0 ? (
                  <span className="check-list__note">
                    {data.passMarkConflicts
                      .slice(0, 2)
                      .map((exam) => `${exam.name} (passes at ${exam.pass_percentage}%, graded F below ${exam.lowest_passing_band}%)`)
                      .join(' · ')}
                    {data.passMarkConflicts.length > 2 ? ` · +${data.passMarkConflicts.length - 2} more` : ''}
                  </span>
                ) : null}
              </span>
              <Badge tone={data.paperIntegrity.pass_mark_in_failing_band > 0 ? 'warning' : 'success'}>
                {data.paperIntegrity.pass_mark_in_failing_band}
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
