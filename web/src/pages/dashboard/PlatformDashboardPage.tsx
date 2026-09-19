import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber, titleCase } from '../../lib/format';
import { Badge, Card, DataTable, Loading, PageHeader, ProgressBar, StatCard } from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { BarChart, TrendChart } from '../../components/charts';
import { AttentionPanel, StatDelta } from '../../components/dashboard';
import type { PlatformDashboard } from '../../types';

const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  pending: 'Pending activation',
  suspended: 'Suspended',
  disabled: 'Disabled',
};

/**
 * Platform administration — the dashboard every platform administrator lands on.
 *
 * This is the operator's view of the service, not of any one institution's teaching: it
 * reports tenancy, accounts and platform activity, and every tenant figure is linked
 * through to that institution's own dashboard rather than duplicated here.
 */
export default function PlatformDashboardPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'platform'],
    queryFn: () => api.get<PlatformDashboard>('/dashboard/platform'),
    refetchInterval: 120_000,
  });

  if (isLoading) return <Loading label="Loading the platform dashboard…" />;
  if (error || !data) return <ErrorState message="The platform dashboard could not be loaded." onRetry={() => void refetch()} />;

  const { counts } = data;
  const failedLogins = data.loginActivity.reduce((sum, day) => sum + day.failed, 0);
  const successfulLogins = data.loginActivity.reduce((sum, day) => sum + day.successful, 0);
  // The busiest tenant sets the scale for the usage column, so the bar lengths compare.
  const busiest = data.institutionBreakdown.reduce((max, row) => Math.max(max, row.attempts), 0);

  return (
    <div className="page">
      <PageHeader
        title="Platform administration"
        description={
          <>
            Cross-institution operations for {counts.institutions} institution{counts.institutions === 1 ? '' : 's'} ·
            server time {formatDateTime(data.serverTime)}
          </>
        }
        actions={
          <>
            <Link className="btn" to="/audit-logs">
              Audit log
            </Link>
            <Link className="btn btn--primary" to="/institutions">
              Manage institutions
            </Link>
          </>
        }
      />

      <AttentionPanel items={data.attention} title="Needs attention" />

      {/* Tenancy and accounts first, then assessment activity. */}
      <div className="stat-grid">
        <StatCard
          label="Institutions"
          value={counts.institutions}
          tone="accent"
          meta={`${counts.active_institutions} active · ${counts.demo_institutions} demonstration`}
        />
        <StatCard
          label="User accounts"
          value={formatNumber(counts.users)}
          meta={`${counts.active_users} active · ${counts.active_sessions} sessions open`}
        />
        <StatCard label="Candidates" value={formatNumber(counts.students)} meta={`${counts.teachers} examiners`} />
        <StatCard
          label="Examinations"
          value={counts.exams}
          meta={`${counts.active_exams} active · ${counts.questions} questions banked`}
        />
        <StatCard
          label="Submissions"
          value={formatNumber(counts.attempts)}
          meta={<StatDelta delta={data.deltas.submissions} />}
        />
        <StatCard
          label="New accounts"
          value={formatNumber(data.deltas.signups.current)}
          meta={<StatDelta delta={data.deltas.signups} />}
        />
        <StatCard
          label="Attempts in progress"
          value={counts.live_attempts}
          tone={counts.live_attempts > 0 ? 'accent' : 'neutral'}
          meta="Timed attempts currently open"
        />
        <StatCard
          label="Sign-ins"
          value={formatNumber(successfulLogins)}
          meta={`${failedLogins} failure${failedLogins === 1 ? '' : 's'} in the last 14 days`}
        />
      </div>

      {/* The daily series carries thirty values, so it takes the wider half of the pair. */}
      <div className="dashboard-charts">
        <Card
          className="card--chart"
          title="Submissions over time"
          description="Attempts submitted platform-wide over the last 30 days."
        >
          <TrendChart
            ariaLabel="Submissions per day platform-wide over the last thirty days"
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
          title="Sign-in activity"
          description="Successful sign-ins each day over the last 14 days."
        >
          <BarChart
            ariaLabel="Successful sign-ins per day over the last fourteen days"
            unit="successful sign-ins"
            data={data.loginActivity.map((day) => ({
              label: day.day.slice(5),
              detail: day.day,
              value: day.successful,
            }))}
          />
          <p className="text-sm text-muted">
            {failedLogins === 0
              ? 'No failed sign-ins in the last 14 days.'
              : `${failedLogins} failed sign-in${failedLogins === 1 ? '' : 's'} in the last 14 days. Repeat failures trigger the lockout policy and are recorded in the audit log.`}
          </p>
        </Card>
      </div>

      {/*
       * Every tenant, with its usage. This is the whole of the platform's institution
       * reporting — the dashboard deliberately does not repeat it as a separate ranking.
       */}
      <Card
        title="Institutions"
        description="Every institution on the platform, with its recorded usage."
        flush
        actions={
          <Link className="btn btn--sm" to="/institutions">
            Manage
          </Link>
        }
      >
        <DataTable
          rows={data.institutionBreakdown}
          rowKey={(row) => row.id}
          empty={<p>No institutions have been created yet.</p>}
          columns={[
            {
              key: 'name',
              header: 'Institution',
              render: (row) => (
                <div className="cell-stack">
                  <strong>{row.name}</strong>
                  <span>{row.code}</span>
                </div>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => (
                <Badge tone={row.status === 'active' ? 'success' : row.status === 'suspended' ? 'warning' : 'outline'}>
                  {titleCase(row.status)}
                </Badge>
              ),
            },
            {
              key: 'demo',
              header: 'Data set',
              render: (row) =>
                row.is_demo ? <Badge tone="warning">Demonstration</Badge> : <Badge tone="outline">Production</Badge>,
            },
            { key: 'students', header: 'Candidates', align: 'right', render: (row) => formatNumber(row.students) },
            { key: 'teachers', header: 'Examiners', align: 'right', render: (row) => formatNumber(row.teachers) },
            { key: 'exams', header: 'Examinations', align: 'right', render: (row) => formatNumber(row.exams) },
            {
              key: 'attempts',
              header: 'Attempts',
              align: 'right',
              render: (row) => (
                <div className="progress-cell">
                  <ProgressBar value={busiest ? (row.attempts / busiest) * 100 : 0} />
                  <span>{formatNumber(row.attempts)}</span>
                </div>
              ),
            },
            {
              key: 'inspect',
              header: '',
              align: 'right',
              render: (row) =>
                /*
                 * The platform office is the operator's own record, not a teaching tenant:
                 * its dashboard holds no candidates, papers or results by design, so it is
                 * marked as not applicable rather than linked to an empty page.
                 */
                row.code === 'PLATFORM' ? (
                  <span className="text-sm text-muted">Not a tenant</span>
                ) : (
                  <Link
                    className="btn btn--sm"
                    to={`/institutions/${row.id}/dashboard`}
                    aria-label={`Open the dashboard for ${row.name}`}
                  >
                    Dashboard
                  </Link>
                ),
            },
          ]}
        />
      </Card>

      <div className="split-2">
        <Card title="Institution status" description="Every institution by its recorded status." flush>
          <ul className="check-list">
            {data.institutionStatus.map((row) => (
              <li key={row.status} className="check-list__item">
                <span>{titleCase(row.status)}</span>
                <Badge tone={row.status === 'active' ? 'success' : row.status === 'suspended' ? 'warning' : 'outline'}>
                  {row.count}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Account status" description="User accounts by status across the platform." flush>
          <ul className="check-list">
            {data.accountMix.map((row) => (
              <li key={row.status} className="check-list__item">
                <span>{ACCOUNT_STATUS_LABELS[row.status] ?? titleCase(row.status)}</span>
                <Badge tone={row.status === 'active' ? 'success' : row.status === 'pending' ? 'warning' : 'outline'}>
                  {row.count}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card
        title="Latest platform activity"
        description="Every action below is recorded in the audit log."
        flush
        actions={
          <Link className="btn btn--sm" to="/audit-logs">
            View audit log
          </Link>
        }
      >
        <DataTable
          rows={data.recentAudit}
          rowKey={(row) => row.id}
          columns={[
            { key: 'created_at', header: 'When', render: (row) => formatDateTime(row.created_at) },
            { key: 'actor_name', header: 'Actor', render: (row) => row.actor_name ?? 'System' },
            { key: 'description', header: 'Action', render: (row) => row.description },
            { key: 'institution_id', header: 'Institution', render: (row) => row.institution_id ?? '—' },
          ]}
          empty={<p>No audited activity yet.</p>}
        />
      </Card>
    </div>
  );
}
