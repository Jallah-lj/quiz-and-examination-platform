import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDateTime, formatMark, formatPercentage } from '../../lib/format';
import { QUESTION_TYPE_LABELS, type GradingAttempt } from '../../types';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DefinitionList,
  Loading,
  PageHeader,
  ProgressBar,
  StatCard,
  StatusBadge,
  TextArea,
  TextInput,
  useToast,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';

export default function GradingAttemptPage() {
  const { attemptId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<number, { awardedMarks: string; comment: string }>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [confirmFinalize, setConfirmFinalize] = useState(false);

  const attempt = useQuery({
    queryKey: ['grading', 'attempt', attemptId],
    queryFn: () => api.get<GradingAttempt>(`/grading/attempts/${attemptId}`),
  });

  const history = useQuery({
    queryKey: ['grading', 'attempt', attemptId, 'history'],
    queryFn: () => api.get<GradingAttempt['history']>(`/grading/attempts/${attemptId}/history`),
    enabled: Boolean(attemptId),
  });

  useEffect(() => {
    if (!attempt.data) return;
    const next: Record<number, { awardedMarks: string; comment: string }> = {};
    for (const question of attempt.data.questions) {
      if (question.answer && !question.objective) {
        next[question.answer.id] = {
          awardedMarks: question.answer.awardedMarks === null ? '' : String(question.answer.awardedMarks),
          comment: question.answer.comment ?? '',
        };
      }
    }
    setDrafts(next);
  }, [attempt.data]);

  const saveGrade = useMutation({
    mutationFn: ({ answerId, awardedMarks, comment }: { answerId: number; awardedMarks: number; comment: string | null }) =>
      api.post(`/grading/attempts/${attemptId}/answers/${answerId}`, { awardedMarks, comment }),
    onSuccess: async (_result, variables) => {
      toast.notify('Marks saved.', 'success');
      setErrors((current) => ({ ...current, [variables.answerId]: '' }));
      await queryClient.invalidateQueries({ queryKey: ['grading', 'attempt', attemptId] });
    },
    onError: (caught, variables) => {
      setErrors((current) => ({
        ...current,
        [variables.answerId]: caught instanceof ApiError ? caught.message : 'The marks could not be saved.',
      }));
    },
  });

  const finalize = useMutation({
    mutationFn: () => api.post(`/grading/attempts/${attemptId}/finalize`),
    onSuccess: async () => {
      toast.notify('Submission finalised. The result is ready for publication.', 'success');
      setConfirmFinalize(false);
      await queryClient.invalidateQueries({ queryKey: ['grading'] });
    },
    onError: (caught) => {
      toast.notify(caught instanceof ApiError ? caught.message : 'The submission could not be finalised.', 'error');
      setConfirmFinalize(false);
    },
  });

  const summary = useMemo(() => {
    if (!attempt.data) return { marked: 0, pending: 0, subjective: 0 };
    const subjective = attempt.data.questions.filter((question) => !question.objective && question.answer);
    const marked = subjective.filter((question) => question.answer?.awardedMarks !== null).length;
    return { marked, pending: subjective.length - marked, subjective: subjective.length };
  }, [attempt.data]);

  if (attempt.isLoading) return <Loading label="Loading submission…" />;
  if (attempt.error || !attempt.data) {
    return <ErrorState message="This submission could not be loaded." onRetry={() => void attempt.refetch()} />;
  }

  const { attempt: meta, questions } = attempt.data;
  const canFinalize = meta.status !== 'GRADED';

  return (
    <div className="page">
      <PageHeader
        title={`Grade ${meta.paperTitle}`}
        description={`${meta.studentName} (${meta.studentCode}) · ${meta.kind === 'EXAM' ? 'Examination' : 'Quiz'}${meta.paperCode ? ` · ${meta.paperCode}` : ''}`}
        breadcrumbs={[{ label: 'Grading queue', to: '/grading' }, { label: `Attempt #${attemptId}` }]}
        actions={
          <>
            <Link className="btn" to={`/attempts/${attemptId}/review`}>
              Full review
            </Link>
            <Button variant="primary" disabled={!canFinalize || summary.pending > 0} onClick={() => setConfirmFinalize(true)}>
              Finalise marks
            </Button>
          </>
        }
      />

      {summary.pending > 0 ? (
        <Alert tone="warning" title={`${summary.pending} written answer(s) still unmarked`}>
          Every written answer must be marked before submission can be finalised. Finalising recalculates totals and
          prepares the result for publication.
        </Alert>
      ) : null}

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Status" value={<StatusBadge status={meta.status} size="lg" />} meta={meta.autoSubmitted ? 'Auto-submitted on expiry' : undefined} />
        <StatCard label="Objective marks" value={formatMark(meta.objectiveMarks ?? 0)} meta="Graded automatically" />
        <StatCard label="Written marks" value={formatMark(meta.subjectiveMarks ?? 0)} />
        <StatCard label="Total" value={`${formatMark(meta.obtainedMarks ?? 0)} / ${formatMark(meta.maxMarks)}`} meta={formatPercentage(meta.percentage ?? 0)} />
        <StatCard label="Pass mark" value={meta.examPassMarks === null ? '—' : formatMark(meta.examPassMarks)} meta={meta.passed === null ? undefined : meta.passed ? 'Currently passing' : 'Currently failing'} />
        <StatCard label="Submitted" value={formatDateTime(meta.submittedAt)} />
      </div>

      <Card title="Marking progress">
        <ProgressBar value={summary.subjective ? (summary.marked / summary.subjective) * 100 : 100} tone={summary.pending ? 'warning' : 'success'} />
        <p className="text-sm text-muted">
          {summary.marked} of {summary.subjective} written answers marked.
        </p>
      </Card>

      <Card title="Candidate submission" description="Objective answers are scored automatically; only written answers can be marked by hand." flush>
        <ol className="grading-list">
          {questions.map((question) => {
            const answer = question.answer;
            const draft = answer && !question.objective ? drafts[answer.id] ?? { awardedMarks: '', comment: '' } : null;
            const maxMarks = question.marks;
            return (
              <li key={question.questionId} className="grading-item">
                <div className="grading-item__head">
                  <span className="breakdown__position">Q{question.position}</span>
                  <Badge tone="outline">{QUESTION_TYPE_LABELS[question.type]}</Badge>
                  <span className="text-sm text-muted">
                    {maxMarks} mark{maxMarks === 1 ? '' : 's'}
                    {question.objective ? ' · auto-graded' : ' · manual'}
                  </span>
                  {answer?.awardedMarks !== null && answer?.awardedMarks !== undefined ? (
                    <Badge tone={Number(answer.awardedMarks) >= maxMarks * 0.5 ? 'success' : Number(answer.awardedMarks) > 0 ? 'warning' : 'danger'}>
                      {formatMark(answer.awardedMarks)} awarded
                    </Badge>
                  ) : (
                    <Badge tone="outline">Not marked</Badge>
                  )}
                  {answer?.isFlagged ? <Badge tone="warning">Flagged by candidate</Badge> : null}
                </div>

                <p className="grading-item__question">{question.text}</p>

                {question.objective ? (
                  <ul className="option-list option-list--review">
                    {question.options.map((option) => {
                      const chosen = answer?.selectedOptions.includes(option.label) ?? false;
                      const correct = ((question.correctAnswer?.correctOptions as string[] | undefined) ?? [])
                        .map((label) => label.toUpperCase())
                        .includes(option.label.toUpperCase());
                      return (
                        <li
                          key={option.label}
                          className={['option', chosen ? 'option--selected' : '', correct ? 'option--correct' : ''].filter(Boolean).join(' ')}
                        >
                          <span className="option__label">{option.label}</span>
                          <span className="option__text">{option.text}</span>
                          <span className="option__flags">
                            {chosen ? <span className="option__flag">Chosen</span> : null}
                            {correct ? <span className="option__flag option__flag--correct">Correct</span> : null}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="grading-item__answer">
                    <h4>Candidate answer</h4>
                    <p className="answer-sheet">
                      {answer?.answerText?.trim() ? answer.answerText : <span className="text-muted">No answer was given.</span>}
                    </p>
                    {!answer ? (
                      <Alert tone="info">The candidate did not answer this question. Awarding zero marks is final — leave empty only if a resit is intended.</Alert>
                    ) : null}
                  </div>
                )}

                {draft ? (
                  <div className="grading-item__marking">
                    <TextInput
                      label="Marks awarded"
                      type="number"
                      min={0}
                      max={maxMarks}
                      step={0.25}
                      value={draft.awardedMarks}
                      error={errors[answer?.id ?? 0]}
                      hint={`Out of ${maxMarks}.`}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [answer!.id]: { ...draft, awardedMarks: event.target.value },
                        }))
                      }
                    />
                    <TextArea
                      label="Comment for the candidate"
                      rows={2}
                      value={draft.comment}
                      hint="Optional. Shown with the result when the paper allows review."
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [answer!.id]: { ...draft, comment: event.target.value },
                        }))
                      }
                    />
                    <div className="inline">
                      <Button
                        variant="primary"
                        size="sm"
                        loading={saveGrade.isPending}
                        disabled={draft.awardedMarks === '' || Number(draft.awardedMarks) > maxMarks || Number(draft.awardedMarks) < 0}
                        onClick={() =>
                          answer &&
                          saveGrade.mutate({
                            answerId: answer.id,
                            awardedMarks: Number(draft.awardedMarks),
                            comment: draft.comment.trim() || null,
                          })
                        }
                      >
                        Save marks
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          if (!answer) return;
                          setDrafts((current) => ({ ...current, [answer.id]: { awardedMarks: '0', comment: draft.comment } }));
                        }}
                      >
                        Award zero
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          if (!answer) return;
                          setDrafts((current) => ({ ...current, [answer.id]: { awardedMarks: String(maxMarks), comment: draft.comment } }));
                        }}
                      >
                        Award full marks
                      </Button>
                      {answer?.gradedByName ? (
                        <span className="text-sm text-muted">
                          Last marked by {answer.gradedByName} {answer.gradedAt ? `on ${formatDateTime(answer.gradedAt)}` : ''}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Card>

      <div className="split-2">
        <Card title="Submission metadata">
          <DefinitionList
            items={[
              { term: 'Started', description: formatDateTime(meta.startedAt) },
              { term: 'Submitted', description: formatDateTime(meta.submittedAt) },
              { term: 'Submission type', description: meta.autoSubmitted ? 'Automatic (timer expired)' : 'Manual' },
              { term: 'Total marks', description: `${formatMark(meta.obtainedMarks ?? 0)} of ${formatMark(meta.maxMarks)}` },
              { term: 'Percentage', description: formatPercentage(meta.percentage ?? 0) },
              { term: 'Grade', description: meta.grade ?? 'Not computed yet' },
            ]}
          />
          <Button
            variant="primary"
            disabled={!canFinalize || summary.pending > 0}
            loading={finalize.isPending}
            onClick={() => setConfirmFinalize(true)}
          >
            Finalise marks
          </Button>
        </Card>

        <Card title="Grading history" description="Every mark change is retained for audit purposes." flush>
          {history.isLoading ? (
            <p className="text-muted">Loading history…</p>
          ) : (history.data ?? []).length === 0 ? (
            <p className="text-muted">No grading actions have been recorded for this submission yet.</p>
          ) : (
            <ul className="timeline">
              {(history.data ?? []).map((entry) => (
                <li key={entry.id}>
                  <div className="timeline__marker" aria-hidden="true" />
                  <div>
                    <strong>{entry.action === 'grade' ? 'Marks saved' : entry.action === 'finalize' ? 'Submission finalised' : 'Submission reopened'}</strong>
                    <span className="text-sm text-muted">
                      {entry.actor_name ?? 'System'} · {formatDateTime(entry.created_at)}
                    </span>
                    {entry.comment ? <p>{entry.comment}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmFinalize}
        title="Finalise this submission?"
        message={
          <div>
            <p>
              Totals will be recalculated with the current marks, the grading scheme applied, and the result prepared for
              publication.
            </p>
            <p className="text-sm text-muted">
              The grading history is preserved and provisional results are not released to the candidate until the result is
              published.
            </p>
          </div>
        }
        confirmLabel="Finalise marks"
        tone="primary"
        busy={finalize.isPending}
        onConfirm={() => finalize.mutate()}
        onCancel={() => setConfirmFinalize(false)}
      />
    </div>
  );
}
