import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime, formatPercentage } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import type { Quiz, StudentDashboard, Subject } from '../../types';
import { useAuth } from '../../context/AuthContext';
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

export default function QuizzesPage() {
  const { hasPermission, user } = useAuth();
  const list = useListState({ subjectId: '', status: '', mine: '' });
  const [target, setTarget] = useState<StartAttemptTarget | null>(null);
  const isCandidateOnly = user?.role === 'student';

  const subjects = useQuery({
    queryKey: ['subjects', 'options'],
    queryFn: () => api.list<Subject>('/subjects', { pageSize: 100 }),
    staleTime: 5 * 60_000,
    enabled: !isCandidateOnly,
  });

  // Candidates see only the quizzes assigned to them, delivered by the dashboard endpoint
  // (the quiz list itself requires examiner permissions).
  const dashboard = useQuery({
    queryKey: ['dashboard', 'student'],
    queryFn: () => api.get<StudentDashboard>('/dashboard/student'),
    enabled: isCandidateOnly,
  });

  const quizzes = useQuery({
    queryKey: ['quizzes', list.query],
    queryFn: () =>
      api.list<Quiz>('/quizzes', {
        ...list.query,
        subjectId: list.filters.subjectId || undefined,
        status: list.filters.status || undefined,
        mine: list.filters.mine || undefined,
      }),
    enabled: !isCandidateOnly,
  });

  if (isCandidateOnly) {
    return (
      <CandidateQuizzesView
        dashboard={dashboard.data}
        loading={dashboard.isLoading}
        error={dashboard.error}
        onRetry={() => void dashboard.refetch()}
        target={target}
        onStart={setTarget}
        onCloseTarget={() => setTarget(null)}
      />
    );
  }

  const rows = quizzes.data?.data ?? [];

  const columns: Column<Quiz>[] = [
    {
      key: 'title',
      header: 'Quiz',
      render: (row) => (
        <div>
          <Link className="link-strong" to={`/quizzes/${row.id}`}>
            {row.title}
          </Link>
          <div className="text-sm text-muted">
            {row.subject_name}
            {row.class_name ? ` · ${row.class_name}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'questions', header: 'Questions', align: 'right', render: (row) => row.attached_questions ?? row.question_count },
    { key: 'time', header: 'Time', align: 'right', render: (row) => `${row.time_limit_minutes} min` },
    { key: 'attempts', header: 'Attempts', align: 'right', render: (row) => `${row.attempt_count ?? 0}` },
    { key: 'pass', header: 'Pass mark', align: 'right', render: (row) => `${row.pass_percentage}%` },
    {
      key: 'window',
      header: 'Availability',
      render: (row) => (
        <span className="text-sm">
          {formatDateTime(row.available_from)}
          <br />
          {formatDateTime(row.available_until)}
        </span>
      ),
    },
    { key: 'average', header: 'Average', align: 'right', render: (row) => (row.average_percentage ? formatPercentage(row.average_percentage) : '—') },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) =>
        isCandidateOnly ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              setTarget({
                kind: 'quiz',
                id: row.id,
                title: row.title,
                instructions: row.instructions,
                durationMinutes: row.time_limit_minutes,
                maxAttempts: row.max_attempts,
                endAt: row.available_until,
              })
            }
          >
            Start
          </Button>
        ) : (
          <div className="table-actions">
            <Link className="btn btn--sm" to={`/quizzes/${row.id}`}>
              Open
            </Link>
            {hasPermission('quiz.manage') ? (
              <Link className="btn btn--sm" to={`/quizzes/${row.id}/edit`}>
                Edit
              </Link>
            ) : null}
          </div>
        ),
    },
  ];

  const openQuizzes = rows.filter((row) => row.status === 'ACTIVE').length;

  return (
    <div className="page">
      <PageHeader
        title={isCandidateOnly ? 'Quizzes' : 'Quizzes'}
        description={
          isCandidateOnly
            ? 'Quizzes assigned to you or your class. Start a quiz to begin its countdown.'
            : 'Short time-limited assessments, separate from formal examinations.'
        }
        actions={
          hasPermission('quiz.manage') ? (
            <Link className="btn btn--primary" to="/quizzes/new">
              <IconPlus size={16} /> New quiz
            </Link>
          ) : null
        }
      />

      {!isCandidateOnly ? (
        <div className="stat-grid stat-grid--compact">
          <StatCard label="Quizzes listed" value={quizzes.data?.meta.total ?? 0} />
          <StatCard label="Open on this page" value={openQuizzes} tone="success" />
          <StatCard label="Attempts recorded" value={rows.reduce((sum, row) => sum + (row.attempt_count ?? 0), 0)} />
        </div>
      ) : null}

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search quizzes"
              aria-label="Search quizzes"
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
            placeholder="All statuses"
            options={[
              { value: 'DRAFT', label: 'Draft' },
              { value: 'SCHEDULED', label: 'Scheduled' },
              { value: 'ACTIVE', label: 'Active' },
              { value: 'CLOSED', label: 'Closed' },
              { value: 'ARCHIVED', label: 'Archived' },
            ]}
            value={list.filters.status}
            onChange={(event) => list.updateFilter('status', event.target.value)}
          />
          {!isCandidateOnly ? (
            <SelectInput
              wrapperClassName="filter-bar__field"
              placeholder="All authors"
              options={[{ value: 'true', label: 'Created by me' }]}
              value={list.filters.mine}
              onChange={(event) => list.updateFilter('mine', event.target.value)}
            />
          ) : null}
        </div>

        {quizzes.error ? (
          <div className="card__body">
            <ErrorState message="Quizzes could not be loaded." onRetry={() => void quizzes.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              loading={quizzes.isLoading}
              empty={
                <div>
                  <h3>{isCandidateOnly ? 'No quizzes available' : 'No quizzes yet'}</h3>
                  <p>
                    {isCandidateOnly
                      ? 'Quizzes assigned to you appear here while their availability window is open.'
                      : 'Create a quiz to run a short formative assessment.'}
                  </p>
                </div>
              }
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={quizzes.data?.meta.total ?? 0}
              totalPages={quizzes.data?.meta.totalPages ?? 1}
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
function CandidateQuizzesView({
  dashboard,
  loading,
  error,
  onRetry,
  target,
  onStart,
  onCloseTarget,
}: {
  dashboard: StudentDashboard | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  target: StartAttemptTarget | null;
  onStart: (target: StartAttemptTarget) => void;
  onCloseTarget: () => void;
}) {
  const open = dashboard?.availableQuizzes ?? [];
  const history = (dashboard?.history ?? []).filter((row) => row.kind === 'QUIZ');

  return (
    <div className="page">
      <PageHeader
        title="My quizzes"
        description="Short assessments assigned to you. Results are released according to each quiz's settings."
        actions={
          <Link className="btn" to="/my-attempts">
            My attempts
          </Link>
        }
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Available now" value={open.length} tone={open.length ? 'success' : 'neutral'} />
        <StatCard label="Attempts used" value={open.reduce((sum, quiz) => sum + quiz.my_attempts, 0)} />
        <StatCard label="Graded attempts" value={dashboard?.stats.graded ?? 0} />
        <StatCard label="Awaiting release" value={dashboard?.stats.awaiting_release ?? 0} />
      </div>

      {error ? <ErrorState message="Your quizzes could not be loaded." onRetry={onRetry} /> : null}

      <Card title="Open for attempt" flush>
        <DataTable
          rows={open}
          rowKey={(row) => row.id}
          loading={loading}
          empty={<p>No quiz is open for you right now.</p>}
          columns={[
            {
              key: 'title',
              header: 'Quiz',
              render: (row) => (
                <div>
                  <strong>{row.title}</strong>
                  <div className="text-sm text-muted">{row.subject_name}</div>
                </div>
              ),
            },
            { key: 'window', header: 'Available until', render: (row) => formatDateTime(row.available_until) },
            { key: 'time', header: 'Time limit', align: 'right', render: (row) => `${row.time_limit_minutes} min` },
            { key: 'pass', header: 'Pass mark', align: 'right', render: (row) => `${row.pass_percentage}%` },
            { key: 'attempts', header: 'Attempts', align: 'right', render: (row) => `${row.my_attempts} / ${row.max_attempts}` },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (row) => (
                <div className="table-actions">
                  {row.my_attempts >= row.max_attempts ? (
                    <Link className="link-strong" to="/my-attempts">
                      View attempt
                    </Link>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        onStart({
                          kind: 'quiz',
                          id: row.id,
                          title: row.title,
                          durationMinutes: row.time_limit_minutes,
                          maxAttempts: row.max_attempts,
                          attemptsUsed: row.my_attempts,
                          endAt: row.available_until,
                        })
                      }
                    >
                      Start quiz
                    </Button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Your quiz history" flush>
        <DataTable
          rows={history}
          rowKey={(row) => row.id}
          loading={loading}
          empty={<p>You have not attempted a quiz yet.</p>}
          columns={[
            { key: 'paper', header: 'Quiz', render: (row) => row.paper_title },
            { key: 'started', header: 'Started', render: (row) => formatDateTime(row.started_at) },
            {
              key: 'marks',
              header: 'Marks',
              align: 'right',
              render: (row) => (row.is_published ? `${row.obtained_marks ?? '—'} / ${row.max_marks}` : <span className="text-muted">Not released</span>),
            },
            {
              key: 'percentage',
              header: 'Percentage',
              align: 'right',
              render: (row) => (row.is_published && row.percentage !== null ? formatPercentage(row.percentage) : '—'),
            },
            { key: 'status', header: 'Status', render: (row) => <StatusBadge status={String(row.status)} /> },
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
