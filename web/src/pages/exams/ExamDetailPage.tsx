import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDateTime, formatDuration, formatMark, formatPercentage } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import {
  EXAM_TYPE_LABELS,
  QUESTION_TYPE_LABELS,
  type AttemptStatus,
  type ClassRow,
  type Exam,
  type ExamAssignment,
  type ExamAttemptRow,
  type ExamQuestionRow,
  type ExamStatus,
  type Group,
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
import { IconPrint } from '../../components/Icons';

interface ExamDetailResponse {
  exam: Exam;
  questions: ExamQuestionRow[];
  assignments: ExamAssignment[];
  gradingScheme: { id: number; name: string; pass_percentage: number } | null;
}

const EXAM_TRANSITIONS: Record<ExamStatus, ExamStatus[]> = {
  DRAFT: ['SCHEDULED', 'ACTIVE', 'ARCHIVED'],
  SCHEDULED: ['ACTIVE', 'DRAFT', 'ARCHIVED'],
  ACTIVE: ['UNDER_REVIEW', 'SCHEDULED', 'ARCHIVED'],
  UNDER_REVIEW: ['PUBLISHED', 'ACTIVE', 'ARCHIVED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
};

const TRANSITION_HINTS: Partial<Record<ExamStatus, string>> = {
  SCHEDULED: 'Candidates see the examination and its opening time, but cannot start before the window opens.',
  ACTIVE: 'Candidates inside the window can start immediately. The question paper becomes read-only.',
  UNDER_REVIEW: 'The paper closes for new attempts and submissions are queued for manual grading.',
  PUBLISHED: 'Results are released to candidates. Publishing requires every written answer to be marked.',
  ARCHIVED: 'The examination is closed permanently. Historical attempts and results remain available.',
  DRAFT: 'Returning to draft unlocks the paper for editing. Existing attempts are preserved.',
};

export default function ExamDetailPage() {
  const { examId } = useParams();
  const { hasPermission, user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [statusTarget, setStatusTarget] = useState<ExamStatus | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [startTarget, setStartTarget] = useState<StartAttemptTarget | null>(null);
  const [publishTarget, setPublishTarget] = useState<{ publish: boolean; attemptIds: number[] } | null>(null);
  const [removeAssignment, setRemoveAssignment] = useState<ExamAssignment | null>(null);
  const [selectedAttempts, setSelectedAttempts] = useState<number[]>([]);

  const detail = useQuery({
    queryKey: ['examination', examId],
    queryFn: () => api.get<ExamDetailResponse>(`/examinations/${examId}`),
  });

  const attempts = useQuery({
    queryKey: ['examination', examId, 'attempts'],
    queryFn: () => api.get<ExamAttemptRow[]>(`/examinations/${examId}/attempts`),
    enabled: hasPermission('exam.view', 'attempt.view.any'),
  });

  const changeStatus = useMutation({
    mutationFn: (status: ExamStatus) => api.post(`/examinations/${examId}/status`, { status }),
    onSuccess: async (_result, status) => {
      toast.notify(`Examination moved to ${status.toLowerCase()}.`, 'success');
      setStatusTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['examination', examId] });
      await queryClient.invalidateQueries({ queryKey: ['examinations'] });
    },
    onError: (error) => {
      toast.notify(error instanceof ApiError ? error.message : 'The status could not be changed.', 'error');
      setStatusTarget(null);
    },
  });

  const publishAll = useMutation({
    mutationFn: () => api.post<{ published: number }>(`/examinations/${examId}/publish-results`),
    onSuccess: async (result) => {
      toast.notify(`${result.published} result(s) released. Candidates have been notified.`, 'success');
      await queryClient.invalidateQueries({ queryKey: ['examination', examId] });
    },
    onError: (error) => toast.notify(error instanceof ApiError ? error.message : 'Results could not be released.', 'error'),
  });

  const publishSelected = useMutation({
    mutationFn: (input: { publish: boolean; attemptIds: number[] }) =>
      api.post<{ updated: number }>(`/examinations/${examId}/results/publish`, input),
    onSuccess: async (result, input) => {
      toast.notify(
        input.publish ? `${result.updated} result(s) released.` : `${result.updated} result(s) withheld.`,
        'success',
      );
      setPublishTarget(null);
      setSelectedAttempts([]);
      await queryClient.invalidateQueries({ queryKey: ['examination', examId] });
    },
    onError: (error) => {
      toast.notify(error instanceof ApiError ? error.message : 'The results could not be updated.', 'error');
      setPublishTarget(null);
    },
  });

  const unassign = useMutation({
    mutationFn: (assignmentId: number) => api.delete(`/examinations/${examId}/assignments/${assignmentId}`),
    onSuccess: async () => {
      setRemoveAssignment(null);
      toast.notify('Assignment removed.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['examination', examId] });
    },
    onError: (error) => {
      setRemoveAssignment(null);
      toast.notify(error instanceof ApiError ? error.message : 'The assignment could not be removed.', 'error');
    },
  });

  const totalMarks = useMemo(
    () => (detail.data?.questions ?? []).reduce((sum, question) => sum + Number(question.marks), 0),
    [detail.data],
  );

  if (detail.isLoading) return <p className="text-muted">Loading examination…</p>;
  if (detail.error || !detail.data) {
    return <ErrorState message="This examination could not be loaded." onRetry={() => void detail.refetch()} />;
  }

  const { exam, questions, assignments, gradingScheme } = detail.data;
  const rows = attempts.data ?? [];
  const isOwner = hasPermission('exam.edit');
  const nextStatuses = EXAM_TRANSITIONS[exam.status] ?? [];
  const publishable = rows.filter((row) => row.status !== 'IN_PROGRESS' && row.result_id);

  return (
    <div className="page">
      <PageHeader
        title={exam.name}
        description={`${exam.code} · ${exam.subject_name ?? ''}${exam.class_name ? ` · ${exam.class_name}` : ''} · ${exam.academic_year}${exam.semester ? ` · ${exam.semester}` : ''}`}
        breadcrumbs={[{ label: 'Examinations', to: '/examinations' }, { label: exam.name }]}
        actions={
          <>
            {user?.role === 'student' ? (
              <Button
                variant="primary"
                onClick={() =>
                  setStartTarget({
                    kind: 'exam',
                    id: exam.id,
                    title: exam.name,
                    instructions: exam.instructions,
                    durationMinutes: exam.duration_minutes,
                    totalMarks,
                    questionCount: questions.length,
                    maxAttempts: exam.max_attempts,
                    endAt: exam.end_at,
                  })
                }
              >
                Start examination
              </Button>
            ) : null}
            {isOwner ? (
              <>
                <Link className="btn" to={`/examinations/${exam.id}/edit`}>
                  Edit
                </Link>
                <Button onClick={() => setAssignOpen(true)}>Assign</Button>
                <Link className="btn" to={`/examinations/${exam.id}/monitor`}>
                  Monitor
                </Link>
                {hasPermission('result.publish') ? (
                  <Button variant="primary" onClick={() => publishAll.mutate()} loading={publishAll.isPending}>
                    Release all results
                  </Button>
                ) : null}
              </>
            ) : null}
          </>
        }
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Status" value={<StatusBadge status={exam.status} size="lg" />} />
        <StatCard label="Questions" value={questions.length} meta={`${totalMarks} marks`} />
        <StatCard label="Pass mark" value={formatMark(exam.pass_marks)} meta={gradingScheme ? gradingScheme.name : 'Institution default scheme'} />
        <StatCard label="Duration" value={formatDuration(exam.duration_minutes)} meta={`${exam.max_attempts} attempt(s)`} />
        <StatCard label="Submissions" value={rows.length} meta={`${rows.filter((row) => row.status === 'IN_PROGRESS').length} in progress`} />
        <StatCard
          label="Awaiting grading"
          value={rows.filter((row) => row.status === 'SUBMITTED' || row.status === 'UNDER_REVIEW').length}
          tone={rows.some((row) => row.status === 'SUBMITTED' || row.status === 'UNDER_REVIEW') ? 'warning' : 'neutral'}
        />
      </div>

      {exam.status === 'ACTIVE' ? (
        <Alert tone="info" title="This examination is live">
          Candidates inside the window can start or continue their attempts. The question paper is read-only while the
          examination is active.
        </Alert>
      ) : null}

      <div className="split-2">
        <Card title="Schedule and settings">
          <DefinitionList
            items={[
              { term: 'Type', description: EXAM_TYPE_LABELS[exam.exam_type] },
              { term: 'Opens', description: formatDateTime(exam.start_at) },
              { term: 'Closes', description: formatDateTime(exam.end_at) },
              { term: 'Duration', description: formatDuration(exam.duration_minutes) },
              { term: 'Results release', description: exam.result_release_at ? formatDateTime(exam.result_release_at) : 'Immediately after marking' },
              { term: 'Question order', description: exam.randomize_questions ? 'Randomised per candidate' : 'Fixed' },
              { term: 'Option order', description: exam.randomize_options ? 'Randomised per candidate' : 'Fixed' },
              { term: 'Negative marking', description: exam.negative_marking ? 'Applied' : 'Not applied' },
              { term: 'Created by', description: exam.created_by_name ?? '—' },
              { term: 'Last updated', description: formatDateTime(exam.updated_at) },
            ]}
          />
          {exam.instructions ? (
            <div className="instructions-block">
              <h3>Candidate instructions</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{exam.instructions}</p>
            </div>
          ) : null}
        </Card>

        <Card title="Assigned candidates" flush>
          <DataTable
            rows={assignments}
            rowKey={(row) => row.id}
            empty={<p>No class, group or candidate has been assigned yet. Candidates cannot see or start this examination.</p>}
            columns={[
              {
                key: 'target',
                header: 'Audience',
                render: (row) => row.class_name ?? row.group_name ?? `${row.student_name ?? 'Candidate'} (${row.student_code ?? ''})`,
              },
              { key: 'type', header: 'Type', render: (row) => <Badge tone="outline">{row.class_id ? 'Class' : row.group_id ? 'Group' : 'Individual'}</Badge> },
              { key: 'assigned_at', header: 'Assigned', render: (row) => formatDateTime(row.assigned_at) },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) =>
                  isOwner ? (
                    <Button size="sm" variant="ghost" onClick={() => setRemoveAssignment(row)}>
                      Remove
                    </Button>
                  ) : null,
              },
            ]}
          />
        </Card>
      </div>

      {isOwner && nextStatuses.length ? (
        <Card title="Lifecycle" description="Only valid transitions are accepted; the server rejects anything else.">
          <div className="inline">
            {nextStatuses.map((status) => (
              <Button key={status} onClick={() => setStatusTarget(status)} variant={status === 'PUBLISHED' ? 'primary' : 'default'}>
                Move to {status.replace('_', ' ').toLowerCase()}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}

      {hasPermission('attempt.view.any') ? (
        <Card
          title="Submissions"
          description="Select submissions to release or withhold individual results."
          flush
          actions={
            <>
              <Button size="sm" onClick={() => printCertificate()}>
                <IconPrint size={15} /> Print list
              </Button>
              <Button
                size="sm"
                disabled={!selectedAttempts.length}
                onClick={() => setPublishTarget({ publish: true, attemptIds: selectedAttempts })}
              >
                Release selected
              </Button>
              <Button
                size="sm"
                disabled={!selectedAttempts.length}
                onClick={() => setPublishTarget({ publish: false, attemptIds: selectedAttempts })}
              >
                Withhold selected
              </Button>
            </>
          }
        >
          <DataTable
            rows={rows}
            rowKey={(row) => row.id}
            loading={attempts.isLoading}
            empty={<p>No candidate has attempted this examination yet.</p>}
            columns={[
              {
                key: 'select',
                header: '',
                render: (row) =>
                  row.result_id && row.status !== 'IN_PROGRESS' ? (
                    <input
                      type="checkbox"
                      aria-label={`Select submission by ${row.student_name}`}
                      checked={selectedAttempts.includes(row.id)}
                      onChange={(event) =>
                        setSelectedAttempts((current) =>
                          event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id),
                        )
                      }
                    />
                  ) : null,
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
              { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status as AttemptStatus} /> },
              { key: 'started', header: 'Started', render: (row) => formatDateTime(row.started_at) },
              { key: 'submitted', header: 'Submitted', render: (row) => (row.submitted_at ? formatDateTime(row.submitted_at) : '—') },
              {
                key: 'score',
                header: 'Score',
                align: 'right',
                render: (row) =>
                  row.percentage === null
                    ? '—'
                    : `${formatMark(row.obtained_marks ?? 0)} / ${formatMark(row.max_marks)} (${formatPercentage(row.percentage)})`,
              },
              { key: 'grade', header: 'Grade', render: (row) => row.grade ?? '—' },
              {
                key: 'result',
                header: 'Result',
                render: (row) =>
                  row.is_published ? (
                    <Badge tone="success">Released</Badge>
                  ) : row.result_id ? (
                    <Badge tone="outline">Withheld</Badge>
                  ) : (
                    <span className="text-sm text-muted">—</span>
                  ),
              },
              {
                key: 'integrity',
                header: 'Integrity',
                render: (row) =>
                  row.integrityFlags ? (
                    <Badge tone="warning">{row.integrityFlags} event(s)</Badge>
                  ) : (
                    <Badge tone="outline">Clean</Badge>
                  ),
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) =>
                  row.status === 'IN_PROGRESS' ? (
                    <span className="text-sm text-muted">Sitting</span>
                  ) : (
                    <div className="table-actions">
                      <Link className="btn btn--sm" to={`/attempts/${row.id}/review`}>
                        Review
                      </Link>
                      {row.result_id ? (
                        <Link className="btn btn--sm" to={`/results/${row.result_id}`}>
                          Result
                        </Link>
                      ) : null}
                    </div>
                  ),
              },
            ]}
          />
        </Card>
      ) : null}

      <Card title="Question paper" description="Question order as stored. Candidate papers may be randomised according to the settings above." flush>
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

      <StartAttemptDialog target={startTarget} open={Boolean(startTarget)} onClose={() => setStartTarget(null)} />

      <AssignModal
        open={assignOpen}
        examId={Number(examId)}
        onClose={() => setAssignOpen(false)}
        onAssigned={async () => {
          setAssignOpen(false);
          await queryClient.invalidateQueries({ queryKey: ['examination', examId] });
        }}
      />

      <ConfirmDialog
        open={Boolean(statusTarget)}
        title={`Move examination to ${statusTarget?.replace('_', ' ').toLowerCase()}`}
        message={statusTarget ? TRANSITION_HINTS[statusTarget] ?? 'The examination status will change.' : ''}
        confirmLabel="Confirm change"
        tone={statusTarget === 'ARCHIVED' ? 'danger' : 'primary'}
        busy={changeStatus.isPending}
        onConfirm={() => statusTarget && changeStatus.mutate(statusTarget)}
        onCancel={() => setStatusTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(publishTarget)}
        title={publishTarget?.publish ? 'Release selected results' : 'Withhold selected results'}
        message={
          publishTarget?.publish
            ? `${publishTarget?.attemptIds.length} candidate result(s) become visible to the candidates and cannot be changed silently afterwards.`
            : `${publishTarget?.attemptIds.length} result(s) will be hidden from candidates again. This action is recorded in the audit log.`
        }
        confirmLabel={publishTarget?.publish ? 'Release results' : 'Withhold results'}
        tone={publishTarget?.publish ? 'primary' : 'danger'}
        busy={publishSelected.isPending}
        onConfirm={() => publishTarget && publishSelected.mutate(publishTarget)}
        onCancel={() => setPublishTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(removeAssignment)}
        title="Remove this assignment"
        message={
          <>
            {removeAssignment?.class_name
              ? `The candidates in ${removeAssignment.class_name} will no longer see this examination.`
              : removeAssignment?.group_name
                ? `The candidates in ${removeAssignment.group_name} will no longer see this examination.`
                : `${removeAssignment?.student_name ?? 'This candidate'} will no longer see this examination.`}{' '}
            Attempts already started or submitted are preserved. An assignment cannot be removed once a candidate has
            attempted the examination.
          </>
        }
        confirmLabel="Remove assignment"
        busy={unassign.isPending}
        onConfirm={() => removeAssignment && unassign.mutate(removeAssignment.id)}
        onCancel={() => setRemoveAssignment(null)}
      />

      {publishable.length === 0 && rows.length > 0 ? (
        <p className="text-sm text-muted">
          Individual result release becomes available once marking is complete for each submission.
        </p>
      ) : null}
    </div>
  );
}

function printCertificate() {
  window.print();
}

function AssignModal({
  open,
  examId,
  onClose,
  onAssigned,
}: {
  open: boolean;
  examId: number;
  onClose: () => void;
  onAssigned: () => Promise<void>;
}) {
  const toast = useToast();
  const [classIds, setClassIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [studentIds, setStudentIds] = useState<string[]>([]);
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
    queryKey: ['examination', examId, 'candidates'],
    queryFn: () => api.get<{ candidates: { id: number; student_code: string; full_name: string; class_name: string | null }[] }>(`/examinations/${examId}/available-candidates`),
    enabled: open,
  });

  const assign = useMutation({
    mutationFn: () =>
      api.post<{ assigned: number }>(`/examinations/${examId}/assign`, {
        classIds: classIds.map(Number),
        groupIds: groupIds.map(Number),
        studentIds: studentIds.map(Number),
      }),
    onSuccess: async (result) => {
      toast.notify(`${result.assigned} assignment(s) added. Candidates have been notified.`, 'success');
      setClassIds([]);
      setGroupIds([]);
      setStudentIds([]);
      await onAssigned();
    },
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'The examination could not be assigned.'),
  });

  const toggle = (list: string[], setList: (value: string[]) => void, value: string) => {
    setList(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  return (
    <Modal
      open={open}
      title="Assign candidates"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            loading={assign.isPending}
            disabled={!classIds.length && !groupIds.length && !studentIds.length}
            onClick={() => {
              setError('');
              assign.mutate();
            }}
          >
            Assign selected
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Alert tone="info">
        Only assigned candidates can see and start this examination. An examination must have at least one assignment
        before it can be published.
      </Alert>

      <h3 className="modal-section-title">Classes</h3>
      <div className="checkbox-grid">
        {(classes.data?.data ?? []).map((row) => (
          <label key={row.id} className="checkbox-card">
            <input
              type="checkbox"
              checked={classIds.includes(String(row.id))}
              onChange={() => toggle(classIds, setClassIds, String(row.id))}
            />
            <span>
              <strong>{row.name}</strong>
              <small>{row.student_count ?? 0} students</small>
            </span>
          </label>
        ))}
      </div>

      <h3 className="modal-section-title">Groups</h3>
      {(groups.data?.data ?? []).length === 0 ? (
        <p className="text-sm text-muted">No study groups have been configured for this institution.</p>
      ) : (
        <div className="checkbox-grid">
          {(groups.data?.data ?? []).map((group) => (
            <label key={group.id} className="checkbox-card">
              <input
                type="checkbox"
                checked={groupIds.includes(String(group.id))}
                onChange={() => toggle(groupIds, setGroupIds, String(group.id))}
              />
              <span>
                <strong>{group.name}</strong>
                <small>{group.member_count ?? 0} members</small>
              </span>
            </label>
          ))}
        </div>
      )}

      <h3 className="modal-section-title">Individual candidates</h3>
      <SelectInput
        label="Add a candidate"
        placeholder="Select a candidate to add"
        options={(candidates.data?.candidates ?? [])
          .filter((candidate) => !studentIds.includes(String(candidate.id)))
          .map((candidate) => ({
            value: candidate.id,
            label: `${candidate.full_name} (${candidate.student_code})${candidate.class_name ? ` — ${candidate.class_name}` : ''}`,
          }))}
        onChange={(event) => {
          if (event.target.value) setStudentIds((current) => [...current, event.target.value]);
        }}
      />
      {studentIds.length ? (
        <ul className="chip-list">
          {studentIds.map((id) => {
            const candidate = candidates.data?.candidates.find((row) => String(row.id) === id);
            return (
              <li key={id}>
                <span>{candidate?.full_name ?? `Candidate #${id}`}</span>
                <button type="button" onClick={() => setStudentIds((current) => current.filter((value) => value !== id))} aria-label="Remove">
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </Modal>
  );
}
