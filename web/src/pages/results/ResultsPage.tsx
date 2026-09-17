import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDate, formatDateTime, formatMark, formatPercentage } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import type { ClassRow, Exam, ResultRow, ResultStats, Subject } from '../../types';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  PageHeader,
  Pagination,
  SelectInput,
  StatCard,
  StatusBadge,
  useToast,
  type Column,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { IconSearch } from '../../components/Icons';
import { DonutChart } from '../../components/charts';

export default function ResultsPage() {
  const { hasPermission, user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const isStudent = user?.role === 'student';
  // Dashboard links arrive pre-filtered, e.g. /results?examId=12; the values seed the
  // visible filter controls below.
  const [searchParams] = useSearchParams();
  const list = useListState({
    examId: searchParams.get('examId') ?? '',
    subjectId: searchParams.get('subjectId') ?? '',
    classId: searchParams.get('classId') ?? '',
    outcome: searchParams.get('outcome') ?? '',
    published: searchParams.get('published') ?? '',
    from: '',
    to: '',
    sort: 'date',
    order: 'desc',
  });
  const [selected, setSelected] = useState<number[]>([]);
  const [publishAction, setPublishAction] = useState<{ publish: boolean; attemptIds: number[] } | null>(null);

  const exams = useQuery({
    queryKey: ['examinations', 'options'],
    queryFn: () => api.list<Exam>('/examinations', { pageSize: 100 }),
    staleTime: 60_000,
  });

  const subjects = useQuery({
    queryKey: ['subjects', 'options'],
    queryFn: () => api.list<Subject>('/subjects', { pageSize: 100 }),
    staleTime: 5 * 60_000,
  });

  const classes = useQuery({
    queryKey: ['classes', 'options'],
    queryFn: () => api.list<ClassRow>('/classes', { pageSize: 100 }),
    enabled: !isStudent,
    staleTime: 5 * 60_000,
  });

  const filters = {
    examId: list.filters.examId || undefined,
    subjectId: list.filters.subjectId || undefined,
    classId: list.filters.classId || undefined,
    outcome: list.filters.outcome || undefined,
    published: list.filters.published || undefined,
    from: list.filters.from || undefined,
    to: list.filters.to || undefined,
  };

  const results = useQuery({
    queryKey: ['results', list.query],
    queryFn: () =>
      api.list<ResultRow>('/results', {
        ...list.query,
        ...filters,
        q: list.search || undefined,
      }),
  });

  const stats = useQuery({
    queryKey: ['results', 'stats', filters],
    queryFn: () => api.get<ResultStats>('/results/stats', filters),
  });

  const changePublication = useMutation({
    mutationFn: (input: { publish: boolean; attemptIds: number[] }) =>
      api.post<{ updated: number }>(input.publish ? '/results/publish' : '/results/unpublish', {
        attemptIds: input.attemptIds,
      }),
    onSuccess: async (result, input) => {
      toast.notify(
        input.publish ? `${result.updated} result(s) published.` : `${result.updated} result(s) withheld.`,
        'success',
      );
      setPublishAction(null);
      setSelected([]);
      await queryClient.invalidateQueries({ queryKey: ['results'] });
    },
    onError: (caught) => {
      toast.notify(caught instanceof ApiError ? caught.message : 'The publication state could not be changed.', 'error');
      setPublishAction(null);
    },
  });

  const columns: Column<ResultRow>[] = [
    ...(isStudent
      ? []
      : ([
          {
            key: 'select',
            header: '',
            render: (row) => (
              <input
                type="checkbox"
                aria-label={`Select result for ${row.student_name}`}
                checked={selected.includes(row.attempt_id ?? row.id)}
                onChange={(event) => {
                  const id = row.attempt_id ?? row.id;
                  setSelected((current) => (event.target.checked ? [...current, id] : current.filter((value) => value !== id)));
                }}
              />
            ),
          },
          {
            key: 'student',
            header: 'Candidate',
            render: (row) => (
              <div>
                <strong>{row.student_name}</strong>
                <div className="text-sm text-muted">
                  {row.student_code}
                  {row.class_name ? ` · ${row.class_name}` : ''}
                </div>
              </div>
            ),
          },
        ] as Column<ResultRow>[])),
    {
      key: 'paper',
      header: 'Assessment',
      render: (row) => (
        <div>
          {row.paper_title}
          <div className="text-sm text-muted">
            {row.kind === 'EXAM' ? 'Examination' : 'Quiz'}
            {row.subject_name ? ` · ${row.subject_name}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'date',
      header: 'Submitted',
      render: (row) => formatDate(row.submitted_at ?? row.created_at),
    },
    {
      key: 'score',
      header: 'Marks',
      align: 'right',
      render: (row) => `${formatMark(row.obtained_marks)} / ${formatMark(row.total_marks)}`,
    },
    { key: 'percentage', header: '%', align: 'right', render: (row) => formatPercentage(row.percentage) },
    { key: 'grade', header: 'Grade', render: (row) => (row.grade ? <Badge tone="info">{row.grade}</Badge> : '—') },
    { key: 'outcome', header: 'Outcome', render: (row) => <StatusBadge status={row.outcome} /> },
    { key: 'examiner', header: 'Marked by', render: (row) => row.examiner_name ?? 'Automatic' },
    {
      key: 'publication',
      header: 'Publication',
      render: (row) => (row.is_published ? <Badge tone="success">Released</Badge> : <Badge tone="outline">Withheld</Badge>),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <Link className="btn btn--sm" to={`/results/${row.id}`}>
          Open
        </Link>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Results"
        description={
          isStudent
            ? 'Results released by your institution. Unpublished results are hidden until they are published.'
            : 'Candidate results across examinations and quizzes, with publication control.'
        }
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Results" value={stats.data?.attempts ?? 0} />
        <StatCard label="Passed" value={stats.data?.passed ?? 0} tone="success" />
        <StatCard label="Failed" value={stats.data?.failed ?? 0} tone="danger" />
        <StatCard label="Pending marking" value={stats.data?.pending ?? 0} tone={stats.data?.pending ? 'warning' : 'neutral'} />
        <StatCard label="Average" value={formatPercentage(stats.data?.averagePercentage ?? 0)} />
        <StatCard label="Highest" value={formatPercentage(stats.data?.highestPercentage ?? 0)} />
        {!isStudent ? <StatCard label="Released" value={stats.data?.published ?? 0} meta={`${(stats.data?.attempts ?? 0) - (stats.data?.published ?? 0)} withheld`} /> : null}
      </div>

      {!isStudent && (stats.data?.attempts ?? 0) > 0 ? (
        <Card title="Outcome distribution">
          <DonutChart
            ariaLabel="Result outcome distribution for the current filters"
            data={[
              { label: 'Passed', value: stats.data?.passed ?? 0, tone: 'success' },
              { label: 'Failed', value: stats.data?.failed ?? 0, tone: 'danger' },
              { label: 'Pending', value: stats.data?.pending ?? 0, tone: 'warning' },
            ]}
          />
        </Card>
      ) : null}

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder={isStudent ? 'Search your results' : 'Search candidate, code or paper'}
              aria-label="Search results"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All examinations"
            options={(exams.data?.data ?? []).map((exam) => ({ value: exam.id, label: exam.name }))}
            value={list.filters.examId}
            onChange={(event) => list.updateFilter('examId', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All subjects"
            options={(subjects.data?.data ?? []).map((subject) => ({ value: subject.id, label: subject.name }))}
            value={list.filters.subjectId}
            onChange={(event) => list.updateFilter('subjectId', event.target.value)}
          />
          {!isStudent ? (
            <SelectInput
              wrapperClassName="filter-bar__field"
              placeholder="All classes"
              options={(classes.data?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
              value={list.filters.classId}
              onChange={(event) => list.updateFilter('classId', event.target.value)}
            />
          ) : null}
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="Any outcome"
            options={[
              { value: 'PASSED', label: 'Passed' },
              { value: 'FAILED', label: 'Failed' },
              { value: 'PENDING', label: 'Pending' },
            ]}
            value={list.filters.outcome}
            onChange={(event) => list.updateFilter('outcome', event.target.value)}
          />
          {!isStudent ? (
            <SelectInput
              wrapperClassName="filter-bar__field"
              placeholder="Any publication state"
              options={[
                { value: 'published', label: 'Released only' },
                { value: 'unpublished', label: 'Withheld only' },
              ]}
              value={list.filters.published}
              onChange={(event) => list.updateFilter('published', event.target.value)}
            />
          ) : null}
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={[
              { value: 'date', label: 'Sort by date' },
              { value: 'percentage', label: 'Sort by percentage' },
              { value: 'student', label: 'Sort by candidate' },
              { value: 'grade', label: 'Sort by grade' },
            ]}
            value={list.filters.sort}
            onChange={(event) => list.updateFilter('sort', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={[
              { value: 'desc', label: 'Descending' },
              { value: 'asc', label: 'Ascending' },
            ]}
            value={list.filters.order}
            onChange={(event) => list.updateFilter('order', event.target.value)}
          />
          <Button size="sm" onClick={list.resetFilters}>
            Clear
          </Button>
        </div>

        {!isStudent && selected.length ? (
          <div className="bulk-bar">
            <span>{selected.length} result(s) selected</span>
            <div className="inline">
              {hasPermission('result.publish') ? (
                <Button size="sm" variant="primary" onClick={() => setPublishAction({ publish: true, attemptIds: selected })}>
                  Publish selected
                </Button>
              ) : null}
              {hasPermission('result.unpublish') ? (
                <Button size="sm" onClick={() => setPublishAction({ publish: false, attemptIds: selected })}>
                  Withhold selected
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                Clear selection
              </Button>
            </div>
          </div>
        ) : null}

        {results.error ? (
          <div className="card__body">
            <ErrorState message="Results could not be loaded." onRetry={() => void results.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={results.data?.data ?? []}
              rowKey={(row) => row.id}
              loading={results.isLoading}
              empty={
                <div>
                  <h3>No results found</h3>
                  <p>{isStudent ? 'Released results will appear here.' : 'Adjust the filters or mark submissions in the grading queue.'}</p>
                </div>
              }
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={results.data?.meta.total ?? 0}
              totalPages={results.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(publishAction)}
        title={publishAction?.publish ? 'Publish selected results' : 'Withhold selected results'}
        message={
          publishAction?.publish
            ? 'Candidates will be notified and can view these results immediately. Published results are not silently altered afterwards.'
            : 'Candidates will no longer see these results. The change is recorded in the audit log.'
        }
        confirmLabel={publishAction?.publish ? 'Publish results' : 'Withhold results'}
        tone={publishAction?.publish ? 'primary' : 'danger'}
        busy={changePublication.isPending}
        onConfirm={() => publishAction && changePublication.mutate(publishAction)}
        onCancel={() => setPublishAction(null)}
      />

      <p className="text-sm text-muted">Generated {formatDateTime(new Date().toISOString())} · statistics follow the filters above.</p>
    </div>
  );
}
