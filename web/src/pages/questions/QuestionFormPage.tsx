import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { QUESTION_TYPE_LABELS, type QuestionDetail, type QuestionType, type QuestionBank, type Subject } from '../../types';
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
import { IconChevronLeft, IconPlus, IconTrash } from '../../components/Icons';

interface OptionRow {
  key: string;
  label: string;
  text: string;
  isCorrect: boolean;
}

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function newOption(label: string): OptionRow {
  return { key: `${label}-${Math.random().toString(36).slice(2, 8)}`, label, text: '', isCorrect: false };
}

export default function QuestionFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { questionId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [form, setForm] = useState({
    questionBankId: searchParams.get('bankId') ?? '',
    subjectId: searchParams.get('subjectId') ?? '',
    type: 'MCQ' as QuestionType,
    text: '',
    explanation: '',
    marks: '1',
    negativeMarks: '0',
    difficulty: 'MEDIUM',
    topic: '',
    tags: '',
    status: 'ACTIVE',
  });
  const [options, setOptions] = useState<OptionRow[]>([
    newOption('A'),
    newOption('B'),
    newOption('C'),
    newOption('D'),
  ]);
  const [answerConfig, setAnswerConfig] = useState({
    acceptedAnswers: '',
    caseSensitive: false,
    allowPartial: false,
    numericTolerance: '0',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  const subjects = useQuery({
    queryKey: ['subjects', 'options'],
    queryFn: () => api.list<Subject>('/subjects', { pageSize: 100, status: 'active' }),
    staleTime: 5 * 60_000,
  });

  const banks = useQuery({
    queryKey: ['question-banks', 'options', form.subjectId],
    queryFn: () =>
      api.list<QuestionBank>('/question-banks', {
        pageSize: 100,
        subjectId: form.subjectId || undefined,
      }),
    staleTime: 60_000,
  });

  const existing = useQuery({
    queryKey: ['question', questionId],
    queryFn: () => api.get<QuestionDetail>(`/questions/${questionId}`),
    enabled: mode === 'edit' && Boolean(questionId),
  });

  useEffect(() => {
    if (mode !== 'edit' || !existing.data) return;
    const question = existing.data;
    setForm({
      questionBankId: String(question.question_bank_id),
      subjectId: String(question.subject_id),
      type: question.type,
      text: question.text,
      explanation: question.explanation ?? '',
      marks: String(question.marks),
      negativeMarks: String(question.negative_marks ?? 0),
      difficulty: question.difficulty,
      topic: question.topic ?? '',
      tags: (JSON.parse(question.tags || '[]') as string[]).join(', '),
      status: question.status,
    });
    setOptions(
      question.options
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((option) => ({
          key: `${option.label}-${option.id ?? Math.random()}`,
          label: option.label,
          text: option.text,
          isCorrect: Boolean(option.is_correct),
        })),
    );
    setAnswerConfig({
      acceptedAnswers: (question.answerKey.acceptedAnswers ?? []).join('\n'),
      caseSensitive: Boolean(question.answerKey.caseSensitive),
      allowPartial: Boolean(question.answerKey.allowPartial),
      numericTolerance: String(question.answerKey.numericTolerance ?? 0),
    });
  }, [existing.data, mode]);

  const isObjective = form.type === 'MCQ' || form.type === 'TRUE_FALSE';

  const setTrueFalse = (type: QuestionType) => {
    setForm((current) => ({ ...current, type }));
    if (type === 'TRUE_FALSE') {
      setOptions([
        { ...newOption('A'), text: 'True', isCorrect: true },
        { ...newOption('B'), text: 'False', isCorrect: false },
      ]);
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        questionBankId: Number(form.questionBankId),
        subjectId: Number(form.subjectId),
        type: form.type,
        text: form.text.trim(),
        explanation: form.explanation.trim() || null,
        marks: Number(form.marks),
        negativeMarks: Number(form.negativeMarks || 0),
        difficulty: form.difficulty,
        topic: form.topic.trim() || null,
        tags: form.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        status: form.status,
      };

      if (isObjective) {
        payload.options = options.map((option, index) => ({
          label: option.label,
          text: option.text.trim(),
          isCorrect: option.isCorrect,
          position: index,
        }));
        payload.answerConfig = { allowPartial: answerConfig.allowPartial };
      } else if (form.type === 'FILL_BLANK') {
        payload.answerConfig = {
          acceptedAnswers: answerConfig.acceptedAnswers
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
          caseSensitive: answerConfig.caseSensitive,
          numericTolerance: Number(answerConfig.numericTolerance || 0),
        };
      }

      return mode === 'create'
        ? api.post<QuestionDetail>('/questions', payload)
        : api.patch<QuestionDetail>(`/questions/${questionId}`, payload);
    },
    onSuccess: (question) => {
      toast.notify(mode === 'create' ? 'Question created.' : 'Question updated.', 'success');
      navigate(`/questions/${question.id}/edit`, { replace: true });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors());
        setFormError(error.message);
      } else {
        setFormError('The question could not be saved.');
      }
    },
  });

  const clientErrors = useMemo(() => {
    const next: Record<string, string> = {};
    if (!form.subjectId) next.subjectId = 'Select a subject.';
    if (!form.questionBankId) next.questionBankId = 'Select a question bank.';
    if (form.text.trim().length < 3) next.text = 'Enter the question text.';
    if (!form.marks || Number(form.marks) < 0.25) next.marks = 'Marks must be at least 0.25.';
    if (Number(form.negativeMarks) < 0) next.negativeMarks = 'Negative marks cannot be negative.';
    if (isObjective) {
      const filled = options.filter((option) => option.text.trim().length > 0);
      if (filled.length < 2) next.options = 'Provide at least two options.';
      if (!options.some((option) => option.isCorrect && option.text.trim())) {
        next.options = 'Mark at least one option as the correct answer.';
      }
    }
    if (form.type === 'FILL_BLANK' && !answerConfig.acceptedAnswers.trim()) {
      next.acceptedAnswers = 'Provide at least one accepted answer.';
    }
    return next;
  }, [form, options, answerConfig, isObjective]);

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

  const subjectOptions = (subjects.data?.data ?? []).map((subject) => ({
    value: subject.id,
    label: `${subject.name} (${subject.code})`,
  }));
  const bankOptions = (banks.data?.data ?? [])
    .filter((bank) => !form.subjectId || String(bank.subject_id) === form.subjectId)
    .map((bank) => ({ value: bank.id, label: bank.name }));

  const errorFor = (field: string) => errors[field] ?? clientErrors[field];

  return (
    <div className="page">
      <PageHeader
        title={mode === 'create' ? 'New question' : 'Edit question'}
        description="Questions are stored inside a bank and can be reused across papers. Once a question has been used in an examination it can be archived but not deleted."
        breadcrumbs={[{ label: 'Questions', to: '/questions' }, { label: mode === 'create' ? 'New' : `#${questionId}` }]}
        actions={
          <Link className="btn" to="/questions">
            <IconChevronLeft size={16} /> Back to questions
          </Link>
        }
      />

      {existing.isLoading ? <p className="text-muted">Loading question…</p> : null}
      {existing.error ? (
        <Alert tone="danger" title="Question unavailable">
          The question could not be loaded. It may have been removed or belong to another institution.
        </Alert>
      ) : null}

      <form onSubmit={submit} noValidate className="form-layout">
        <div className="form-layout__main">
          {formError && !Object.keys(errors).length ? <Alert tone="danger">{formError}</Alert> : null}

          <Card title="Question">
            <div className="field-row">
              <SelectInput
                label="Subject"
                required
                value={form.subjectId}
                error={errorFor('subjectId')}
                placeholder="Select a subject"
                options={subjectOptions}
                onChange={(event) =>
                  setForm((current) => ({ ...current, subjectId: event.target.value, questionBankId: '' }))
                }
              />
              <SelectInput
                label="Question bank"
                required
                value={form.questionBankId}
                error={errorFor('questionBankId')}
                placeholder={form.subjectId ? 'Select a bank' : 'Select a subject first'}
                options={bankOptions}
                disabled={!form.subjectId}
                onChange={(event) => setForm((current) => ({ ...current, questionBankId: event.target.value }))}
              />
            </div>

            <div className="field-row">
              <SelectInput
                label="Question type"
                required
                value={form.type}
                options={Object.entries(QUESTION_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
                onChange={(event) => setTrueFalse(event.target.value as QuestionType)}
              />
              <SelectInput
                label="Difficulty"
                value={form.difficulty}
                options={[
                  { value: 'EASY', label: 'Easy' },
                  { value: 'MEDIUM', label: 'Medium' },
                  { value: 'HARD', label: 'Hard' },
                ]}
                onChange={(event) => setForm((current) => ({ ...current, difficulty: event.target.value }))}
              />
            </div>

            <TextArea
              label="Question text"
              required
              rows={4}
              value={form.text}
              error={errorFor('text')}
              hint="Avoid references to page numbers or colour; questions are shown in multiple contexts."
              onChange={(event) => setForm((current) => ({ ...current, text: event.target.value }))}
            />

            <div className="field-row">
              <TextInput
                label="Marks"
                type="number"
                min={0.25}
                step={0.25}
                required
                value={form.marks}
                error={errorFor('marks')}
                onChange={(event) => setForm((current) => ({ ...current, marks: event.target.value }))}
              />
              <TextInput
                label="Negative marks"
                type="number"
                min={0}
                step={0.25}
                hint="Deducted for an incorrect objective answer. Use 0 for none."
                value={form.negativeMarks}
                error={errorFor('negativeMarks')}
                onChange={(event) => setForm((current) => ({ ...current, negativeMarks: event.target.value }))}
              />
            </div>

            <div className="field-row">
              <TextInput
                label="Topic"
                value={form.topic}
                hint="Used for filtering and reporting."
                onChange={(event) => setForm((current) => ({ ...current, topic: event.target.value }))}
              />
              <TextInput
                label="Tags"
                value={form.tags}
                hint="Comma-separated, for example: recursion, complexity"
                onChange={(event) => setForm((current) => ({ ...current, tags: event.target.value }))}
              />
            </div>
          </Card>

          {isObjective ? (
            <Card
              title="Answer options"
              description="Select the checkbox next to every correct option. Multiple correct options are supported for multiple-choice questions and scored with partial credit when enabled."
              actions={
                form.type === 'MCQ' ? (
                  <Button
                    size="sm"
                    disabled={options.length >= OPTION_LABELS.length}
                    onClick={() => setOptions((current) => [...current, newOption(OPTION_LABELS[current.length])])}
                  >
                    <IconPlus size={15} /> Add option
                  </Button>
                ) : null
              }
            >
              {errorFor('options') ? <Alert tone="danger">{errorFor('options')}</Alert> : null}
              <div className="option-editor">
                {options.map((option, index) => (
                  <div key={option.key} className="option-editor__row">
                    <label className="option-editor__correct">
                      <input
                        type="checkbox"
                        checked={option.isCorrect}
                        aria-label={`Option ${option.label} is correct`}
                        onChange={(event) =>
                          setOptions((current) =>
                            current.map((row, rowIndex) =>
                              rowIndex === index ? { ...row, isCorrect: event.target.checked } : row,
                            ),
                          )
                        }
                      />
                      <span className="option-editor__label">{option.label}</span>
                    </label>
                    <input
                      className="input"
                      value={option.text}
                      placeholder={`Option ${option.label}`}
                      aria-label={`Option ${option.label} text`}
                      onChange={(event) =>
                        setOptions((current) =>
                          current.map((row, rowIndex) => (rowIndex === index ? { ...row, text: event.target.value } : row)),
                        )
                      }
                    />
                    {form.type === 'MCQ' && options.length > 2 ? (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove option ${option.label}`}
                        onClick={() => setOptions((current) => current.filter((_, rowIndex) => rowIndex !== index))}
                      >
                        <IconTrash size={16} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              {form.type === 'MCQ' ? (
                <Checkbox
                  label="Award partial credit"
                  hint="Multi-select questions score proportionally when enabled."
                  checked={answerConfig.allowPartial}
                  onChange={(event) =>
                    setAnswerConfig((current) => ({ ...current, allowPartial: event.target.checked }))
                  }
                />
              ) : null}
            </Card>
          ) : null}

          {form.type === 'FILL_BLANK' ? (
            <Card title="Accepted answers" description="One accepted answer per line. Matching is trimmed and case-insensitive unless specified.">
              <TextArea
                label="Accepted answers"
                rows={4}
                required
                value={answerConfig.acceptedAnswers}
                error={errorFor('acceptedAnswers')}
                onChange={(event) => setAnswerConfig((current) => ({ ...current, acceptedAnswers: event.target.value }))}
              />
              <div className="field-row">
                <TextInput
                  label="Numeric tolerance"
                  type="number"
                  min={0}
                  step={0.01}
                  hint="Absolute tolerance applied when both values are numeric."
                  value={answerConfig.numericTolerance}
                  onChange={(event) => setAnswerConfig((current) => ({ ...current, numericTolerance: event.target.value }))}
                />
                <div className="field">
                  <span className="field__label">Matching</span>
                  <Checkbox
                    label="Case sensitive"
                    checked={answerConfig.caseSensitive}
                    onChange={(event) => setAnswerConfig((current) => ({ ...current, caseSensitive: event.target.checked }))}
                  />
                </div>
              </div>
            </Card>
          ) : null}

          {!isObjective && form.type !== 'FILL_BLANK' ? (
            <Alert tone="info" title="Manually marked">
              {form.type === 'ESSAY' ? 'Essays' : 'Short answers'} are never auto-scored. An examiner awards marks after
              submission, and the awarded marks are recorded in the grading history.
            </Alert>
          ) : null}

          <Card title="Marking explanation">
            <TextArea
              label="Explanation shown after marking"
              rows={3}
              value={form.explanation}
              hint="Displayed with the result when the paper allows review of correct answers."
              onChange={(event) => setForm((current) => ({ ...current, explanation: event.target.value }))}
            />
          </Card>
        </div>

        <aside className="form-layout__aside">
          <Card title="Preview">
            <div className="question-preview">
              <div className="question-preview__meta">
                <span>{QUESTION_TYPE_LABELS[form.type]}</span>
                <span>
                  {form.marks || 0} mark{Number(form.marks) === 1 ? '' : 's'}
                  {Number(form.negativeMarks) > 0 ? ` · −${form.negativeMarks} if wrong` : ''}
                </span>
              </div>
              <p className="question-preview__text">{form.text || 'Question text appears here.'}</p>
              {isObjective ? (
                <ul className="option-list option-list--preview">
                  {options.map((option) => (
                    <li key={option.key} className={`option ${option.isCorrect ? 'option--correct' : ''}`}>
                      <span className="option__label">{option.label}</span>
                      <span className="option__text">{option.text || `Option ${option.label}`}</span>
                      {option.isCorrect ? <span className="option__flag">Correct</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {form.type === 'FILL_BLANK' ? (
                <div className="fill-blank-preview">
                  <input className="input" disabled placeholder="Candidate answer" />
                  <p className="text-sm text-muted">
                    Accepted: {answerConfig.acceptedAnswers.split('\n').filter(Boolean).join(' · ') || 'none yet'}
                  </p>
                </div>
              ) : null}
              {form.type === 'SHORT_ANSWER' || form.type === 'ESSAY' ? (
                <textarea className="textarea" rows={form.type === 'ESSAY' ? 5 : 3} disabled placeholder="Candidate response area" />
              ) : null}
            </div>
          </Card>

          <Card title="Publication">
            <Field label="Question status" htmlFor="question-status">
              <select
                id="question-status"
                className="select"
                value={form.status}
                onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))}
              >
                <option value="ACTIVE">Active — available for new papers</option>
                <option value="ARCHIVED">Archived — hidden from new papers</option>
              </select>
            </Field>
            <p className="text-sm text-muted">
              Archived questions remain part of historical papers and results, so existing examinations keep working.
            </p>
          </Card>

          <div className="form-actions">
            <Button type="submit" variant="primary" loading={save.isPending}>
              {mode === 'create' ? 'Create question' : 'Save changes'}
            </Button>
            <Link className="btn" to="/questions">
              Cancel
            </Link>
          </div>
        </aside>
      </form>
    </div>
  );
}
