import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber, titleCase } from '../../lib/format';
import { Badge, Card, DataTable, Loading, PageHeader } from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { BarList, DonutChart, StackedBarChart, TrendChart } from '../../components/charts';
import { AttentionPanel, StatDelta } from '../../components/dashboard';
import type { PlatformDashboard } from '../../types';

const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  pending: 'Pending activation',
  suspended: 'Suspended',
  disabled: 'Disabled',
};

/** A single figure in the dashboard's headline band. */
function Metric({
  label,
  value,
  meta,
  tone,
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  tone?: 'accent' | 'warning' | 'success' | 'danger';
}) {
  return (
    <div className={`metric-band__item ${tone ? `metric-band__item--${tone}` : ''}`}>
      <span className="metric-band__label">{label}</span>
      <span className="metric-band__value">{value}</span>
      {meta ? <span className="metric-band__meta">{meta}</span> : null}
    </div>
  );
}

/**
 * Platform administration — the dashboard every platform administrator lands on.
 *
 * This is the operator's view of the service, not of any one institution's teaching, so it
 * is built around the three questions an operator actually asks: is the service healthy,
 * who is using it, and what needs attention. Tenancy and account figures lead; assessment
 * activity follows; each tenant links through to its own dashboard rather than a second
 * dashboard being embedded here.
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
  // The sign-in totals are stated by the chart itself, in its legend and summary.
  const pendingAccounts = data.accountMix.find((row) => row.status === 'pending')?.count ?? 0;

  const ranked = [...data.institutionBreakdown]
    .sort((a, b) => b.attempts - a.attempts)
    .map((row) => ({
      label: row.name,
      value: row.attempts,
      meta: `${formatNumber(row.students)} candidates · ${formatNumber(row.teachers)} examiners · ${row.exams} examinations`,
      detail: `${row.name} (${row.code})`,
    }));

  return (
    <div className="page">
      <PageHeader
        title="Platform administration"
        description={
          <>
            {counts.institutions} institution{counts.institutions === 1 ? '' : 's'} · {formatNumber(counts.users)} user
            accounts · server time {formatDateTime(data.serverTime)}
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

      {/* The headline figures as one band, so the charts below stay in view. */}
      <div className="metric-band">
        <Metric
          label="Institutions"
          value={counts.institutions}
          tone="accent"
          meta={`${counts.active_institutions} active · ${counts.demo_institutions} demonstration`}
        />
        <Metric
          label="User accounts"
          value={formatNumber(counts.users)}
          meta={`${counts.active_users} active · ${counts.active_sessions} sessions open`}
          tone={pendingAccounts > 0 ? 'warning' : undefined}
        />
        <Metric label="Candidates" value={formatNumber(counts.students)} meta={`${counts.teachers} examiners`} />
        <Metric label="Examinations" value={counts.exams} meta={`${counts.active_exams} active`} />
        <Metric
          label="Submissions"
          value={formatNumber(counts.attempts)}
          meta={<StatDelta delta={data.deltas.submissions} />}
        />
        <Metric
          label="New accounts"
          value={formatNumber(data.deltas.signups.current)}
          meta={<StatDelta delta={data.deltas.signups} />}
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
          description="Successful and failed sign-ins each day, over the last 14 days."
        >
          {/* Both series are stacked, so a day's failures are visible beside its successes
              rather than hidden behind a single bar. */}
          <StackedBarChart
            ariaLabel="Successful and failed sign-ins per day over the last fourteen days"
            unit="sign-ins"
            series={[
              { key: 'successful', label: 'Successful', tone: 'success' },
              { key: 'failed', label: 'Failed', tone: 'danger' },
            ]}
            data={data.loginActivity.map((day) => ({
              label: day.day.slice(5),
              detail: day.day,
              values: [day.successful, day.failed],
            }))}
          />
        </Card>
      </div>

      <div className="split-2">
        <Card
          title="Where activity happens"
          description="Attempts recorded by each institution, over the whole history."
        >
          {/* Institutions have long names, so they rank as horizontal bars. */}
          <BarList
            ariaLabel="Attempts recorded by each institution"
            unit="attempts"
            items={ranked}
            emptyLabel="No institution has recorded any attempt yet."
          />
        </Card>
        <Card title="Accounts by status" description="User accounts by status across the platform.">
          <DonutChart
            ariaLabel="User accounts by status"
            data={data.accountMix.map((row) => ({
              label: ACCOUNT_STATUS_LABELS[row.status] ?? titleCase(row.status),
              value: row.count,
              tone: row.status === 'active' ? 'success' : row.status === 'pending' ? 'warning' : 'danger',
            }))}
          />
        </Card>
      </div>

      {/*
       * Every tenant with its usage. The platform office is listed last and marked as such:
       * it owns no candidates or papers, so offering to open its dashboard would be a
       * permanently empty page.
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
            { key: 'attempts', header: 'Attempts', align: 'right', render: (row) => formatNumber(row.attempts) },
            {
              key: 'inspect',
              header: '',
              align: 'right',
              render: (row) =>
                row.code === 'PLATFORM' ? (
                  <span className="text-sm text-muted">Not a teaching institution</span>
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
