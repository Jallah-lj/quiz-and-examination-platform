import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { fromDateTimeLocal, toDateTimeLocal } from '../../lib/format';
import { EXAM_TYPE_LABELS, type ClassRow, type Exam, type ExamAssignment, type ExamQuestionRow, type ExamType, type GradingScheme, type Subject } from '../../types';
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

interface ExamDetailResponse {
  exam: Exam;
  questions: ExamQuestionRow[];
  assignments: ExamAssignment[];
  gradingScheme: { id: number; name: string; pass_percentage: number } | null;
}

export default function ExamFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { examId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const defaultWindowStart = toDateTimeLocal(new Date(Date.now() + 24 * 3600 * 1000).toISOString());
  const defaultWindowEnd = toDateTimeLocal(new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString());

  const [form, setForm] = useState({
    subjectId: '',
    classId: '',
    name: '',
    code: '',
    academicYear: new Date().getFullYear() + '/' + (new Date().getFullYear() + 1),
    semester: '',
    examType: 'MIDTERM' as ExamType,
    durationMinutes: '60',
    startAt: defaultWindowStart,
    endAt: defaultWindowEnd,
    passMarks: '',
    maxAttempts: '1',
    instructions: '',
    randomizeQuestions: true,
    randomizeOptions: false,
    negativeMarking: false,
    gradingSchemeId: '',
    resultReleaseAt: '',
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

  const schemes = useQuery({
    queryKey: ['grading-schemes', 'options'],
    queryFn: () => api.list<GradingScheme>('/grading-schemes', { pageSize: 50 }),
    staleTime: 5 * 60_000,
  });

  const existing = useQuery({
    queryKey: ['examination', examId],
    queryFn: () => api.get<ExamDetailResponse>(`/examinations/${examId}`),
    enabled: mode === 'edit' && Boolean(examId),
  });

  useEffect(() => {
    const exam = existing.data?.exam;
    if (!exam) return;
    setForm({
      subjectId: String(exam.subject_id),
      classId: exam.class_id ? String(exam.class_id) : '',
      name: exam.name,
      code: exam.code,
      academicYear: exam.academic_year,
      semester: exam.semester ?? '',
      examType: exam.exam_type,
      durationMinutes: String(exam.duration_minutes),
      startAt: toDateTimeLocal(exam.start_at),
      endAt: toDateTimeLocal(exam.end_at),
      passMarks: String(exam.pass_marks),
      maxAttempts: String(exam.max_attempts),
      instructions: exam.instructions ?? '',
      randomizeQuestions: Boolean(exam.randomize_questions),
      randomizeOptions: Boolean(exam.randomize_options),
      negativeMarking: Boolean(exam.negative_marking),
      gradingSchemeId: exam.grading_scheme_id ? String(exam.grading_scheme_id) : '',
      resultReleaseAt: toDateTimeLocal(exam.result_release_at),
    });
    setPaper(
      (existing.data?.questions ?? [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((question) => ({
          questionId: question.id,
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
  const passMarks = Number(form.passMarks || 0);
  const locked = mode === 'edit' && Boolean(existing.data && !['DRAFT', 'SCHEDULED'].includes(existing.data.exam.status));

  const clientErrors = useMemo(() => {
    const next: Record<string, string> = {};
    if (!form.subjectId) next.subjectId = 'Select a subject.';
    if (form.name.trim().length < 3) next.name = 'Enter the examination name.';
    if (form.code.trim().length < 2) next.code = 'Enter a unique code, for example CS201-MID-2026.';
    if (form.academicYear.trim().length < 4) next.academicYear = 'Enter the academic year.';
    if (!form.durationMinutes || Number(form.durationMinutes) < 1) next.durationMinutes = 'Enter the duration in minutes.';
    if (!form.startAt) next.startAt = 'Set the opening date and time.';
    if (!form.endAt) next.endAt = 'Set the closing date and time.';
    if (form.startAt && form.endAt && new Date(form.endAt) <= new Date(form.startAt)) {
      next.endAt = 'The closing time must be after the opening time.';
    }
    if (!paper.length) next.paper = 'Add at least one question.';
    if (totalMarks > 0 && (form.passMarks === '' || passMarks <= 0)) next.passMarks = 'Enter the pass mark.';
    if (totalMarks > 0 && passMarks > totalMarks) next.passMarks = `The pass mark cannot exceed the total of ${totalMarks} marks.`;
    if (Number(form.maxAttempts) < 1) next.maxAttempts = 'Allow at least one attempt.';
    return next;
  }, [form, paper, totalMarks, passMarks]);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        subjectId: Number(form.subjectId),
        classId: form.classId ? Number(form.classId) : null,
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        academicYear: form.academicYear.trim(),
        semester: form.semester.trim() || null,
        examType: form.examType,
        durationMinutes: Number(form.durationMinutes),
        startAt: fromDateTimeLocal(form.startAt),
        endAt: fromDateTimeLocal(form.endAt),
        passMarks,
        maxAttempts: Number(form.maxAttempts),
        instructions: form.instructions.trim() || null,
        randomizeQuestions: form.randomizeQuestions,
        randomizeOptions: form.randomizeOptions,
        negativeMarking: form.negativeMarking,
        gradingSchemeId: form.gradingSchemeId ? Number(form.gradingSchemeId) : null,
        resultReleaseAt: fromDateTimeLocal(form.resultReleaseAt),
        questions: paper.map((question, index) => ({
          questionId: question.questionId,
          marks: Number(question.marks),
          negativeMarks: form.negativeMarking ? Number(question.negativeMarks) : 0,
          position: index + 1,
        })),
      };
      return mode === 'create'
        ? api.post<Exam>('/examinations', payload)
        : api.patch<Exam>(`/examinations/${examId}`, payload);
    },
    onSuccess: (exam) => {
      toast.notify(
        mode === 'create'
          ? 'Examination saved as a draft. Assign candidates and schedule it when ready.'
          : 'Examination updated.',
        'success',
      );
      navigate(`/examinations/${exam.id}`);
    },
    onError: (caught) => {
      if (caught instanceof ApiError) {
        setErrors(caught.fieldErrors());
        setFormError(caught.message);
      } else {
        setFormError('The examination could not be saved.');
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

  return (
    <div className="page">
      <PageHeader
        title={mode === 'create' ? 'New examination' : `Edit ${existing.data?.exam.name ?? 'examination'}`}
        description="Examinations progress through draft, scheduled, active, review and publication. The server validates every transition."
        breadcrumbs={[{ label: 'Examinations', to: '/examinations' }, { label: mode === 'create' ? 'New' : `#${examId}` }]}
        actions={
          <Link className="btn" to="/examinations">
            <IconChevronLeft size={16} /> Back to examinations
          </Link>
        }
      />

      {locked ? (
        <Alert tone="warning" title="This examination is locked">
          The paper is frozen once the examination is active or has submissions, so that results remain reproducible.
          Revert it to draft on the examination page if changes are essential.
        </Alert>
      ) : null}

      <form onSubmit={submit} noValidate className="form-layout">
        <div className="form-layout__main">
          {formError && !Object.keys(errors).length ? <Alert tone="danger">{formError}</Alert> : null}

          <Card title="Examination details">
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
                placeholder="No class (assign individually later)"
                value={form.classId}
                options={(classes.data?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                onChange={(event) => setForm((current) => ({ ...current, classId: event.target.value }))}
              />
            </div>
            <div className="field-row">
              <TextInput
                label="Examination name"
                required
                value={form.name}
                error={errorFor('name')}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
              <TextInput
                label="Examination code"
                required
                value={form.code}
                error={errorFor('code')}
                hint="Must be unique within your institution."
                onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
              />
            </div>
            <div className="field-row">
              <SelectInput
                label="Type"
                required
                value={form.examType}
                options={Object.entries(EXAM_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
                onChange={(event) => setForm((current) => ({ ...current, examType: event.target.value as ExamType }))}
              />
              <TextInput
                label="Academic year"
                required
                value={form.academicYear}
                error={errorFor('academicYear')}
                onChange={(event) => setForm((current) => ({ ...current, academicYear: event.target.value }))}
              />
              <TextInput
                label="Semester / term"
                value={form.semester}
                onChange={(event) => setForm((current) => ({ ...current, semester: event.target.value }))}
              />
            </div>
            <TextArea
              label="Instructions for candidates"
              rows={3}
              value={form.instructions}
              hint="Shown before the attempt starts and in the examination header."
              onChange={(event) => setForm((current) => ({ ...current, instructions: event.target.value }))}
            />
          </Card>

          <Card title="Question paper" description="Questions drawn from the subject's banks. Marks can be overridden per examination.">
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
          <Card title="Schedule">
            <Field label="Opens" htmlFor="exam-start" required error={errorFor('startAt')}>
              <input
                id="exam-start"
                type="datetime-local"
                className="input"
                required
                value={form.startAt}
                onChange={(event) => setForm((current) => ({ ...current, startAt: event.target.value }))}
              />
            </Field>
            <Field label="Closes" htmlFor="exam-end" required error={errorFor('endAt')} hint="Candidates cannot start after this time.">
              <input
                id="exam-end"
                type="datetime-local"
                className="input"
                required
                value={form.endAt}
                onChange={(event) => setForm((current) => ({ ...current, endAt: event.target.value }))}
              />
            </Field>
            <TextInput
              label="Duration (minutes)"
              type="number"
              min={1}
              max={600}
              required
              value={form.durationMinutes}
              error={errorFor('durationMinutes')}
              hint="Counted from the moment the candidate starts."
              onChange={(event) => setForm((current) => ({ ...current, durationMinutes: event.target.value }))}
            />
          </Card>

          <Card title="Marking">
            <dl className="definition-list">
              <dt>Total marks</dt>
              <dd>{totalMarks}</dd>
            </dl>
            <TextInput
              label="Pass mark"
              type="number"
              min={0}
              step={0.5}
              required
              value={form.passMarks}
              error={errorFor('passMarks')}
              hint={totalMarks ? `Out of ${totalMarks} marks.` : 'Add questions to see the total.'}
              onChange={(event) => setForm((current) => ({ ...current, passMarks: event.target.value }))}
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
            <SelectInput
              label="Grading scheme"
              placeholder="Institution default"
              value={form.gradingSchemeId}
              options={(schemes.data?.data ?? []).map((scheme) => ({
                value: scheme.id,
                label: `${scheme.name}${scheme.is_default ? ' (default)' : ''}`,
              }))}
              hint="Determines the letter grade shown with the result."
              onChange={(event) => setForm((current) => ({ ...current, gradingSchemeId: event.target.value }))}
            />
            <Field
              label="Results release"
              htmlFor="exam-release"
              hint="Optional. Results stay withheld until this date and time."
            >
              <input
                id="exam-release"
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
              label="Apply negative marking"
              hint="Uses the negative marks recorded for each question."
              checked={form.negativeMarking}
              onChange={(event) => setForm((current) => ({ ...current, negativeMarking: event.target.checked }))}
            />
          </Card>

          <div className="form-actions">
            <Button type="submit" variant="primary" loading={save.isPending} disabled={locked}>
              {mode === 'create' ? 'Save examination' : 'Save changes'}
            </Button>
            <Link className="btn" to="/examinations">
              Cancel
            </Link>
          </div>
        </aside>
      </form>
    </div>
  );
}
