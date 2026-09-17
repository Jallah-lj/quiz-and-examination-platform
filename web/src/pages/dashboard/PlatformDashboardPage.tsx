import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber } from '../../lib/format';
import { Badge, Card, DataTable, Loading, PageHeader, StatCard } from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { BarChart } from '../../components/charts';
import type { PlatformDashboard } from '../../types';

export default function PlatformDashboardPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'platform'],
    queryFn: () => api.get<PlatformDashboard>('/dashboard/platform'),
  });

  if (isLoading) return <Loading label="Loading platform overview…" />;
  if (error || !data) return <ErrorState message="The platform overview could not be loaded." onRetry={() => void refetch()} />;

  const counts = data.counts;
  const failedLogins = data.loginActivity.reduce((sum, day) => sum + day.failed, 0);
  const successfulLogins = data.loginActivity.reduce((sum, day) => sum + day.successful, 0);

  return (
    <div className="page">
      <PageHeader
        title="Platform overview"
        description={`Cross-institution statistics · server time ${formatDateTime(data.serverTime)}`}
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

      <div className="stat-grid">
        <StatCard label="Institutions" value={counts.institutions} meta={`${counts.active_institutions} active`} tone="accent" />
        <StatCard label="User accounts" value={formatNumber(counts.users)} meta={`${counts.active_users} active`} />
        <StatCard label="Students" value={formatNumber(counts.students)} />
        <StatCard label="Examiners" value={formatNumber(counts.teachers)} />
        <StatCard label="Examinations" value={counts.exams} meta={`${counts.active_exams} currently active`} />
        <StatCard label="Questions" value={formatNumber(counts.questions)} />
        <StatCard label="Attempts" value={formatNumber(counts.attempts)} meta={`${counts.live_attempts} in progress`} />
        <StatCard label="Active sessions" value={counts.active_sessions} meta={`${successfulLogins} sign-ins, ${failedLogins} failures (14 days)`} />
      </div>

      <Card title="Sign-in activity (last 14 days)">
        <BarChart
          ariaLabel="Successful sign-ins per day over the last fourteen days"
          data={data.loginActivity.map((day) => ({ label: day.day.slice(5), value: day.successful, tone: 'default' }))}
        />
      </Card>

      <Card title="Institutions" description="Usage per institution, including demonstration data." flush>
        <DataTable
          rows={data.institutionBreakdown}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'name',
              header: 'Institution',
              render: (row) => (
                <div>
                  <strong>{row.name}</strong>
                  <div className="text-sm text-muted">{row.code}</div>
                </div>
              ),
            },
            { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'active' ? 'success' : 'outline'}>{row.status}</Badge> },
            {
              key: 'demo',
              header: 'Data set',
              render: (row) => (row.is_demo ? <Badge tone="warning">Demonstration</Badge> : <Badge tone="outline">Production</Badge>),
            },
            { key: 'students', header: 'Students', align: 'right', render: (row) => formatNumber(row.students) },
            { key: 'teachers', header: 'Examiners', align: 'right', render: (row) => formatNumber(row.teachers) },
            { key: 'exams', header: 'Examinations', align: 'right', render: (row) => formatNumber(row.exams) },
            { key: 'attempts', header: 'Attempts', align: 'right', render: (row) => formatNumber(row.attempts) },
          ]}
        />
      </Card>

      <Card
        title="Latest platform activity"
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
