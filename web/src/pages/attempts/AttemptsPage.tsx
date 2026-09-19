import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime, formatMark, formatPercentage, formatRelative } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import { useAuth } from '../../context/AuthContext';
import type { AttemptListItem, Student } from '../../types';
import {
  Badge,
  Button,
  Card,
  DataTable,
  PageHeader,
  Pagination,
  SelectInput,
  StatCard,
  StatusBadge,
  type Column,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { IconSearch } from '../../components/Icons';

export default function AttemptsPage() {
  const { user, hasPermission } = useAuth();
  const isStudent = user?.role === 'student';
  const list = useListState({ status: '', kind: '', studentId: '' });

  const attempts = useQuery({
    queryKey: ['attempts', list.query],
    queryFn: () =>
      api.list<AttemptListItem>('/attempts', {
        ...list.query,
        status: list.filters.status || undefined,
        studentId: list.filters.studentId || undefined,
      }),
  });

  const students = useQuery({
    queryKey: ['students', 'options'],
    queryFn: () => api.list<Student>('/students', { pageSize: 200, status: 'active' }),
    enabled: !isStudent && hasPermission('student.view', 'student.manage'),
  });

  const rows = (attempts.data?.data ?? []).filter((row) =>
    list.filters.kind ? row.kind === list.filters.kind : true,
  );

  const columns: Column<AttemptListItem>[] = [
    ...(isStudent
      ? []
      : ([
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
        ] as Column<AttemptListItem>[])),
    {
      key: 'paper',
      header: 'Assessment',
      render: (row) => (
        <div>
          <strong>{row.paper_title}</strong>
          <div className="text-sm text-muted">
            {row.kind === 'EXAM' ? 'Examination' : 'Quiz'}
            {row.paper_code ? ` · ${row.paper_code}` : ''} · attempt {row.attempt_no}
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'started', header: 'Started', render: (row) => formatDateTime(row.started_at) },
    {
      key: 'submitted',
      header: 'Submitted',
      render: (row) =>
        row.submitted_at ? (
          <span>
            {formatDateTime(row.submitted_at)}
            {row.auto_submitted ? <div className="text-sm text-muted">Auto-submitted</div> : null}
          </span>
        ) : (
          <span className="text-sm text-muted">Closes {formatRelative(row.expires_at)}</span>
        ),
    },
    {
      key: 'score',
      header: 'Score',
      align: 'right',
      render: (row) =>
        row.status === 'IN_PROGRESS' || row.percentage === null
          ? '—'
          : `${formatMark(row.obtained_marks ?? 0)} / ${formatMark(row.max_marks)}`,
    },
    { key: 'percentage', header: '%', align: 'right', render: (row) => (row.percentage === null ? '—' : formatPercentage(row.percentage)) },
    { key: 'grade', header: 'Grade', render: (row) => row.grade ?? '—' },
    {
      key: 'result',
      header: 'Result',
      render: (row) => {
        if (row.status === 'IN_PROGRESS') return <Badge tone="warning">In progress</Badge>;
        if (!row.result_id) return <Badge tone="outline">Pending</Badge>;
        if (row.is_published) return <StatusBadge status={row.outcome} />;
        return <Badge tone="outline">Awaiting release</Badge>;
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => {
        if (row.status === 'IN_PROGRESS') {
          return isStudent ? (
            <Link className="btn btn--sm btn--primary" to={`/attempts/${row.id}/take`}>
              Resume
            </Link>
          ) : (
            <span className="text-sm text-muted">Sitting</span>
          );
        }
        return (
          <div className="table-actions">
            <Link className="btn btn--sm" to={`/attempts/${row.id}/review`}>
              Review
            </Link>
            {!isStudent && row.result_id ? (
              <Link className="btn btn--sm" to={`/results/${row.result_id}`}>
                Result
              </Link>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={isStudent ? 'My attempts' : 'Attempts'}
        description={
          isStudent
            ? 'Every attempt you have started, including in-progress papers. The server clock keeps running even when this page is closed.'
            : 'All candidate attempts recorded in your institution.'
        }
      />

      {isStudent ? (
        <div className="stat-grid stat-grid--compact">
          <StatCard label="Attempts" value={attempts.data?.meta.total ?? 0} />
          <StatCard label="In progress" value={rows.filter((row) => row.status === 'IN_PROGRESS').length} tone="warning" />
          <StatCard label="Graded" value={rows.filter((row) => row.status === 'GRADED').length} tone="success" />
          <StatCard label="Awaiting release" value={rows.filter((row) => row.result_id && !row.is_published).length} />
        </div>
      ) : null}

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search assessments"
              aria-label="Search attempts"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All statuses"
            options={[
              { value: 'IN_PROGRESS', label: 'In progress' },
              { value: 'SUBMITTED', label: 'Submitted' },
              { value: 'UNDER_REVIEW', label: 'Under review' },
              { value: 'GRADED', label: 'Graded' },
              { value: 'EXPIRED', label: 'Expired' },
              { value: 'VOID', label: 'Voided' },
            ]}
            value={list.filters.status}
            onChange={(event) => list.updateFilter('status', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="Examinations and quizzes"
            options={[
              { value: 'EXAM', label: 'Examinations only' },
              { value: 'QUIZ', label: 'Quizzes only' },
            ]}
            value={list.filters.kind}
            onChange={(event) => list.updateFilter('kind', event.target.value)}
          />
          {!isStudent ? (
            <SelectInput
              wrapperClassName="filter-bar__field"
              placeholder="All candidates"
              options={(students.data?.data ?? []).map((student) => ({
                value: student.id,
                label: `${student.full_name ?? ''} (${student.student_code})`,
              }))}
              value={list.filters.studentId}
              onChange={(event) => list.updateFilter('studentId', event.target.value)}
            />
          ) : null}
          <Button size="sm" onClick={list.resetFilters}>
            Clear
          </Button>
        </div>

        {attempts.error ? (
          <div className="card__body">
            <ErrorState message="Attempts could not be loaded." onRetry={() => void attempts.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              loading={attempts.isLoading}
              empty={<p>No attempts match these filters.</p>}
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={attempts.data?.meta.total ?? 0}
              totalPages={attempts.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>
    </div>
  );
}
