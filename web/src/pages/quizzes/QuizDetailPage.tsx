import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDateTime, formatDuration, formatMark, formatPercentage } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import {
  QUESTION_TYPE_LABELS,
  type AttemptStatus,
  type ClassRow,
  type Group,
  type Quiz,
  type QuizStatus,
} from '../../types';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  DefinitionList,
  Modal,
  PageHeader,
  SelectInput,
  StatCard,
  StatusBadge,
  useToast,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { StartAttemptDialog, type StartAttemptTarget } from '../../components/StartAttemptDialog';

interface QuizDetailResponse {
  quiz: Quiz;
  questions: {
    id: number;
    text: string;
    type: keyof typeof QUESTION_TYPE_LABELS;
    topic: string | null;
    difficulty: string;
    marks: number;
    negative_marks: number;
    position: number;
    option_count: number;
  }[];
  assignments: {
    id: number;
    class_id: number | null;
    group_id: number | null;
    student_id: number | null;
    assigned_at: string;
    class_name: string | null;
    group_name: string | null;
    student_name: string | null;
    student_code: string | null;
  }[];
  stats: { attempts: number; in_progress: number; awaiting_grading: number; average_percentage: number };
}

interface QuizAttemptRow {
  id: number;
  attempt_no: number;
  status: AttemptStatus;
  started_at: string;
  submitted_at: string | null;
  obtained_marks: number | null;
  max_marks: number;
  percentage: number | null;
  grade: string | null;
  auto_submitted: number;
  expires_at: string;
  student_name: string;
  student_code: string;
  student_id: number;
  is_published: number | null;
  outcome: string | null;
}

const QUIZ_TRANSITIONS: Record<QuizStatus, QuizStatus[]> = {
  DRAFT: ['SCHEDULED', 'ACTIVE', 'ARCHIVED'],
  SCHEDULED: ['ACTIVE', 'DRAFT', 'ARCHIVED'],
  ACTIVE: ['CLOSED', 'SCHEDULED', 'ARCHIVED'],
  CLOSED: ['ARCHIVED', 'ACTIVE'],
  ARCHIVED: [],
};

