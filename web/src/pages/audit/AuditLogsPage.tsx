import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import type { AuditLogRow, Institution } from '../../types';
import { useAuth } from '../../context/AuthContext';
import {
  Badge,
  Button,
  Card,
  DataTable,
  DefinitionList,
  Modal,
  PageHeader,
  Pagination,
  SelectInput,
  StatCard,
  type Column,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { IconSearch } from '../../components/Icons';

interface AuditSummary {
  byCategory: { category: string; count: number }[];
  byAction: { action: string; count: number }[];
  failures: number;
}

const CATEGORIES = ['auth', 'exam', 'question', 'result', 'user', 'grading', 'institution', 'system'];
const ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_reset',
  'exam.created',
  'exam.updated',
  'exam.status_changed',
  'exam.assigned',
  'question.created',
  'question.updated',
  'question.archived',
  'result.published',
  'result.unpublished',
  'grading.marks_saved',
  'grading.finalized',
  'user.created',
  'user.updated',
  'report.exported',
];

export default function AuditLogsPage() {
  const { user } = useAuth();
  const isPlatformAdmin = user?.role === 'super_admin';
  const list = useListState({ category: '', action: '', institutionId: '', resourceType: '', from: '', to: '' });
  const [detail, setDetail] = useState<AuditLogRow | null>(null);

  const summary = useQuery({
    queryKey: ['audit-logs', 'summary'],
    queryFn: () => api.get<AuditSummary>('/audit-logs/summary'),
  });

  const institutions = useQuery({
    queryKey: ['institutions', 'options'],
    queryFn: () => api.list<Institution>('/institutions', { pageSize: 100 }),
    enabled: isPlatformAdmin,
  });

  const logs = useQuery({
    queryKey: ['audit-logs', list.query],
    queryFn: () =>
      api.list<AuditLogRow>('/audit-logs', {
        ...list.query,
        category: list.filters.category || undefined,
        action: list.filters.action || undefined,
        institutionId: list.filters.institutionId || undefined,
        resourceType: list.filters.resourceType || undefined,
        from: list.filters.from || undefined,
        to: list.filters.to || undefined,
      }),
  });

  const columns: Column<AuditLogRow>[] = [
    { key: 'created_at', header: 'Timestamp', render: (row) => formatDateTime(row.created_at) },
    {
      key: 'actor',
      header: 'Actor',
      render: (row) => (
        <div>
          <strong>{row.actor_name ?? 'System'}</strong>
          <div className="text-sm text-muted">{row.actor_role ?? 'automated'}</div>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (row) => (
        <div>
          <code className="code-inline">{row.action}</code>
          <div className="text-sm text-muted">{row.category}</div>
        </div>
      ),
    },
    { key: 'description', header: 'Description', render: (row) => <span className="cell-clamp">{row.description}</span> },
    {
      key: 'resource',
      header: 'Resource',
      render: (row) => (row.resource_type ? `${row.resource_type}${row.resource_id ? ` #${row.resource_id}` : ''}` : '—'),
    },
    { key: 'ip_address', header: 'IP address', render: (row) => row.ip_address ?? '—' },
    ...(isPlatformAdmin
      ? ([
          {
            key: 'institution',
            header: 'Institution',
            render: (row: AuditLogRow) => row.institution_name ?? (row.institution_id ? `#${row.institution_id}` : 'Platform'),
          },
        ] as Column<AuditLogRow>[])
      : []),
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <Button size="sm" variant="ghost" onClick={() => setDetail(row)}>
          Details
        </Button>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Audit log"
        description="Every authentication event, question and examination change, grading action, publication and user change is recorded with actor, timestamp, address and metadata."
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Entries" value={logs.data?.meta.total ?? 0} />
        <StatCard label="Failed sign-ins recorded" value={summary.data?.failures ?? 0} tone={summary.data?.failures ? 'warning' : 'neutral'} />
        <StatCard
          label="Most active category"
          value={summary.data?.byCategory[0]?.category ?? '—'}
          meta={summary.data?.byCategory[0] ? `${summary.data.byCategory[0].count} entries` : undefined}
        />
      </div>

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search description, actor or action"
              aria-label="Search audit log"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All categories"
            options={CATEGORIES.map((category) => ({ value: category, label: category }))}
            value={list.filters.category}
            onChange={(event) => list.updateFilter('category', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All actions"
            options={ACTIONS.map((action) => ({ value: action, label: action }))}
            value={list.filters.action}
            onChange={(event) => list.updateFilter('action', event.target.value)}
          />
          {isPlatformAdmin ? (
            <SelectInput
              wrapperClassName="filter-bar__field"
              placeholder="All institutions"
              options={(institutions.data?.data ?? []).map((institution) => ({ value: institution.id, label: institution.name }))}
              value={list.filters.institutionId}
              onChange={(event) => list.updateFilter('institutionId', event.target.value)}
            />
          ) : null}
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All resources"
            options={['exam', 'question', 'attempt', 'result', 'user', 'session', 'report', 'institution'].map((type) => ({
              value: type,
              label: type,
            }))}
            value={list.filters.resourceType}
            onChange={(event) => list.updateFilter('resourceType', event.target.value)}
          />
          <Button size="sm" onClick={list.resetFilters}>
            Clear
          </Button>
        </div>

        {logs.error ? (
          <div className="card__body">
            <ErrorState message="The audit log could not be loaded." onRetry={() => void logs.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={logs.data?.data ?? []}
              rowKey={(row) => row.id}
              loading={logs.isLoading}
              empty={<p>No audit entries match these filters.</p>}
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={logs.data?.meta.total ?? 0}
              totalPages={logs.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <Card title="Activity by category" flush>
        {(summary.data?.byCategory ?? []).length === 0 ? (
          <p className="text-muted">No activity recorded yet.</p>
        ) : (
          <ul className="metric-list">
            {(summary.data?.byCategory ?? []).map((entry) => (
              <li key={entry.category}>
                <Badge tone="outline">{entry.category}</Badge>
                <span>{entry.count} entries</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={Boolean(detail)} title="Audit entry" onClose={() => setDetail(null)} wide>
        {detail ? (
          <div>
            <DefinitionList
              items={[
                { term: 'Action', description: <code className="code-inline">{detail.action}</code> },
                { term: 'Category', description: detail.category },
                { term: 'Description', description: detail.description },
                { term: 'Actor', description: `${detail.actor_name ?? 'System'}${detail.actor_role ? ` (${detail.actor_role})` : ''}` },
                { term: 'Timestamp', description: formatDateTime(detail.created_at) },
                { term: 'Resource', description: detail.resource_type ? `${detail.resource_type}${detail.resource_id ? ` #${detail.resource_id}` : ''}` : '—' },
                { term: 'IP address', description: detail.ip_address ?? '—' },
                { term: 'User agent', description: detail.user_agent ?? '—' },
                { term: 'Institution', description: detail.institution_name ?? (detail.institution_id ? `#${detail.institution_id}` : 'Platform') },
              ]}
            />
            <h3 className="modal-section-title">Metadata</h3>
            <pre className="code-block">{JSON.stringify(detail.metadata ?? {}, null, 2)}</pre>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
