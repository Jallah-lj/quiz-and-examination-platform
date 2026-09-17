import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatCountdown } from '../../lib/format';
import { useInterval, useScrollLock } from '../../lib/hooks';
import type { AttemptPaper, SubmissionResult } from '../../types';
import { Alert, Badge, Button, ConfirmDialog, Loading, useToast } from '../../components/ui';
import { IconChevronLeft, IconChevronRight, IconClock, IconFlag, IconWarning } from '../../components/Icons';

interface LocalAnswer {
  selectedOptions: string[];
  answerText: string;
  isFlagged: boolean;
  dirty: boolean;
}

const SAVE_DEBOUNCE_MS = 1200;
const HEARTBEAT_MS = 30_000;

export default function TakeAttemptPage() {
  const { attemptId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const paper = useQuery({
    queryKey: ['attempt', attemptId],
    queryFn: () => api.get<AttemptPaper>(`/attempts/${attemptId}`),
    // The running paper is only fetched once; server state arrives through heartbeats.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [answers, setAnswers] = useState<Record<string, LocalAnswer>>({});
  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saveError, setSaveError] = useState('');
  const [connection, setConnection] = useState<'online' | 'offline'>('online');
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<SubmissionResult | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [integrityNotice, setIntegrityNotice] = useState('');
  const [, setClockOffset] = useState(0);
  const offsetRef = useRef(0);
  const deadlineRef = useRef<number | null>(null);
  const timers = useRef<Record<string, number>>({});
  const autoSubmitted = useRef(false);
  const seeded = useRef(false);

  useScrollLock(navOpen);

  /* ---------------------------------------------------------------- seed state */
  useEffect(() => {
    const data = paper.data;
    if (!data || seeded.current) return;
    seeded.current = true;
    const next: Record<string, LocalAnswer> = {};
    for (const question of data.questions) {
      const saved = data.answers[String(question.questionId)];
      next[String(question.questionId)] = {
        selectedOptions: saved?.selectedOptions ?? [],
        answerText: saved?.answerText ?? '',
        isFlagged: saved?.isFlagged ?? false,
        dirty: false,
      };
    }
    setAnswers(next);
    const offset = new Date(data.serverTime).getTime() - Date.now();
    offsetRef.current = offset;
    setClockOffset(offset);
    deadlineRef.current = Date.now() + offset + data.remainingSeconds * 1000;
    setRemaining(data.remainingSeconds);
  }, [paper.data]);

  useEffect(() => {
    if (paper.data && paper.data.attempt.status !== 'IN_PROGRESS' && !submitted) {
      navigate(`/attempts/${attemptId}/review`, { replace: true });
    }
  }, [paper.data, navigate, attemptId, submitted]);

  const questions = paper.data?.questions ?? [];
  const current = questions[index];

  /* ------------------------------------------------------------------- saving */
  const flush = useCallback(
    async (questionId: number, answer: LocalAnswer, reason: 'auto' | 'manual' = 'auto') => {
      setSaving((current) => ({ ...current, [questionId]: true }));
      try {
        await api.patch(`/attempts/${attemptId}/answers/${questionId}`, {
          selectedOptions: answer.selectedOptions,
          answerText: answer.answerText.length ? answer.answerText : null,
          isFlagged: answer.isFlagged,
        });
        setAnswers((current) => {
          const existing = current[String(questionId)];
          if (!existing) return current;
          return { ...current, [String(questionId)]: { ...existing, dirty: false } };
        });
        setSaveError('');
        setConnection('online');
        if (reason === 'manual') toast.notify('Answer saved.', 'success');
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 409) {
          // The server clock expired the attempt: nothing more can be saved.
          setSaveError(caught.message);
          autoSubmitted.current = true;
          setSubmitting(true);
        } else if (caught instanceof ApiError && caught.status === 0) {
          setConnection('offline');
          setSaveError('You appear to be offline. Your last change will be sent when the connection returns.');
        } else if (caught instanceof ApiError) {
          setSaveError(caught.message);
        }
      } finally {
        setSaving((current) => {
          const next = { ...current };
          delete next[questionId];
          return next;
        });
      }
    },
    [attemptId, toast],
  );

  const scheduleSave = useCallback(
    (questionId: number, answer: LocalAnswer, delay = SAVE_DEBOUNCE_MS) => {
      window.clearTimeout(timers.current[String(questionId)]);
      timers.current[String(questionId)] = window.setTimeout(() => {
        void flush(questionId, answer);
      }, delay);
    },
    [flush],
  );

  const updateAnswer = useCallback(
    (questionId: number, patch: Partial<LocalAnswer>, immediate = false) => {
      setAnswers((current) => {
        const existing = current[String(questionId)] ?? {
          selectedOptions: [],
          answerText: '',
          isFlagged: false,
          dirty: false,
        };
        const next = { ...existing, ...patch, dirty: true };
        scheduleSave(questionId, next, immediate ? 0 : SAVE_DEBOUNCE_MS);
        return { ...current, [String(questionId)]: next };
      });
    },
    [scheduleSave],
  );

  /* ------------------------------------------------------------------- timing */
  const syncClock = useCallback((serverTime: string, remainingSeconds: number) => {
    const offset = new Date(serverTime).getTime() - Date.now();
    offsetRef.current = offset;
    setClockOffset(offset);
    // The deadline always comes from server time: refreshing the page, throttling the
    // tab or pausing the machine can never extend the attempt.
    deadlineRef.current = Date.now() + offset + remainingSeconds * 1000;
    setRemaining(remainingSeconds);
  }, []);

  const heartbeat = useCallback(async () => {
    if (submitted) return;
    try {
      const response = await api.post<{ serverTime: string; remainingSeconds: number; status: string }>(
        `/attempts/${attemptId}/heartbeat`,
        { clientRemainingSeconds: Math.max(0, remaining ?? 0) },
      );
      setConnection('online');
      syncClock(response.serverTime, response.remainingSeconds);
      if (response.status !== 'IN_PROGRESS' && !submitted) {
        navigate(`/attempts/${attemptId}/review`, { replace: true });
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 0) setConnection('offline');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId, remaining, submitted, syncClock, navigate]);

  useInterval(() => {
    void heartbeat();
  }, submitted ? null : HEARTBEAT_MS);

  /* --------------------------------------------------------------- submitting */
  const submit = useCallback(
    async (reason: 'manual' | 'time_expired') => {
      if (submitting || submitted) return;
      setSubmitting(true);
      try {
        const finalAnswers = Object.entries(answers)
          .filter(([, answer]) => answer.dirty)
          .map(([questionId, answer]) => ({
            questionId: Number(questionId),
            selectedOptions: answer.selectedOptions,
            answerText: answer.answerText.length ? answer.answerText : null,
            isFlagged: answer.isFlagged,
          }));
        const result = await api.post<SubmissionResult>(`/attempts/${attemptId}/submit`, { reason, finalAnswers });
        setSubmitted(result);
        setConfirmSubmit(false);
      } catch (caught) {
        setSubmitting(false);
        if (caught instanceof ApiError && caught.status === 409) {
          // Already submitted elsewhere (for example by the expiry job).
          navigate(`/attempts/${attemptId}/review`, { replace: true });
          return;
        }
        setSaveError(caught instanceof ApiError ? caught.message : 'The attempt could not be submitted.');
      }
    },
    [answers, attemptId, navigate, submitted, submitting],
  );

  /* ------------------------------------------------------------------ countdown */
  useInterval(
    () => {
      const deadline = deadlineRef.current;
      if (deadline === null) return;
      const next = Math.max(0, Math.ceil((deadline - (Date.now() + offsetRef.current)) / 1000));
      setRemaining(next);
      if (next <= 0 && !autoSubmitted.current) {
        autoSubmitted.current = true;
        void submit('time_expired');
      }
    },
    remaining === null || submitted ? null : 1000,
  );

  useEffect(() => {
    if (!saveError) return;
    const id = window.setTimeout(() => setSaveError(''), 8000);
    return () => window.clearTimeout(id);
  }, [saveError]);

  /* ------------------------------------------------------- integrity reporting */
  useEffect(() => {
    const report = (type: string, detail?: string) => {
      void api.post(`/attempts/${attemptId}/events`, { type, detail }).catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        report('visibility_hidden', 'Candidate switched away from the examination tab.');
        setIntegrityNotice('Leaving the examination tab is recorded and visible to the examiner.');
      } else {
        report('visibility_visible');
      }
    };
    const onBlur = () => report('window_blur', 'Examination window lost focus.');
    const onFocus = () => report('window_focus');
    const onCopy = () => report('copy_attempt', 'Copy was used inside the examination window.');
    const onOnline = () => {
      setConnection('online');
      report('connection_restored');
      void heartbeat();
    };
    const onOffline = () => {
      setConnection('offline');
      report('connection_lost');
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (submitted) return;
      event.preventDefault();
      event.returnValue = '';
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('copy', onCopy);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('copy', onCopy);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [attemptId, heartbeat, submitted]);

  useEffect(() => {
    return () => {
      Object.values(timers.current).forEach((id) => window.clearTimeout(id));
    };
  }, []);

  /* -------------------------------------------------------------- derived state */
  const progress = useMemo(() => {
    const list = Object.values(answers);
    const answered = list.filter((answer) => answer.selectedOptions.length > 0 || answer.answerText.trim().length > 0).length;
    const flagged = list.filter((answer) => answer.isFlagged).length;
    return { answered, flagged, unanswered: questions.length - answered, total: questions.length };
  }, [answers, questions.length]);

  if (paper.isLoading) return <Loading label="Preparing your examination…" />;
  if (paper.error || !paper.data) {
    return (
      <div className="exam-shell exam-shell--message">
        <Alert tone="danger" title="This attempt cannot be opened">
          The attempt could not be loaded. It may have been submitted already, or it may belong to another candidate.
        </Alert>
        <Link className="btn" to="/my-attempts">
          Back to my attempts
        </Link>
      </div>
    );
  }

  const attempt = paper.data.attempt;
  const isObjective = current ? current.type === 'MCQ' || current.type === 'TRUE_FALSE' : false;
  const multipleAnswers = current?.type === 'MCQ' && Boolean(current.answerConfig?.allowPartial);
  const currentAnswer = current ? answers[String(current.questionId)] : undefined;
  const savingCurrent = current ? saving[String(current.questionId)] : false;
  const timerClass = remaining !== null && remaining <= 60 ? 'danger' : remaining !== null && remaining <= 300 ? 'warning' : '';

  if (submitted) {
    return (
      <div className="exam-shell exam-shell--message">
        <div className="exam-submitted">
          <h1>Attempt submitted</h1>
          <p className="text-muted">
            Your answers have been recorded on the server and can no longer be changed.
          </p>
          <div className="exam-submitted__scores">
            <div>
              <span>Objective marks</span>
              <strong>{submitted.objectiveMarks}</strong>
            </div>
            <div>
              <span>Total marks</span>
              <strong>
                {submitted.totalObtained} / {submitted.maxMarks}
              </strong>
            </div>
            {submitted.requiresManualGrading ? (
              <div>
                <span>Written answers</span>
                <strong>Awaiting examiner</strong>
              </div>
            ) : (
              <div>
                <span>Result</span>
                <strong>{submitted.resultPublished ? 'Released' : 'Withheld until release'}</strong>
              </div>
            )}
          </div>
          {submitted.requiresManualGrading ? (
            <Alert tone="info">
              Your paper contains written answers that an examiner marks manually. Your result will be released once
              marking and publication are complete.
            </Alert>
          ) : null}
          <div className="inline">
            <Link className="btn btn--primary" to="/my-attempts">
              My attempts
            </Link>
            {submitted.resultId && submitted.resultPublished ? (
              <Link className="btn" to={`/results/${submitted.resultId}`}>
                View result
              </Link>
            ) : null}
            <Link className="btn" to="/dashboard">
              Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="exam-shell">
      <header className="exam-header">
        <div className="exam-header__identity">
          <span className="exam-header__title">{attempt.title}</span>
          <span className="exam-header__meta">
            {attempt.institutionName}
            {attempt.code ? ` · ${attempt.code}` : ''} · {attempt.studentName} ({attempt.studentCode}) · attempt{' '}
            {attempt.attemptNo}
          </span>
        </div>

        <div className="exam-header__status">
          <span className={`exam-timer ${timerClass ? `exam-timer--${timerClass}` : ''}`} role="timer" aria-live="off">
            <IconClock size={17} />
            <span className="exam-timer__value">{remaining === null ? '--:--' : formatCountdown(remaining)}</span>
            <span className="exam-timer__label">remaining</span>
          </span>
          <span
            className={`connection-chip ${connection === 'offline' ? 'connection-chip--offline' : ''}`}
            title={connection === 'offline' ? 'Changes are queued and sent when the connection returns.' : 'Connected to the examination server.'}
          >
            <span className="connection-chip__dot" aria-hidden="true" />
            {connection === 'offline' ? 'Reconnecting' : 'Connected'}
          </span>
          <button type="button" className="btn btn--sm nav-toggle" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
            Question {index + 1} of {questions.length} · panel
          </button>
        </div>

        <div className="exam-header__progress">
          <div className="exam-progress">
            <div className="exam-progress__bar" style={{ width: `${(progress.answered / Math.max(1, progress.total)) * 100}%` }} />
          </div>
          <span className="text-sm">
            Answered {progress.answered} / {progress.total} · Flagged {progress.flagged}
          </span>
        </div>
      </header>

      <div className="exam-body">
        <main className="exam-main">
          {saveError ? (
            <Alert tone={connection === 'offline' ? 'warning' : 'danger'} title={connection === 'offline' ? 'Connection problem' : 'Could not save'}>
              {saveError}
            </Alert>
          ) : null}
          {integrityNotice ? (
            <Alert tone="warning" title="Invigilation notice" action={<button type="button" className="btn btn--sm" onClick={() => setIntegrityNotice('')}>Dismiss</button>}>
              {integrityNotice}
            </Alert>
          ) : null}

          {current ? (
            <article className="exam-question" key={current.questionId}>
              <div className="exam-question__head">
                <span className="exam-question__number">Question {index + 1}</span>
                <span className="exam-question__marks">
                  {current.marks} mark{current.marks === 1 ? '' : 's'}
                  {current.negativeMarks ? ` · −${current.negativeMarks} if incorrect` : ''}
                </span>
              </div>
              <p className="exam-question__text">{current.text}</p>

              {isObjective ? (
                <ul className="option-list option-list--exam">
                  {current.options.map((option) => {
                    const selected = currentAnswer?.selectedOptions.includes(option.label) ?? false;
                    if (multipleAnswers) {
                      return (
                        <li key={option.label}>
                          <label className={`option ${selected ? 'option--selected' : ''}`}>
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={(event) => {
                                const next = event.target.checked
                                  ? [...(currentAnswer?.selectedOptions ?? []), option.label].sort()
                                  : (currentAnswer?.selectedOptions ?? []).filter((label) => label !== option.label);
                                updateAnswer(current.questionId, { selectedOptions: next }, true);
                              }}
                            />
                            <span className="option__label">{option.label}</span>
                            <span className="option__text">{option.text}</span>
                            {selected ? <span className="option__flag">Selected</span> : null}
                          </label>
                        </li>
                      );
                    }
                    return (
                      <li key={option.label}>
                        <label className={`option ${selected ? 'option--selected' : ''}`}>
                          <input
                            type="radio"
                            name={`question-${current.questionId}`}
                            checked={selected}
                            onChange={() => updateAnswer(current.questionId, { selectedOptions: [option.label] }, true)}
                          />
                          <span className="option__label">{option.label}</span>
                          <span className="option__text">{option.text}</span>
                          {selected ? <span className="option__flag">Selected</span> : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              {current.type === 'FILL_BLANK' ? (
                <div className="answer-area">
                  <label htmlFor={`fill-${current.questionId}`} className="field__label">
                    Your answer
                  </label>
                  <input
                    id={`fill-${current.questionId}`}
                    className="input input--answer"
                    value={currentAnswer?.answerText ?? ''}
                    autoComplete="off"
                    onChange={(event) => updateAnswer(current.questionId, { answerText: event.target.value })}
                    onBlur={() => {
                      if (currentAnswer?.dirty) void flush(current.questionId, currentAnswer, 'auto');
                    }}
                  />
                  <p className="text-sm text-muted">Your answer is saved automatically as you type.</p>
                </div>
              ) : null}

              {current.type === 'SHORT_ANSWER' || current.type === 'ESSAY' ? (
                <div className="answer-area">
                  <label htmlFor={`text-${current.questionId}`} className="field__label">
                    Your answer
                  </label>
                  <textarea
                    id={`text-${current.questionId}`}
                    className="textarea textarea--answer"
                    rows={current.type === 'ESSAY' ? 10 : 4}
                    value={currentAnswer?.answerText ?? ''}
                    onChange={(event) => updateAnswer(current.questionId, { answerText: event.target.value })}
                    onBlur={() => {
                      if (currentAnswer?.dirty) void flush(current.questionId, currentAnswer, 'auto');
                    }}
                  />
                  <div className="answer-area__footer">
                    <span className="text-sm text-muted">
                      {(currentAnswer?.answerText ?? '').length} characters · marked manually by an examiner
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => currentAnswer && void flush(current.questionId, currentAnswer, 'manual')}>
                      Save answer now
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="exam-question__footer">
                <button
                  type="button"
                  className={`flag-button ${currentAnswer?.isFlagged ? 'flag-button--active' : ''}`}
                  aria-pressed={currentAnswer?.isFlagged ?? false}
                  onClick={() =>
                    updateAnswer(current.questionId, { isFlagged: !(currentAnswer?.isFlagged ?? false) }, true)
                  }
                >
                  <IconFlag size={16} />
                  {currentAnswer?.isFlagged ? 'Flagged for review' : 'Mark for review'}
                </button>
                <span className="save-state" aria-live="polite">
                  {savingCurrent ? 'Saving…' : currentAnswer?.dirty ? 'Unsaved changes' : 'All changes saved'}
                </span>
              </div>
            </article>
          ) : (
            <p>This attempt has no questions.</p>
          )}

          <div className="exam-actions">
            <Button onClick={() => setIndex((value) => Math.max(0, value - 1))} disabled={index === 0}>
              <IconChevronLeft size={16} /> Previous
            </Button>
            <div className="inline">
              {index === questions.length - 1 ? (
                <Button variant="primary" onClick={() => setConfirmSubmit(true)}>
                  Review and submit
                </Button>
              ) : (
                <Button variant="primary" onClick={() => setIndex((value) => Math.min(questions.length - 1, value + 1))}>
                  Next <IconChevronRight size={16} />
                </Button>
              )}
              <Button onClick={() => setConfirmSubmit(true)}>Submit attempt</Button>
            </div>
          </div>
        </main>

        <aside className={`exam-nav ${navOpen ? 'exam-nav--open' : ''}`} aria-label="Question navigation">
          <div className="exam-nav__header">
            <h2>Question panel</h2>
            <button type="button" className="icon-button nav-toggle-close" aria-label="Close question panel" onClick={() => setNavOpen(false)}>
              ×
            </button>
          </div>

          <div className="exam-nav__grid">
            {questions.map((question, questionIndex) => {
              const answer = answers[String(question.questionId)];
              const answered = Boolean(answer && (answer.selectedOptions.length > 0 || answer.answerText.trim().length > 0));
              const flagged = Boolean(answer?.isFlagged);
              return (
                <button
                  key={question.questionId}
                  type="button"
                  className={[
                    'exam-nav__item',
                    questionIndex === index ? 'exam-nav__item--current' : '',
                    answered ? 'exam-nav__item--answered' : '',
                    flagged ? 'exam-nav__item--flagged' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-current={questionIndex === index ? 'true' : undefined}
                  aria-label={`Question ${questionIndex + 1}${answered ? ', answered' : ', not answered'}${flagged ? ', flagged for review' : ''}`}
                  onClick={() => {
                    setIndex(questionIndex);
                    setNavOpen(false);
                  }}
                >
                  {questionIndex + 1}
                </button>
              );
            })}
          </div>

          <ul className="exam-nav__legend">
            <li>
              <span className="legend-swatch legend-swatch--answered" aria-hidden="true" /> Answered
            </li>
            <li>
              <span className="legend-swatch legend-swatch--unanswered" aria-hidden="true" /> Not answered
            </li>
            <li>
              <span className="legend-swatch legend-swatch--flagged" aria-hidden="true" /> Flagged for review
            </li>
            <li>
              <span className="legend-swatch legend-swatch--current" aria-hidden="true" /> Current question
            </li>
          </ul>

          <div className="exam-nav__summary">
            <Badge tone="info">{progress.answered} answered</Badge>
            <Badge tone="warning">{progress.unanswered} remaining</Badge>
            {progress.flagged ? <Badge tone="danger">{progress.flagged} flagged</Badge> : null}
          </div>

          <div className="exam-nav__footer">
            <Button variant="primary" className="btn--block" onClick={() => setConfirmSubmit(true)}>
              Submit attempt
            </Button>
            <p className="text-sm text-muted">
              Submitting ends the attempt permanently. The examination closes automatically when the timer reaches zero.
            </p>
          </div>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmSubmit}
        title="Submit this attempt?"
        message={
          <div>
            <p>
              You have answered <strong>{progress.answered}</strong> of <strong>{progress.total}</strong> questions.
              {progress.unanswered > 0 ? ` ${progress.unanswered} question(s) are still unanswered and score zero marks.` : ''}
            </p>
            {progress.flagged > 0 ? <p>{progress.flagged} question(s) are flagged for review.</p> : null}
            <p className="text-sm text-muted">
              Submitted answers are final: the attempt is locked and cannot be edited, and any change is recorded in the
              audit log.
            </p>
          </div>
        }
        confirmLabel="Submit attempt"
        tone="primary"
        busy={submitting}
        onConfirm={() => void submit('manual')}
        onCancel={() => setConfirmSubmit(false)}
      />

      {remaining !== null && remaining <= 120 && !submitted ? (
        <div className="exam-warning" role="status">
          <IconWarning size={16} /> Less than two minutes remaining. The attempt will be submitted automatically.
        </div>
      ) : null}
    </div>
  );
}