export default function QuizDetailPage() {
  const { quizId } = useParams();
  const { hasPermission, user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [startTarget, setStartTarget] = useState<StartAttemptTarget | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [statusTarget, setStatusTarget] = useState<QuizStatus | null>(null);
  const [removeTarget, setRemoveTarget] = useState<QuizDetailResponse['assignments'][number] | null>(null);

  const detail = useQuery({
    queryKey: ['quiz', quizId],
    queryFn: () => api.get<QuizDetailResponse>(`/quizzes/${quizId}`),
  });

  const attempts = useQuery({
    queryKey: ['quiz', quizId, 'attempts'],
    queryFn: () => api.get<QuizAttemptRow[]>(`/quizzes/${quizId}/attempts`),
    enabled: hasPermission('quiz.view', 'quiz.manage', 'attempt.view.any'),
  });

  const changeStatus = useMutation({
    mutationFn: (status: QuizStatus) => api.post(`/quizzes/${quizId}/status`, { status }),
    onSuccess: async (_result, status) => {
      toast.notify(`Quiz moved to ${status.toLowerCase()}.`, 'success');
      setStatusTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['quiz', quizId] });
      await queryClient.invalidateQueries({ queryKey: ['quizzes'] });
    },
    onError: (error) => {
      toast.notify(error instanceof ApiError ? error.message : 'The status could not be changed.', 'error');
      setStatusTarget(null);
    },
  });

  const publishResults = useMutation({
    mutationFn: () => api.post<{ published: number }>(`/quizzes/${quizId}/publish-results`),
    onSuccess: async (result) => {
      toast.notify(`${result.published} result(s) released to candidates.`, 'success');
      await queryClient.invalidateQueries({ queryKey: ['quiz', quizId] });
    },
    onError: (error) => toast.notify(error instanceof ApiError ? error.message : 'Results could not be released.', 'error'),
  });

  const unassign = useMutation({
    mutationFn: (assignmentId: number) => api.delete(`/quizzes/${quizId}/assignments/${assignmentId}`),
    onSuccess: async () => {
      setRemoveTarget(null);
      toast.notify('Assignment removed.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['quiz', quizId] });
    },
    onError: (error) => {
      setRemoveTarget(null);
      toast.notify(error instanceof ApiError ? error.message : 'The assignment could not be removed.', 'error');
    },
  });

  if (detail.isLoading) return <p className="text-muted">Loading quiz…</p>;
  if (detail.error || !detail.data) {
    return <ErrorState message="This quiz could not be loaded." onRetry={() => void detail.refetch()} />;
  }

  const { quiz, questions, assignments, stats } = detail.data;
  const isOwnerOrAdmin = hasPermission('quiz.manage');
  const nextStatuses = QUIZ_TRANSITIONS[quiz.status] ?? [];
  const totalMarks = questions.reduce((sum, question) => sum + Number(question.marks), 0);

  return (
    <div className="page">
      <PageHeader
        title={quiz.title}
        description={`${quiz.subject_name ?? ''}${quiz.class_name ? ` · ${quiz.class_name}` : ''} · created by ${quiz.created_by_name ?? 'unknown'}`}
        breadcrumbs={[{ label: 'Quizzes', to: '/quizzes' }, { label: quiz.title }]}
        actions={
          <>
            {user?.role === 'student' ? (
              <Button
                variant="primary"
                onClick={() =>
                  setStartTarget({
                    kind: 'quiz',
                    id: quiz.id,
                    title: quiz.title,
                    instructions: quiz.instructions,
                    durationMinutes: quiz.time_limit_minutes,
                    totalMarks,
                    questionCount: questions.length,
                    maxAttempts: quiz.max_attempts,
                    endAt: quiz.available_until,
                  })
                }
              >
                Start quiz
              </Button>
            ) : null}
            {isOwnerOrAdmin ? (
              <>
                <Link className="btn" to={`/quizzes/${quiz.id}/edit`}>
                  Edit
                </Link>
                <Button onClick={() => setAssignOpen(true)}>Assign</Button>
                <Button variant="primary" onClick={() => publishResults.mutate()} loading={publishResults.isPending}>
                  Release results
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Status" value={<StatusBadge status={quiz.status} size="lg" />} />
        <StatCard label="Questions" value={questions.length} meta={`${totalMarks} marks`} />
        <StatCard label="Time limit" value={formatDuration(quiz.time_limit_minutes)} meta={`${quiz.max_attempts} attempt(s) allowed`} />
        <StatCard label="Pass mark" value={`${quiz.pass_percentage}%`} />
        <StatCard label="Attempts" value={stats?.attempts ?? 0} meta={`${stats?.in_progress ?? 0} in progress`} />
        <StatCard
          label="Awaiting grading"
          value={stats?.awaiting_grading ?? 0}
          tone={stats?.awaiting_grading ? 'warning' : 'neutral'}
        />
        <StatCard label="Average score" value={formatPercentage(stats?.average_percentage ?? 0)} />
      </div>

      {isOwnerOrAdmin && nextStatuses.length ? (
        <Card title="Lifecycle" description="Status changes are validated on the server; invalid transitions are rejected.">
          <div className="inline">
            {nextStatuses.map((status) => (
              <Button key={status} onClick={() => setStatusTarget(status)} variant={status === 'ACTIVE' ? 'primary' : 'default'}>
                Move to {status.toLowerCase()}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="split-2">
        <Card title="Settings">
          <DefinitionList
            items={[
              { term: 'Opens', description: formatDateTime(quiz.available_from) },
              { term: 'Closes', description: formatDateTime(quiz.available_until) },
              { term: 'Results release', description: quiz.result_release_at ? formatDateTime(quiz.result_release_at) : 'As soon as marking completes' },
              { term: 'Question order', description: quiz.randomize_questions ? 'Randomised per candidate' : 'Fixed' },
              { term: 'Option order', description: quiz.randomize_options ? 'Randomised per candidate' : 'Fixed' },
              { term: 'Negative marking', description: quiz.negative_marking ? 'Applied' : 'Not applied' },
              { term: 'Review allowed', description: quiz.allow_review ? 'Yes' : 'No' },
              { term: 'Correct answers shown', description: quiz.show_correct_answers ? 'Yes, after release' : 'No' },
            ]}
          />
          {quiz.instructions ? (
            <div className="instructions-block">
              <h3>Instructions</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{quiz.instructions}</p>
            </div>
          ) : null}
        </Card>

        <Card title="Assigned to" flush>
          <DataTable
            rows={assignments}
            rowKey={(row) => row.id}
            empty={<p>This quiz is not assigned to anyone yet. Use “Assign” to give candidates access.</p>}
            columns={[
              {
                key: 'target',
                header: 'Audience',
                render: (row) =>
                  row.class_name ?? row.group_name ?? `${row.student_name ?? 'Candidate'} (${row.student_code ?? ''})`,
              },
              {
                key: 'type',
                header: 'Type',
                render: (row) => (
                  <Badge tone="outline">{row.class_id ? 'Class' : row.group_id ? 'Group' : 'Individual'}</Badge>
                ),
              },
              { key: 'assigned', header: 'Assigned', render: (row) => formatDateTime(row.assigned_at) },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) =>
                  isOwnerOrAdmin ? (
                    <Button size="sm" variant="ghost" onClick={() => setRemoveTarget(row)}>
                      Remove
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      </div>

      <Card title="Paper" description="Questions in the order candidates receive them (before any randomisation)." flush>
        <DataTable
          rows={questions}
          rowKey={(row) => row.id}
          empty={<p>No questions have been added.</p>}
          columns={[
            { key: 'position', header: '#', align: 'right', render: (row) => row.position },
            { key: 'text', header: 'Question', render: (row) => <span className="cell-clamp">{row.text}</span> },
            { key: 'type', header: 'Type', render: (row) => <Badge tone="outline">{QUESTION_TYPE_LABELS[row.type]}</Badge> },
            { key: 'topic', header: 'Topic', render: (row) => row.topic ?? '—' },
            { key: 'marks', header: 'Marks', align: 'right', render: (row) => formatMark(row.marks) },
            { key: 'negative', header: 'Negative', align: 'right', render: (row) => (row.negative_marks ? `−${row.negative_marks}` : '—') },
          ]}
        />
      </Card>

      {hasPermission('attempt.view.any') ? (
        <Card title="Attempts" flush>
          <DataTable
            rows={attempts.data ?? []}
            rowKey={(row) => row.id}
            loading={attempts.isLoading}
            empty={<p>No candidate has attempted this quiz yet.</p>}
            columns={[
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
              { key: 'attempt', header: 'Attempt', align: 'right', render: (row) => row.attempt_no },
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
              { key: 'started', header: 'Started', render: (row) => formatDateTime(row.started_at) },
              { key: 'submitted', header: 'Submitted', render: (row) => (row.submitted_at ? formatDateTime(row.submitted_at) : '—') },
              {
                key: 'score',
                header: 'Score',
                align: 'right',
                render: (row) =>
                  row.status === 'IN_PROGRESS'
                    ? '—'
                    : `${formatMark(row.obtained_marks ?? 0)} / ${formatMark(row.max_marks)}${row.grade ? ` (${row.grade})` : ''}`,
              },
              {
                key: 'published',
                header: 'Result',
                render: (row) => (row.is_published ? <Badge tone="success">Released</Badge> : <Badge tone="outline">Held</Badge>),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) =>
                  row.status === 'IN_PROGRESS' ? (
                    <span className="text-sm text-muted">In progress</span>
                  ) : (
                    <div className="table-actions">
                      <Link className="btn btn--sm" to={`/attempts/${row.id}/review`}>
                        Review
                      </Link>
                      <Link className="btn btn--sm" to={`/grading/attempts/${row.id}`}>
                        Grade
                      </Link>
                    </div>
                  ),
              },
            ]}
          />
        </Card>
      ) : null}

      <StartAttemptDialog target={startTarget} open={Boolean(startTarget)} onClose={() => setStartTarget(null)} />

      <AssignModal
        open={assignOpen}
        quizId={Number(quizId)}
        onClose={() => setAssignOpen(false)}
        onAssigned={async () => {
          setAssignOpen(false);
          await queryClient.invalidateQueries({ queryKey: ['quiz', quizId] });
        }}
      />

      <ConfirmDialog
        open={Boolean(statusTarget)}
        title={`Move quiz to ${statusTarget?.toLowerCase()}`}
        message={
          statusTarget === 'ACTIVE'
            ? 'Candidates with access can start the quiz immediately. The paper is locked while the quiz is active.'
            : statusTarget === 'DRAFT'
              ? 'Returning to draft unlocks the paper for editing. Existing attempts and results are preserved.'
              : 'The quiz becomes unavailable for new attempts. Historical attempts and results are preserved.'
        }
        confirmLabel="Confirm change"
        tone={statusTarget === 'ARCHIVED' || statusTarget === 'CLOSED' ? 'danger' : 'primary'}
        busy={changeStatus.isPending}
        onConfirm={() => statusTarget && changeStatus.mutate(statusTarget)}
        onCancel={() => setStatusTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="Remove this assignment"
        message={
          <>
            {removeTarget?.class_name
              ? `The candidates in ${removeTarget.class_name} will no longer see this quiz.`
              : removeTarget?.group_name
                ? `The candidates in ${removeTarget.group_name} will no longer see this quiz.`
                : `${removeTarget?.student_name ?? 'This candidate'} will no longer see this quiz.`}{' '}
            Attempts already started or submitted are preserved. An assignment cannot be removed once a candidate has
            attempted the quiz.
          </>
        }
        confirmLabel="Remove assignment"
        busy={unassign.isPending}
        onConfirm={() => removeTarget && unassign.mutate(removeTarget.id)}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}

function AssignModal({
  open,
  quizId,
  onClose,
  onAssigned,
}: {
  open: boolean;
  quizId: number;
  onClose: () => void;
  onAssigned: () => Promise<void>;
}) {
  const toast = useToast();
  const [classId, setClassId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [studentId, setStudentId] = useState('');
  const [error, setError] = useState('');

  const classes = useQuery({
    queryKey: ['classes', 'options'],
    queryFn: () => api.list<ClassRow>('/classes', { pageSize: 100, status: 'active' }),
    enabled: open,
  });

  const groups = useQuery({
    queryKey: ['groups', 'options'],
    queryFn: () => api.list<Group>('/groups', { pageSize: 100 }),
    enabled: open,
  });

  const candidates = useQuery({
    queryKey: ['quiz', quizId, 'candidates', classId],
    queryFn: () =>
      api.get<{ id: number; student_code: string; full_name: string; class_name: string | null }[]>(
        `/quizzes/${quizId}/available-candidates`,
      ),
    enabled: open,
  });

  const assign = useMutation({
    mutationFn: () =>
      api.post<{ assigned: number }>(`/quizzes/${quizId}/assign`, {
        classIds: classId ? [Number(classId)] : [],
        groupIds: groupId ? [Number(groupId)] : [],
        studentIds: studentId ? [Number(studentId)] : [],
      }),
    onSuccess: async (result) => {
      toast.notify(`${result.assigned} assignment(s) added. Candidates have been notified.`, 'success');
      setClassId('');
      setGroupId('');
      setStudentId('');
      await onAssigned();
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'The quiz could not be assigned.'),
  });

  return (
    <Modal
      open={open}
      title="Assign quiz"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            loading={assign.isPending}
            disabled={!classId && !groupId && !studentId}
            onClick={() => {
              setError('');
              assign.mutate();
            }}
          >
            Assign
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Alert tone="info">
        Assign the quiz to a whole class, a study group, or an individual candidate. Assigned candidates receive a
        notification and the quiz appears in their dashboard during the availability window.
      </Alert>
      <SelectInput
        label="Class"
        placeholder="Select a class"
        options={(classes.data?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
        value={classId}
        onChange={(event) => setClassId(event.target.value)}
      />
      <SelectInput
        label="Group"
        placeholder="Select a group"
        options={(groups.data?.data ?? []).map((row) => ({
          value: row.id,
          label: `${row.name}${row.class_name ? ` — ${row.class_name}` : ''}`,
        }))}
        value={groupId}
        onChange={(event) => setGroupId(event.target.value)}
      />
      <SelectInput
        label="Individual candidate"
        placeholder="Select a candidate"
        options={(candidates.data ?? []).map((row) => ({
          value: row.id,
          label: `${row.full_name} (${row.student_code})`,
        }))}
        value={studentId}
        onChange={(event) => setStudentId(event.target.value)}
      />
    </Modal>
  );
}
