import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { formatDuration } from '../lib/format';
import type { StartAttemptResult } from '../types';
import { Alert, Button, DefinitionList, Modal, useToast } from './ui';

export interface StartAttemptTarget {
  kind: 'exam' | 'quiz';
  id: number;
  title: string;
  instructions?: string | null;
  durationMinutes?: number | null;
  totalMarks?: number | null;
  questionCount?: number | null;
  maxAttempts?: number | null;
  attemptsUsed?: number | null;
  endAt?: string | null;
}

/**
 * Confirmation step before an attempt starts. Once the server accepts the request the
 * clock is authoritative, so the candidate is told exactly what to expect first.
 */
export function StartAttemptDialog({
  target,
  open,
  onClose,
}: {
  target: StartAttemptTarget | null;
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!target) return null;

  const remaining =
    target.maxAttempts && target.attemptsUsed !== null && target.attemptsUsed !== undefined
      ? Math.max(0, target.maxAttempts - target.attemptsUsed)
      : null;

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post<StartAttemptResult>('/attempts', {
        [target.kind === 'exam' ? 'examId' : 'quizId']: target.id,
      });
      await queryClient.invalidateQueries({ queryKey: ['attempts'] });
      toast.notify(result.resumed ? 'Resuming your attempt.' : 'Attempt started. Good luck.', 'success');
      navigate(`/attempts/${result.attemptId}/take`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The attempt could not be started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={target.kind === 'exam' ? 'Start examination' : 'Start quiz'}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={start} loading={busy}>
            Start attempt
          </Button>
        </>
      }
    >
      <p className="text-mono" style={{ fontWeight: 600, marginTop: 0 }}>
        {target.title}
      </p>
      <DefinitionList
        items={[
          { term: 'Questions', description: target.questionCount ?? '—' },
          { term: 'Total marks', description: target.totalMarks ?? '—' },
          { term: 'Time allowed', description: target.durationMinutes ? formatDuration(target.durationMinutes) : '—' },
          {
            term: 'Attempts',
            description: remaining === null ? '—' : `${remaining} remaining of ${target.maxAttempts}`,
          },
          {
            term: 'Available until',
            description: target.endAt ? new Date(target.endAt).toLocaleString() : '—',
          },
        ]}
      />
      {target.instructions ? (
        <Alert tone="info" title="Instructions">
          <div style={{ whiteSpace: 'pre-wrap' }}>{target.instructions}</div>
        </Alert>
      ) : null}
      <Alert tone="warning" title="Before you begin">
        The timer is controlled by the examination server and cannot be paused. Answers are saved automatically as you
        work, and the attempt is submitted automatically when the time expires.
      </Alert>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Modal>
  );
}
