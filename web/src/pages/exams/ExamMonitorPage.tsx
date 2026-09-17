import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useInterval, useServerClock } from '../../lib/hooks';
import type { Exam } from '../../types';
import { Alert, Badge, Button, Card, DataTable, PageHeader, ProgressBar, StatCard, StatusBadge, useToast } from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';

interface MonitorResponse {
  exam: Exam;
  live: {
    id: number;
    attempt_no: number;
    started_at: string;
    expires_at: string;
    last_activity_at: string | null;
    ip_address: string | null;
    student_name: string;
    student_code: string;
    class_name: string | null;
    answers_saved: number;
    total_questions: number;
    integrity_events: number;
  }[];
  summary: {
    total_attempts: number;
    in_progress: number;
    awaiting_review: number;
    graded: number;
    auto_submitted: number;
  };
  serverTime: string;
}

export default function ExamMonitorPage() {
  const { examId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const clock = useServerClock();
  const [autoRefresh, setAutoRefresh] = useState(true);

  const monitor = useQuery({
    queryKey: ['examination', examId, 'monitor'],
    queryFn: () => api.get<MonitorResponse>(`/examinations/${examId}/monitor`),
    refetchInterval: autoRefresh ? 15_000 : false,
  });

  const sync = useCallback(
    (serverTime: string) => {
      clock.sync(serverTime);
    },
    [clock],
  );

  if (monitor.data?.serverTime) sync(monitor.data.serverTime);
  useInterval(() => clock.tick(), 1000);

  if (monitor.isLoading) return <p className="text-muted">Loading invigilation view…</p>;
  if (monitor.error || !monitor.data) {
    return <ErrorState message="The invigilation view could not be loaded." onRetry={() => void monitor.refetch()} />;
  }

  const { exam, live, summary } = monitor.data;

  return (
    <div className="page">
      <PageHeader
        title={`Invigilating ${exam.name}`}
        description={`${exam.code} · live view of candidates currently sitting the paper · server time ${formatDateTime(monitor.data.serverTime)}`}
        breadcrumbs={[{ label: 'Examinations', to: '/examinations' }, { label: exam.name, to: `/examinations/${exam.id}` }, { label: 'Monitor' }]}
        actions={
          <>
            <Button
              onClick={() => {
                setAutoRefresh((value) => !value);
              }}
            >
              {autoRefresh ? 'Pause auto-refresh' : 'Resume auto-refresh'}
            </Button>
            <Button
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ['examination', examId, 'monitor'] });
                toast.notify('Monitor refreshed.', 'info');
              }}
            >
              Refresh now
            </Button>
            <Link className="btn btn--primary" to={`/examinations/${exam.id}`}>
              Examination overview
            </Link>
          </>
        }
      />

      <Alert tone="info" title="What this view can and cannot do">
        Attempts run on the server: the timer, autosave and submission are enforced server-side, and integrity events are
        recorded for review. Browser-based invigilation cannot guarantee that a candidate is not using another device or
        room, so treat these signals as indicators rather than proof.
      </Alert>

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Sitting now" value={summary?.in_progress ?? 0} tone="accent" />
        <StatCard label="Submitted, awaiting review" value={summary?.awaiting_review ?? 0} tone={summary?.awaiting_review ? 'warning' : 'neutral'} />
        <StatCard label="Graded" value={summary?.graded ?? 0} tone="success" />
        <StatCard label="Total attempts" value={summary?.total_attempts ?? 0} />
        <StatCard label="Auto-submitted on expiry" value={summary?.auto_submitted ?? 0} />
      </div>

      <Card
        title="Candidates sitting now"
        description="Time remaining is calculated from the server clock, not the candidate's device."
        flush
      >
        <DataTable
          rows={live}
          rowKey={(row) => row.id}
          empty={<p>No candidate is sitting this examination at the moment.</p>}
          columns={[
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
            {
              key: 'progress',
              header: 'Progress',
              render: (row) => {
                const percent = row.total_questions ? (row.answers_saved / row.total_questions) * 100 : 0;
                return (
                  <div className="progress-cell">
                    <ProgressBar value={percent} />
                    <span className="text-sm text-muted">
                      {row.answers_saved} / {row.total_questions} saved
                    </span>
                  </div>
                );
              },
            },
            {
              key: 'remaining',
              header: 'Time remaining',
              render: (row) => {
                const remainingMs = new Date(row.expires_at).getTime() - clock.now();
                const minutes = Math.max(0, Math.round(remainingMs / 60000));
                return (
                  <span>
                    {minutes} min
                    <div className="text-sm text-muted">ends {formatRelative(row.expires_at)}</div>
                  </span>
                );
              },
            },
            { key: 'started', header: 'Started', render: (row) => formatDateTime(row.started_at) },
            {
              key: 'activity',
              header: 'Last activity',
              render: (row) => (row.last_activity_at ? formatRelative(row.last_activity_at) : '—'),
            },
            {
              key: 'integrity',
              header: 'Integrity events',
              render: (row) =>
                row.integrity_events ? <Badge tone="warning">{row.integrity_events} recorded</Badge> : <Badge tone="outline">None</Badge>,
            },
            {
              key: 'status',
              header: 'Attempt',
              render: () => <StatusBadge status="IN_PROGRESS" />,
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: () => (
                <Link className="btn btn--sm" to={`/examinations/${exam.id}`}>
                  Open examination
                </Link>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
