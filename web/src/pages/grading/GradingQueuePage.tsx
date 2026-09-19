import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime, formatMark, formatPercentage, formatRelative } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import type { Exam, GradingQueueItem, Quiz } from '../../types';
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

export default function GradingQueuePage() {
  const list = useListState({ status: 'pending', examId: '', quizId: '' });

  const papers = useQuery({
    queryKey: ['grading', 'papers'],
    queryFn: async () => {
      const [exams, quizzes] = await Promise.all([
        api.list<Exam>('/examinations', { pageSize: 100 }),
        api.list<Quiz>('/quizzes', { pageSize: 100 }),
      ]);
      return { exams: exams.data, quizzes: quizzes.data };
    },
    staleTime: 60_000,
  });

  const queue = useQuery({
    queryKey: ['grading', 'queue', list.query],
    queryFn: () =>
      api.list<GradingQueueItem>('/grading/queue', {
        ...list.query,
        status: list.filters.status || undefined,
        examId: list.filters.examId || undefined,
        quizId: list.filters.quizId || undefined,
      }),
  });

  const rows = queue.data?.data ?? [];

  const columns: Column<GradingQueueItem>[] = [
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
            {row.exam_code ? ` · ${row.exam_code}` : ''} · {row.subject_name ?? ''}
          </div>
        </div>
      ),
    },
    { key: 'submitted', header: 'Submitted', render: (row) => (row.submitted_at ? formatDateTime(row.submitted_at) : '—') },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'written',
      header: 'Written answers',
      align: 'right',
      render: (row) =>
        row.subjective_count === 0 ? (
          <span className="text-sm text-muted">None</span>
        ) : row.ungraded_count > 0 ? (
          <Badge tone="warning">
            {row.ungraded_count} of {row.subjective_count} unmarked
          </Badge>
        ) : (
          <Badge tone="success">All marked</Badge>
        ),
    },
    {
      key: 'objective',
      header: 'Objective marks',
      align: 'right',
      render: (row) => `${formatMark(row.obtained_marks ?? 0)} / ${formatMark(row.max_marks)}`,
    },
    { key: 'percentage', header: '%', align: 'right', render: (row) => (row.percentage === null ? '—' : formatPercentage(row.percentage)) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div className="table-actions">
          <Link className="btn btn--sm btn--primary" to={`/grading/attempts/${row.id}`}>
            {row.ungraded_count > 0 ? 'Grade' : 'Open'}
          </Link>
          <Link className="btn btn--sm" to={`/attempts/${row.id}/review`}>
            Review
          </Link>
        </div>
      ),
    },
  ];

  const pendingCount = rows.filter((row) => row.ungraded_count > 0).length;

  return (
    <div className="page">
      <PageHeader
        title="Grading queue"
        description="Mark written answers and finalise submissions. Objective answers are graded automatically the moment an attempt is submitted."
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Submissions listed" value={queue.data?.meta.total ?? 0} />
        <StatCard label="With unmarked answers" value={pendingCount} tone={pendingCount ? 'warning' : 'neutral'} />
        <StatCard label="Awaiting finalisation" value={rows.filter((row) => row.status === 'SUBMITTED' || row.status === 'UNDER_REVIEW').length} />
        <StatCard label="Graded" value={rows.filter((row) => row.status === 'GRADED').length} tone="success" />
      </div>

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search by candidate or paper"
              aria-label="Search grading queue"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={[
              { value: 'pending', label: 'Needs attention' },
              { value: 'graded', label: 'Fully marked' },
              { value: 'all', label: 'All submissions' },
            ]}
            value={list.filters.status}
            onChange={(event) => list.updateFilter('status', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All examinations"
            options={(papers.data?.exams ?? []).map((exam) => ({ value: exam.id, label: exam.name }))}
            value={list.filters.examId}
            onChange={(event) => list.updateFilter('examId', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All quizzes"
            options={(papers.data?.quizzes ?? []).map((quiz) => ({ value: quiz.id, label: quiz.title }))}
            value={list.filters.quizId}
            onChange={(event) => list.updateFilter('quizId', event.target.value)}
          />
          <Button size="sm" onClick={list.resetFilters}>
            Clear
          </Button>
        </div>

        {queue.error ? (
          <div className="card__body">
            <ErrorState message="The grading queue could not be loaded." onRetry={() => void queue.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              loading={queue.isLoading}
              empty={
                <div>
                  <h3>Nothing to mark</h3>
                  <p>
                    Submissions appear here as soon as candidates submit a paper with written answers. Objective answers are
                    graded automatically.
                  </p>
                </div>
              }
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={queue.data?.meta.total ?? 0}
              totalPages={queue.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <p className="text-sm text-muted">
        Last refreshed {formatRelative(new Date().toISOString())}. Finalising a submission recalculates totals, applies the
        grading scheme and makes the result ready for publication.
      </p>
    </div>
  );
}
