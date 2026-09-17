import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { fromDateTimeLocal, toDateTimeLocal } from '../../lib/format';
import type { ClassRow, Quiz, Subject } from '../../types';
import { QuestionPicker, type PaperQuestion } from '../../components/QuestionPicker';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  PageHeader,
  SelectInput,
  TextArea,
  TextInput,
  useToast,
} from '../../components/ui';
import { IconChevronLeft } from '../../components/Icons';

interface QuizDetailResponse {
  quiz: Quiz;
  questions: {
    question_id: number;
    text: string;
    type: PaperQuestion['type'];
    difficulty: PaperQuestion['difficulty'];
    marks: number;
    negative_marks: number;
    topic: string | null;
    default_marks: number;
    position: number;
    option_count?: number;
  }[];
  assignments: { id: number; class_id: number | null; group_id: number | null; student_id: number | null; class_name?: string | null; group_name?: string | null; student_name?: string | null }[];
}

export default function QuizFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { quizId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [form, setForm] = useState({
    subjectId: '',
    classId: '',
    title: '',
    description: '',
    instructions: '',
    timeLimitMinutes: '15',
    maxAttempts: '1',
    passPercentage: '50',
    availableFrom: toDateTimeLocal(new Date().toISOString()),
    availableUntil: '',
    resultReleaseAt: '',
    randomizeQuestions: true,
    randomizeOptions: true,
    immediateResults: true,
    showCorrectAnswers: false,
    allowReview: true,
    negativeMarking: false,
  });
  const [paper, setPaper] = useState<PaperQuestion[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  const subjects = useQuery({
    queryKey: ['subjects', 'options'],
    queryFn: () => api.list<Subject>('/subjects', { pageSize: 100, status: 'active' }),
    staleTime: 5 * 60_000,
  });

  const classes = useQuery({
    queryKey: ['classes', 'options'],
    queryFn: () => api.list<ClassRow>('/classes', { pageSize: 100, status: 'active' }),
    staleTime: 5 * 60_000,
  });

  const existing = useQuery({
    queryKey: ['quiz', quizId],
    queryFn: () => api.get<QuizDetailResponse>(`/quizzes/${quizId}`),
    enabled: mode === 'edit' && Boolean(quizId),
  });

  useEffect(() => {
    const quiz = existing.data?.quiz;
    if (!quiz) return;
    setForm({
      subjectId: String(quiz.subject_id),
      classId: quiz.class_id ? String(quiz.class_id) : '',
      title: quiz.title,
      description: quiz.description ?? '',
      instructions: quiz.instructions ?? '',
      timeLimitMinutes: String(quiz.time_limit_minutes),
      maxAttempts: String(quiz.max_attempts),
      passPercentage: String(quiz.pass_percentage),
      availableFrom: toDateTimeLocal(quiz.available_from),
      availableUntil: toDateTimeLocal(quiz.available_until),
      resultReleaseAt: toDateTimeLocal(quiz.result_release_at),
      randomizeQuestions: Boolean(quiz.randomize_questions),
      randomizeOptions: Boolean(quiz.randomize_options),
      immediateResults: Boolean(quiz.immediate_results),
      showCorrectAnswers: Boolean(quiz.show_correct_answers),
      allowReview: Boolean(quiz.allow_review),
      negativeMarking: Boolean(quiz.negative_marking),
    });
    setPaper(
      (existing.data?.questions ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((question) => ({
          questionId: question.question_id,
          text: question.text,
          type: question.type,
          difficulty: question.difficulty,
          defaultMarks: question.default_marks,
          marks: question.marks,
          negativeMarks: question.negative_marks,
          topic: question.topic,
          optionCount: question.option_count,
        })),
    );
  }, [existing.data]);

  const totalMarks = useMemo(() => paper.reduce((sum, question) => sum + Number(question.marks || 0), 0), [paper]);

  const clientErrors = useMemo(() => {
    const next: Record<string, string> = {};
    if (!form.subjectId) next.subjectId = 'Select a subject.';
    if (form.title.trim().length < 3) next.title = 'Enter a quiz title.';
    if (!form.timeLimitMinutes || Number(form.timeLimitMinutes) < 1) next.timeLimitMinutes = 'Enter a time limit.';
    if (Number(form.maxAttempts) < 1) next.maxAttempts = 'Allow at least one attempt.';
    if (Number(form.passPercentage) < 0 || Number(form.passPercentage) > 100) next.passPercentage = 'Enter a percentage between 0 and 100.';
    if (!form.availableFrom) next.availableFrom = 'Set when the quiz opens.';
    if (!form.availableUntil) next.availableUntil = 'Set when the quiz closes.';
    if (form.availableFrom && form.availableUntil && new Date(form.availableUntil) <= new Date(form.availableFrom)) {
      next.availableUntil = 'The closing time must be after the opening time.';
    }
    if (!paper.length) next.paper = 'Add at least one question to the quiz.';
    return next;
  }, [form, paper]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        subjectId: Number(form.subjectId),
        classId: form.classId ? Number(form.classId) : null,
        title: form.title.trim(),
        description: form.description.trim() || null,
        instructions: form.instructions.trim() || null,
        questionCount: paper.length,
        timeLimitMinutes: Number(form.timeLimitMinutes),
        maxAttempts: Number(form.maxAttempts),
        passPercentage: Number(form.passPercentage),
        randomizeQuestions: form.randomizeQuestions,
        randomizeOptions: form.randomizeOptions,
        immediateResults: form.immediateResults,
        showCorrectAnswers: form.showCorrectAnswers,
        allowReview: form.allowReview,
        negativeMarking: form.negativeMarking,
        availableFrom: fromDateTimeLocal(form.availableFrom),
        availableUntil: fromDateTimeLocal(form.availableUntil),
        resultReleaseAt: fromDateTimeLocal(form.resultReleaseAt),
        questions: paper.map((question, index) => ({
          questionId: question.questionId,
          marks: Number(question.marks),
          negativeMarks: form.negativeMarking ? Number(question.negativeMarks) : 0,
          position: index + 1,
        })),
      };
      return mode === 'create'
        ? api.post<Quiz>('/quizzes', payload)
        : api.patch<Quiz>(`/quizzes/${quizId}`, payload);
    },
    onSuccess: (quiz) => {
      toast.notify(mode === 'create' ? 'Quiz created. Assign it to candidates to make it visible.' : 'Quiz updated.', 'success');
      navigate(`/quizzes/${quiz.id}`);
    },
    onError: (caught) => {
      if (caught instanceof ApiError) {
        setErrors(caught.fieldErrors());
        setFormError(caught.message);
      } else {
        setFormError('The quiz could not be saved.');
      }
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFormError('');
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) {
      document.querySelector('.field__error')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    save.mutate();
  };

  const errorFor = (field: string) => errors[field] ?? clientErrors[field];
  const locked = mode === 'edit' && Boolean(existing.data && existing.data.quiz.status !== 'DRAFT');

  return (
    <div className="page">
      <PageHeader
        title={mode === 'create' ? 'New quiz' : `Edit ${existing.data?.quiz.title ?? 'quiz'}`}
        description="Quizzes are short, time-limited assessments with immediate feedback options."
        breadcrumbs={[{ label: 'Quizzes', to: '/quizzes' }, { label: mode === 'create' ? 'New' : `#${quizId}` }]}
        actions={
          <Link className="btn" to="/quizzes">
            <IconChevronLeft size={16} /> Back to quizzes
          </Link>
        }
      />

      {locked ? (
        <Alert tone="warning" title="This quiz is no longer a draft">
          Papers are locked once a quiz leaves draft status so that results stay reproducible. Return it to draft on the
          quiz page to make changes.
        </Alert>
      ) : null}

      <form onSubmit={submit} noValidate className="form-layout">
        <div className="form-layout__main">
          {formError && !Object.keys(errors).length ? <Alert tone="danger">{formError}</Alert> : null}

          <Card title="Quiz details">
            <div className="field-row">
              <SelectInput
                label="Subject"
                required
                placeholder="Select a subject"
                value={form.subjectId}
                error={errorFor('subjectId')}
                options={(subjects.data?.data ?? []).map((subject) => ({ value: subject.id, label: `${subject.name} (${subject.code})` }))}
                onChange={(event) => {
                  setForm((current) => ({ ...current, subjectId: event.target.value }));
                  setPaper([]);
                }}
              />
              <SelectInput
                label="Class"
                placeholder="All candidates assigned individually"
                value={form.classId}
                options={(classes.data?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                onChange={(event) => setForm((current) => ({ ...current, classId: event.target.value }))}
              />
            </div>
            <TextInput
              label="Title"
              required
              value={form.title}
              error={errorFor('title')}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
            />
            <TextArea
              label="Description"
              rows={2}
              value={form.description}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
            />
            <TextArea
              label="Instructions"
              rows={3}
              value={form.instructions}
              hint="Shown to candidates before they begin."
              onChange={(event) => setForm((current) => ({ ...current, instructions: event.target.value }))}
            />
          </Card>

          <Card
            title="Questions"
            description="Pick questions from the subject's banks and set the marks for this quiz."
          >
            {errorFor('paper') ? <Alert tone="danger">{errorFor('paper')}</Alert> : null}
            <QuestionPicker
              subjectId={form.subjectId}
              paperQuestions={paper}
              onChange={setPaper}
              showNegativeMarking={form.negativeMarking}
            />
          </Card>
        </div>

        <aside className="form-layout__aside">
          <Card title="Timing">
            <div className="field-row">
              <TextInput
                label="Time limit (minutes)"
                type="number"
                min={1}
                required
                value={form.timeLimitMinutes}
                error={errorFor('timeLimitMinutes')}
                onChange={(event) => setForm((current) => ({ ...current, timeLimitMinutes: event.target.value }))}
              />
              <TextInput
                label="Maximum attempts"
                type="number"
                min={1}
                max={20}
                required
                value={form.maxAttempts}
                error={errorFor('maxAttempts')}
                onChange={(event) => setForm((current) => ({ ...current, maxAttempts: event.target.value }))}
              />
            </div>
            <TextInput
              label="Pass mark (%)"
              type="number"
              min={0}
              max={100}
              step={0.5}
              required
              value={form.passPercentage}
              error={errorFor('passPercentage')}
              onChange={(event) => setForm((current) => ({ ...current, passPercentage: event.target.value }))}
            />
          </Card>

          <Card title="Availability">
            <Field label="Opens" htmlFor="quiz-from" error={errorFor('availableFrom')} required>
              <input
                id="quiz-from"
                type="datetime-local"
                className="input"
                required
                value={form.availableFrom}
                onChange={(event) => setForm((current) => ({ ...current, availableFrom: event.target.value }))}
              />
            </Field>
            <Field label="Closes" htmlFor="quiz-until" error={errorFor('availableUntil')} required>
              <input
                id="quiz-until"
                type="datetime-local"
                className="input"
                required
                value={form.availableUntil}
                onChange={(event) => setForm((current) => ({ ...current, availableUntil: event.target.value }))}
              />
            </Field>
            <Field
              label="Results release"
              htmlFor="quiz-release"
              hint="Optional. Leave empty to release as soon as marking is complete."
            >
              <input
                id="quiz-release"
                type="datetime-local"
                className="input"
                value={form.resultReleaseAt}
                onChange={(event) => setForm((current) => ({ ...current, resultReleaseAt: event.target.value }))}
              />
            </Field>
          </Card>

          <Card title="Delivery options">
            <Checkbox
              label="Randomise question order"
              checked={form.randomizeQuestions}
              onChange={(event) => setForm((current) => ({ ...current, randomizeQuestions: event.target.checked }))}
            />
            <Checkbox
              label="Randomise option order"
              checked={form.randomizeOptions}
              onChange={(event) => setForm((current) => ({ ...current, randomizeOptions: event.target.checked }))}
            />
            <Checkbox
              label="Show results immediately"
              hint="Result summaries are released as soon as marking completes and the release date, if any, has passed."
              checked={form.immediateResults}
              onChange={(event) => setForm((current) => ({ ...current, immediateResults: event.target.checked }))}
            />
            <Checkbox
              label="Allow candidates to review their paper"
              checked={form.allowReview}
              onChange={(event) => setForm((current) => ({ ...current, allowReview: event.target.checked }))}
            />
            <Checkbox
              label="Show correct answers after release"
              checked={form.showCorrectAnswers}
              onChange={(event) => setForm((current) => ({ ...current, showCorrectAnswers: event.target.checked }))}
            />
            <Checkbox
              label="Apply negative marking"
              hint="Uses the negative marks configured on each question."
              checked={form.negativeMarking}
              onChange={(event) => setForm((current) => ({ ...current, negativeMarking: event.target.checked }))}
            />
          </Card>

          <Card title="Summary">
            <dl className="definition-list">
              <dt>Questions</dt>
              <dd>{paper.length}</dd>
              <dt>Total marks</dt>
              <dd>{totalMarks}</dd>
              <dt>Pass mark</dt>
              <dd>
                {((Number(form.passPercentage) || 0) / 100) * totalMarks || 0} marks ({form.passPercentage || 0}%)
              </dd>
            </dl>
          </Card>

          <div className="form-actions">
            <Button type="submit" variant="primary" loading={save.isPending} disabled={locked}>
              {mode === 'create' ? 'Create quiz' : 'Save changes'}
            </Button>
            <Link className="btn" to="/quizzes">
              Cancel
            </Link>
          </div>
        </aside>
      </form>
    </div>
  );
}
