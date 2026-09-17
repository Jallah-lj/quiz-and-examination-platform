import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime, formatPercentage } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import { useAuth } from '../../context/AuthContext';
import { EXAM_TYPE_LABELS, type ClassRow, type Exam, type StudentDashboard, type Subject } from '../../types';
import {
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
import { StartAttemptDialog, type StartAttemptTarget } from '../../components/StartAttemptDialog';
import { IconPlus, IconSearch } from '../../components/Icons';

export default function ExamsPage() {
  const { hasPermission, user } = useAuth();
  const list = useListState({ subjectId: '', classId: '', status: '', examType: '', mine: '' });
  const [target, setTarget] = useState<StartAttemptTarget | null>(null);
  const isStudent = user?.role === 'student';

  const subjects = useQuery({
    queryKey: ['subjects', 'options'],
    queryFn: () => api.list<Subject>('/subjects', { pageSize: 100 }),
    staleTime: 5 * 60_000,
    enabled: !isStudent,
  });

  const classes = useQuery({
    queryKey: ['classes', 'options'],
    queryFn: () => api.list<ClassRow>('/classes', { pageSize: 100 }),
    staleTime: 5 * 60_000,
    enabled: !isStudent,
  });

  // Candidates list papers through the dashboard endpoint: the examination list requires
  // examiner permissions, and the dashboard payload already scopes papers to the candidate.
  const dashboard = useQuery({
    queryKey: ['dashboard', 'student'],
    queryFn: () => api.get<StudentDashboard>('/dashboard/student'),
    enabled: isStudent,
  });

  const exams = useQuery({
    queryKey: ['examinations', list.query],
    queryFn: () =>
      api.list<Exam>('/examinations', {
        ...list.query,
        subjectId: list.filters.subjectId || undefined,
        classId: list.filters.classId || undefined,
        status: list.filters.status || undefined,
        examType: list.filters.examType || undefined,
        mine: list.filters.mine || undefined,
      }),
    enabled: !isStudent,
  });

  const rows = exams.data?.data ?? [];
  const now = Date.now();

  if (isStudent) {
    return (
      <CandidateExamsView
        dashboard={dashboard.data}
        loading={dashboard.isLoading}
        error={dashboard.error}
        onRetry={() => void dashboard.refetch()}
        onStart={setTarget}
        target={target}
        onCloseTarget={() => setTarget(null)}
      />
    );
  }

  const columns: Column<Exam>[] = [
    {
      key: 'name',
      header: 'Examination',
      render: (row) => (
        <div>
          <Link className="link-strong" to={`/examinations/${row.id}`}>
            {row.name}
          </Link>
          <div className="text-sm text-muted">
            {row.code} · {row.subject_name}
            {row.class_name ? ` · ${row.class_name}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'type', header: 'Type', render: (row) => EXAM_TYPE_LABELS[row.exam_type] ?? row.exam_type },
    {
      key: 'window',
      header: 'Window',
      render: (row) => (
        <span className="text-sm">
          {formatDateTime(row.start_at)}
          <br />
          <span className="text-muted">to {formatDateTime(row.end_at)}</span>
        </span>
      ),
    },
    { key: 'duration', header: 'Duration', align: 'right', render: (row) => `${row.duration_minutes} min` },
    {
      key: 'marks',
      header: 'Marks',
      align: 'right',
      render: (row) => (
        <span>
          {row.total_marks}
          <div className="text-sm text-muted">pass {row.pass_marks}</div>
        </span>
      ),
    },
    {
      key: 'progress',
      header: 'Submissions',
      align: 'right',
      render: (row) => (
        <span>
          {row.attempt_count ?? 0}
          {row.live_attempts ? <div className="text-sm text-muted">{row.live_attempts} in progress</div> : null}
          {row.awaiting_grading ? <div className="text-sm text-warning">{row.awaiting_grading} awaiting grading</div> : null}
        </span>
      ),
    },
    {
      key: 'average',
      header: 'Average',
      align: 'right',
      render: (row) => (row.average_percentage ? formatPercentage(row.average_percentage) : '—'),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => {
        if (isStudent) {
          const open = row.status === 'ACTIVE' && new Date(row.start_at).getTime() <= now && new Date(row.end_at).getTime() >= now;
          if (!open) {
            return <span className="text-sm text-muted">{row.status === 'SCHEDULED' ? 'Opens soon' : 'Closed'}</span>;
          }
          return (
            <Button
              size="sm"
              variant="primary"
              onClick={() =>
                setTarget({
                  kind: 'exam',
                  id: row.id,
                  title: row.name,
                  instructions: row.instructions,
                  durationMinutes: row.duration_minutes,
                  totalMarks: row.total_marks,
                  questionCount: row.question_count,
                  maxAttempts: row.max_attempts,
                  endAt: row.end_at,
                })
              }
            >
              Start
            </Button>
          );
        }
        return (
          <div className="table-actions">
            <Link className="btn btn--sm" to={`/examinations/${row.id}`}>
              Open
            </Link>
            {hasPermission('exam.monitor') ? (
              <Link className="btn btn--sm" to={`/examinations/${row.id}/monitor`}>
                Monitor
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
        title="Examinations"
        description={
          isStudent
            ? 'Examinations assigned to you or your class. The countdown starts when you begin, and the server enforces the clock.'
            : 'Formal examinations with scheduling, assignment and result publication.'
        }
        actions={
          hasPermission('exam.create') ? (
            <Link className="btn btn--primary" to="/examinations/new">
              <IconPlus size={16} /> New examination
            </Link>
          ) : null
        }
      />

      {!isStudent ? (
        <div className="stat-grid stat-grid--compact">
          <StatCard label="Examinations" value={exams.data?.meta.total ?? 0} />
          <StatCard label="Active" value={rows.filter((row) => row.status === 'ACTIVE').length} tone="accent" />
          <StatCard label="Awaiting grading" value={rows.reduce((sum, row) => sum + (row.awaiting_grading ?? 0), 0)} tone="warning" />
          <StatCard label="Live candidates" value={rows.reduce((sum, row) => sum + (row.live_attempts ?? 0), 0)} />
        </div>
      ) : null}

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search by name or code"
              aria-label="Search examinations"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All subjects"
            options={(subjects.data?.data ?? []).map((subject) => ({ value: subject.id, label: subject.name }))}
            value={list.filters.subjectId}
            onChange={(event) => list.updateFilter('subjectId', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All classes"
            options={(classes.data?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
            value={list.filters.classId}
            onChange={(event) => list.updateFilter('classId', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All types"
            options={Object.entries(EXAM_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
            value={list.filters.examType}
            onChange={(event) => list.updateFilter('examType', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All statuses"
            options={[
              { value: 'DRAFT', label: 'Draft' },
              { value: 'SCHEDULED', label: 'Scheduled' },
              { value: 'ACTIVE', label: 'Active' },
              { value: 'UNDER_REVIEW', label: 'Under review' },
              { value: 'PUBLISHED', label: 'Published' },
              { value: 'ARCHIVED', label: 'Archived' },
            ]}
            value={list.filters.status}
            onChange={(event) => list.updateFilter('status', event.target.value)}
          />
          {!isStudent ? (
            <SelectInput
              wrapperClassName="filter-bar__field"
              placeholder="All authors"
              options={[{ value: 'true', label: 'Created by me' }]}
              value={list.filters.mine}
              onChange={(event) => list.updateFilter('mine', event.target.value)}
            />
          ) : null}
        </div>

        {exams.error ? (
          <div className="card__body">
            <ErrorState message="Examinations could not be loaded." onRetry={() => void exams.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              loading={exams.isLoading}
              empty={
                <div>
                  <h3>No examinations found</h3>
                  <p>
                    {isStudent
                      ? 'Examinations assigned to you will appear here once they are scheduled.'
                      : 'Create an examination to schedule a formal assessment.'}
                  </p>
                </div>
              }
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={exams.data?.meta.total ?? 0}
              totalPages={exams.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <StartAttemptDialog target={target} open={Boolean(target)} onClose={() => setTarget(null)} />
    </div>
  );
}

/* ------------------------------------------------------------ candidate view */
function CandidateExamsView({
  dashboard,
  loading,
  error,
  onRetry,
  onStart,
  target,
  onCloseTarget,
}: {
  dashboard: StudentDashboard | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onStart: (target: StartAttemptTarget) => void;
  target: StartAttemptTarget | null;
  onCloseTarget: () => void;
}) {
  const available = dashboard?.availableExams ?? [];
  const upcoming = dashboard?.upcomingExams ?? [];
  const history = (dashboard?.history ?? []).filter((row) => row.kind === 'EXAM');
  const attemptsUsed = available.reduce((sum, exam) => sum + exam.my_attempts, 0);

  return (
    <div className="page">
      <PageHeader
        title="My examinations"
        description="Papers assigned to you by your class, group or directly. An examination can only be opened inside its scheduled window."
        actions={
          <Link className="btn" to="/my-attempts">
            My attempts
          </Link>
        }
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Open now" value={available.length} tone={available.length ? 'success' : 'neutral'} />
        <StatCard label="Starting soon" value={upcoming.length} />
        <StatCard label="Attempts used" value={attemptsUsed} />
        <StatCard label="Awaiting release" value={dashboard?.stats.awaiting_release ?? 0} />
      </div>

      {error ? <ErrorState message="Your examinations could not be loaded." onRetry={onRetry} /> : null}

      <Card
        title="Open for attempt"
        description="The timer starts the moment you begin and runs on the server, not in the browser."
        flush
      >
        <DataTable
          rows={available}
          rowKey={(row) => row.id}
          loading={loading}
          empty={<p>No examination is open for you right now.</p>}
          columns={[
            {
              key: 'name',
              header: 'Examination',
              render: (row) => (
                <div>
                  <strong>{row.name}</strong>
                  <div className="text-sm text-muted">
                    {row.code} · {row.subject_name}
                  </div>
                </div>
              ),
            },
            { key: 'subject', header: 'Subject', render: (row) => row.subject_name },
            { key: 'duration', header: 'Duration', align: 'right', render: (row) => `${row.duration_minutes} min` },
            { key: 'marks', header: 'Total marks', align: 'right', render: (row) => row.total_marks },
            {
              key: 'window',
              header: 'Closes',
              render: (row) => (
                <span>
                  {formatDateTime(row.end_at)}
                  <div className="text-sm text-muted">{row.status === 'SCHEDULED' ? 'Opens on schedule' : 'Open now'}</div>
                </span>
              ),
            },
            {
              key: 'attempts',
              header: 'Attempts',
              align: 'right',
              render: (row) => `${row.my_attempts} / ${row.max_attempts}`,
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (row) => {
                const exhausted = row.my_attempts >= row.max_attempts && row.in_progress === 0;
                return (
                  <div className="table-actions">
                    {row.in_progress > 0 ? (
                      <Link className="btn btn--sm btn--primary" to="/my-attempts">
                        Resume attempt
                      </Link>
                    ) : exhausted ? (
                      <span className="text-sm text-muted">Attempt limit reached</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() =>
                          onStart({
                            kind: 'exam',
                            id: row.id,
                            title: row.name,
                            durationMinutes: row.duration_minutes,
                            totalMarks: row.total_marks,
                            maxAttempts: row.max_attempts,
                            attemptsUsed: row.my_attempts,
                            endAt: row.end_at,
                          })
                        }
                      >
                        Start examination
                      </Button>
                    )}
                  </div>
                );
              },
            },
          ]}
        />
      </Card>

      <Card title="Scheduled to open later" flush>
        <DataTable
          rows={upcoming}
          rowKey={(row) => row.id}
          loading={loading}
          empty={<p>Nothing scheduled ahead.</p>}
          columns={[
            {
              key: 'name',
              header: 'Examination',
              render: (row) => (
                <div>
                  <strong>{row.name}</strong>
                  <div className="text-sm text-muted">
                    {row.code} · {row.subject_name}
                  </div>
                </div>
              ),
            },
            { key: 'opens', header: 'Opens', render: (row) => formatDateTime(row.start_at) },
            { key: 'closes', header: 'Closes', render: (row) => formatDateTime(row.end_at) },
            { key: 'duration', header: 'Duration', align: 'right', render: (row) => `${row.duration_minutes} min` },
            { key: 'marks', header: 'Total marks', align: 'right', render: (row) => row.total_marks },
          ]}
        />
      </Card>

      <Card title="Your examination history" flush>
        <DataTable
          rows={history}
          rowKey={(row) => row.id}
          loading={loading}
          empty={<p>You have not sat an examination yet.</p>}
          columns={[
            { key: 'paper', header: 'Examination', render: (row) => row.paper_title },
            { key: 'started', header: 'Started', render: (row) => formatDateTime(row.started_at) },
            { key: 'submitted', header: 'Submitted', render: (row) => (row.submitted_at ? formatDateTime(row.submitted_at) : '—') },
            {
              key: 'marks',
              header: 'Marks',
              align: 'right',
              render: (row) =>
                row.is_published ? `${row.obtained_marks ?? '—'} / ${row.max_marks}` : <span className="text-muted">Not released</span>,
            },
            {
              key: 'percentage',
              header: 'Percentage',
              align: 'right',
              render: (row) => (row.is_published && row.percentage !== null ? formatPercentage(row.percentage) : '—'),
            },
            { key: 'grade', header: 'Grade', render: (row) => (row.is_published ? row.grade ?? '—' : <span className="text-muted">—</span>) },
            {
              key: 'status',
              header: 'Status',
              render: (row) => <StatusBadge status={String(row.status)} />,
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (row) =>
                row.is_published && row.result_id ? (
                  <Link className="link-strong" to={`/results/${row.result_id}`}>
                    View result
                  </Link>
                ) : (
                  <Link className="link-strong" to={`/attempts/${row.id}/review`}>
                    Review
                  </Link>
                ),
            },
          ]}
        />
      </Card>

      <StartAttemptDialog target={target} open={Boolean(target)} onClose={onCloseTarget} />
    </div>
  );
}
