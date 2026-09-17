import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber, titleCase } from '../../lib/format';
import { Badge, Card, DataTable, Loading, PageHeader, ProgressBar, SelectInput, StatCard } from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { BarChart, TrendChart } from '../../components/charts';
import { AttentionPanel, MetricList, StatDelta } from '../../components/dashboard';
import { InstitutionDashboardView } from './InstitutionDashboardView';
import type { PlatformDashboard } from '../../types';

const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  pending: 'Pending activation',
  suspended: 'Suspended',
  disabled: 'Disabled',
};

export default function PlatformDashboardPage() {
  // Which tenant, if any, the platform administrator is currently inspecting.
  const [inspectedId, setInspectedId] = useState<number | null>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', 'platform'],
    queryFn: () => api.get<PlatformDashboard>('/dashboard/platform'),
    refetchInterval: 120_000,
  });

  if (isLoading) return <Loading label="Loading platform overview…" />;
  if (error || !data) return <ErrorState message="The platform overview could not be loaded." onRetry={() => void refetch()} />;

  const counts = data.counts;
  const failedLogins = data.loginActivity.reduce((sum, day) => sum + day.failed, 0);
  const successfulLogins = data.loginActivity.reduce((sum, day) => sum + day.successful, 0);
  // Institutions ranked by the attempt volume recorded in the last 30 days.
  const activeInstitutions = [...data.institutionBreakdown]
    .sort((a, b) => b.attempts - a.attempts)
    .map((institution) => ({
      id: institution.id,
      label: institution.name,
      value: institution.attempts,
      meta: `${institution.students} candidates · ${institution.teachers} examiners`,
    }));

  // The internal platform office is not a tenant, so it is not offered for inspection.
  const tenants = data.institutionBreakdown.filter((institution) => institution.code !== 'PLATFORM');
  const inspected = tenants.find((institution) => institution.id === inspectedId) ?? null;

  return (
    <div className="page">
      <PageHeader
        title="Platform overview"
        description={`Cross-institution operations · server time ${formatDateTime(data.serverTime)}`}
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

      <AttentionPanel items={data.attention} title="Platform attention" />

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
          meta={`${counts.active_users} active`}
        />
        <StatCard label="Candidates" value={formatNumber(counts.students)} meta={`${counts.teachers} examiners`} />
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
        <StatCard label="Examinations" value={counts.exams} meta={`${counts.active_exams} active · ${counts.questions} questions`} />
        <StatCard
          label="Live attempts"
          value={counts.live_attempts}
          tone={counts.live_attempts > 0 ? 'accent' : 'neutral'}
          meta="Timed attempts currently open"
        />
        <StatCard
          label="Active sessions"
          value={counts.active_sessions}
          meta={`${successfulLogins} sign-ins · ${failedLogins} failures (14 days)`}
        />
      </div>

      <div className="split-2">
        <Card title="Submissions over time" description="Attempts submitted platform-wide over the last 30 days.">
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
        <Card title="Sign-in activity" description="Successful and failed sign-ins over the last 14 days.">
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
            {successfulLogins} successful and {failedLogins} failed attempts in the last 14 days. Repeated failures trigger the
            lockout policy and are recorded in the audit log.
          </p>
        </Card>
      </div>

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

      <Card title="Where activity is happening" description="Attempt volume by institution over the recorded history.">
        <MetricList
          items={activeInstitutions}
          valueSuffix=""
          emptyLabel="No institution has recorded any attempt yet."
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
              render: (row) => (row.is_demo ? <Badge tone="warning">Demonstration</Badge> : <Badge tone="outline">Production</Badge>),
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
                  <ProgressBar
                    value={activeInstitutions[0] ? (row.attempts / activeInstitutions[0].value) * 100 : 0}
                  />
                  <span>{formatNumber(row.attempts)}</span>
                </div>
              ),
            },
                        {
                key: 'inspect',
                header: '',
                align: 'right',
                render: (row) => (
                  <button
                    type="button"
                    className="btn btn--sm"
                    aria-label={`Open the dashboard for ${row.name}`}
                    onClick={() => setInspectedId(row.id)}
                  >
                    Dashboard
                  </button>
                ),
              },
]}
        />
      </Card>

      <Card
        title="Institution dashboard"
        description="Institution-scoped figures below are aggregated from that institution's own records. A platform administrator holds no institution of their own, so one has to be chosen explicitly."
      >
        <SelectInput
          label="Institution"
          value={inspectedId === null ? '' : String(inspectedId)}
          onChange={(event) => setInspectedId(event.target.value ? Number(event.target.value) : null)}
          options={tenants.map((institution) => ({
            value: String(institution.id),
            label: `${institution.name} (${institution.code})`,
          }))}
          placeholder="Select an institution to inspect"
          hint="Nothing is shown until an institution is selected."
        />
      </Card>

      {inspected ? (
        <InstitutionDashboardView institutionId={inspected.id} heading={inspected.name} onBack={() => setInspectedId(null)} />
      ) : null}

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
