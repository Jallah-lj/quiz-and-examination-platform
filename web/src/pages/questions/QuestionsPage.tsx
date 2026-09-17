import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import {
  QUESTION_TYPE_LABELS,
  type QuestionBank,
  type QuestionDetail,
  type QuestionListItem,
  type Subject,
} from '../../types';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Modal,
  PageHeader,
  Pagination,
  SelectInput,
  StatusBadge,
  TextArea,
  useToast,
  type Column,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { IconDownload, IconEdit, IconEye, IconPlus, IconSearch, IconTrash } from '../../components/Icons';

interface Facets {
  topics: string[];
  tags: string[];
  counts: { type: string; difficulty: string; count: number }[];
}

export default function QuestionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();

  const list = useListState(
    {
      subjectId: searchParams.get('subjectId') ?? '',
      questionBankId: searchParams.get('bankId') ?? '',
      type: searchParams.get('type') ?? '',
      difficulty: '',
      status: 'ACTIVE',
      topic: '',
      // Seeded from the examiner dashboard's data-quality link, e.g.
      // /questions?mine=true&missingExplanation=true. The controls below stay visible.
      mine: searchParams.get('mine') === 'true' || searchParams.get('mine') === '1' ? 'true' : '',
      missingExplanation: searchParams.get('missingExplanation') === 'true' ? 'true' : '',
      sort: 'updated',
      order: 'desc',
    },
    20,
  );

  const [previewId, setPreviewId] = useState<number | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<QuestionListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<QuestionListItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);

  const subjects = useQuery({
    queryKey: ['subjects', 'options'],
    queryFn: () => api.list<Subject>('/subjects', { pageSize: 100 }),
    staleTime: 5 * 60_000,
  });

  const banks = useQuery({
    queryKey: ['question-banks', 'options', list.filters.subjectId],
    queryFn: () => api.list<QuestionBank>('/question-banks', { pageSize: 100, subjectId: list.filters.subjectId || undefined }),
  });

  const facets = useQuery({
    queryKey: ['questions', 'facets'],
    queryFn: () => api.get<Facets>('/questions/facets'),
  });

  const questions = useQuery({
    queryKey: ['questions', list.query],
    queryFn: () =>
      api.list<QuestionListItem>('/questions', {
        ...list.query,
        subjectId: list.filters.subjectId || undefined,
        questionBankId: list.filters.questionBankId || undefined,
        type: list.filters.type || undefined,
        difficulty: list.filters.difficulty || undefined,
        status: list.filters.status || undefined,
        topic: list.filters.topic || undefined,
        mine: list.filters.mine || undefined,
        missingExplanation: list.filters.missingExplanation || undefined,
      }),
  });

  const archive = useMutation({
    mutationFn: (question: QuestionListItem) =>
      api.post(`/questions/${question.id}/archive`, { archived: question.status !== 'ARCHIVED' }),
    onSuccess: async () => {
      toast.notify('Question status updated.', 'success');
      setArchiveTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['questions'] });
    },
    onError: (error) => toast.notify(error instanceof ApiError ? error.message : 'The question could not be updated.', 'error'),
  });

  const remove = useMutation({
    mutationFn: (question: QuestionListItem) => api.delete(`/questions/${question.id}`),
    onSuccess: async () => {
      toast.notify('Question deleted.', 'success');
      setDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['questions'] });
    },
    onError: (error) => {
      toast.notify(
        error instanceof ApiError ? error.message : 'The question could not be deleted.',
        'error',
      );
      setDeleteTarget(null);
    },
  });

  const bulkArchive = useMutation({
    mutationFn: (ids: number[]) => api.post('/questions/bulk-archive', { ids }),
    onSuccess: async (_, ids) => {
      toast.notify(`${ids.length} question(s) archived.`, 'success');
      setSelected([]);
      await queryClient.invalidateQueries({ queryKey: ['questions'] });
    },
    onError: (error) => toast.notify(error instanceof ApiError ? error.message : 'The selected questions could not be archived.', 'error'),
  });

  const columns: Column<QuestionListItem>[] = [
    {
      key: 'select',
      header: '',
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`Select question ${row.id}`}
          checked={selected.includes(row.id)}
          onChange={(event) =>
            setSelected((current) => (event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id)))
          }
        />
      ),
    },
    {
      key: 'text',
      header: 'Question',
      mobileLabel: 'Question',
      render: (row) => (
        <div className="cell-stack">
          <span className="cell-clamp">{row.text}</span>
          <span className="text-sm text-muted">
            #{row.id} · {row.subject_name} · {row.bank_name}
          </span>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => <Badge tone="outline">{QUESTION_TYPE_LABELS[row.type]}</Badge>,
    },
    { key: 'topic', header: 'Topic', render: (row) => row.topic || <span className="text-muted">—</span> },
    { key: 'difficulty', header: 'Difficulty', render: (row) => <StatusBadge status={row.difficulty} /> },
    { key: 'marks', header: 'Marks', align: 'right', render: (row) => row.marks },
    {
      key: 'usage',
      header: 'Used in',
      align: 'right',
      render: (row) => (
        <span className="text-sm">
          {row.used_in_exams ?? 0} exam(s), {row.used_in_quizzes ?? 0} quiz(zes)
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'updated', header: 'Updated', render: (row) => formatDate(row.updated_at) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div className="table-actions">
          <button type="button" className="icon-button" aria-label={`Preview question ${row.id}`} onClick={() => setPreviewId(row.id)}>
            <IconEye size={16} />
          </button>
          <Link className="icon-button" aria-label={`Edit question ${row.id}`} to={`/questions/${row.id}/edit`}>
            <IconEdit size={16} />
          </Link>
          <button
            type="button"
            className="icon-button"
            aria-label={row.status === 'ARCHIVED' ? `Restore question ${row.id}` : `Archive question ${row.id}`}
            onClick={() => setArchiveTarget(row)}
          >
            {row.status === 'ARCHIVED' ? <IconDownload size={16} /> : <IconTrash size={16} />}
          </button>
          {(row.used_in_exams ?? 0) === 0 && (row.used_in_quizzes ?? 0) === 0 ? (
            <button
              type="button"
              className="icon-button icon-button--danger"
              aria-label={`Delete question ${row.id}`}
              onClick={() => setDeleteTarget(row)}
            >
              <IconTrash size={16} />
            </button>
          ) : null}
        </div>
      ),
    },
  ];

  const total = questions.data?.meta.total ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Questions"
        description="Search, filter and maintain the questions available to your examinations. Questions used in historical papers can be archived but never deleted."
        actions={
          <>
            <Button onClick={() => setImportOpen(true)}>
              <IconDownload size={16} /> Import CSV
            </Button>
            <Link className="btn btn--primary" to="/questions/new">
              <IconPlus size={16} /> New question
            </Link>
          </>
        }
      />

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search question text, topic or explanation"
              aria-label="Search questions"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={(subjects.data?.data ?? []).map((subject) => ({ value: subject.id, label: subject.name }))}
            placeholder="All subjects"
            value={list.filters.subjectId}
            onChange={(event) => list.updateFilter('subjectId', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={(banks.data?.data ?? []).map((bank) => ({ value: bank.id, label: bank.name }))}
            placeholder="All banks"
            value={list.filters.questionBankId}
            onChange={(event) => list.updateFilter('questionBankId', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={Object.entries(QUESTION_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
            placeholder="All types"
            value={list.filters.type}
            onChange={(event) => list.updateFilter('type', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={[
              { value: 'EASY', label: 'Easy' },
              { value: 'MEDIUM', label: 'Medium' },
              { value: 'HARD', label: 'Hard' },
            ]}
            placeholder="All difficulties"
            value={list.filters.difficulty}
            onChange={(event) => list.updateFilter('difficulty', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={[
              { value: 'ACTIVE', label: 'Active' },
              { value: 'ARCHIVED', label: 'Archived' },
            ]}
            placeholder="All statuses"
            value={list.filters.status}
            onChange={(event) => list.updateFilter('status', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={(facets.data?.topics ?? []).map((topic) => ({ value: topic, label: topic }))}
            placeholder="All topics"
            value={list.filters.topic}
            onChange={(event) => list.updateFilter('topic', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={[{ value: 'true', label: 'Authored by me' }]}
            placeholder="All authors"
            value={list.filters.mine}
            onChange={(event) => list.updateFilter('mine', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            options={[{ value: 'true', label: 'Explanation missing' }]}
            placeholder="Any explanation"
            value={list.filters.missingExplanation}
            onChange={(event) => list.updateFilter('missingExplanation', event.target.value)}
          />
          <Button
            size="sm"
            onClick={() => {
              list.resetFilters();
              setSearchParams({}, { replace: true });
            }}
          >
            Clear
          </Button>
        </div>

        {selected.length ? (
          <div className="bulk-bar">
            <span>{selected.length} selected</span>
            <div className="inline">
              <Button size="sm" onClick={() => bulkArchive.mutate(selected)} loading={bulkArchive.isPending}>
                Archive selected
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                Clear selection
              </Button>
            </div>
          </div>
        ) : null}

        {questions.error ? (
          <div className="card__body">
            <ErrorState message="Questions could not be loaded." onRetry={() => void questions.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={questions.data?.data ?? []}
              rowKey={(row) => row.id}
              loading={questions.isLoading}
              empty={
                <div>
                  <h3>No questions match these filters</h3>
                  <p>Adjust the filters, or create a new question to start building this bank.</p>
                  <Link className="btn btn--primary" to="/questions/new">
                    Create question
                  </Link>
                </div>
              }
            />
            {total > 0 ? (
              <Pagination
                page={list.page}
                pageSize={list.pageSize}
                total={total}
                totalPages={questions.data?.meta.totalPages ?? 1}
                onPageChange={list.setPage}
              />
            ) : null}
          </>
        )}
      </Card>

      <QuestionPreviewModal questionId={previewId} onClose={() => setPreviewId(null)} />

      <ConfirmDialog
        open={Boolean(archiveTarget)}
        title={archiveTarget?.status === 'ARCHIVED' ? 'Restore question' : 'Archive question'}
        message={
          archiveTarget?.status === 'ARCHIVED'
            ? 'The question becomes available for new papers again.'
            : 'Archived questions stay in historical papers and results but cannot be added to new papers.'
        }
        confirmLabel={archiveTarget?.status === 'ARCHIVED' ? 'Restore' : 'Archive'}
        tone={archiveTarget?.status === 'ARCHIVED' ? 'primary' : 'danger'}
        busy={archive.isPending}
        onConfirm={() => archiveTarget && archive.mutate(archiveTarget)}
        onCancel={() => setArchiveTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete question"
        message="This question has never been used in an examination or quiz, so it can be removed permanently."
        confirmLabel="Delete permanently"
        busy={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

function QuestionPreviewModal({ questionId, onClose }: { questionId: number | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['question', questionId],
    queryFn: () => api.get<QuestionDetail>(`/questions/${questionId}`),
    enabled: Boolean(questionId),
  });

  const answerKey = data?.answerKey ?? {};
  const correctLabels = new Set((answerKey.correctOptions ?? []).map((label) => label.toUpperCase()));

  return (
    <Modal open={Boolean(questionId)} title="Question preview" onClose={onClose} wide>
      {isLoading || !data ? (
        <p className="text-muted">Loading question…</p>
      ) : (
        <div>
          <div className="question-preview__meta">
            <Badge tone="outline">{QUESTION_TYPE_LABELS[data.type]}</Badge>
            <Badge tone="info">{data.marks} marks</Badge>
            {data.negative_marks ? <Badge tone="warning">−{data.negative_marks} if wrong</Badge> : null}
            <StatusBadge status={data.difficulty} />
          </div>
          <p className="question-preview__text">{data.text}</p>

          {data.type === 'MCQ' || data.type === 'TRUE_FALSE' ? (
            <ul className="option-list">
              {data.options.map((option) => (
                <li key={option.label} className={`option ${correctLabels.has(option.label.toUpperCase()) ? 'option--correct' : ''}`}>
                  <span className="option__label">{option.label}</span>
                  <span className="option__text">{option.text}</span>
                  {correctLabels.has(option.label.toUpperCase()) ? <span className="option__flag">Correct</span> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {data.type === 'FILL_BLANK' ? (
            <Alert tone="info" title="Accepted answers">
              {(answerKey.acceptedAnswers ?? []).join(' · ') || 'None recorded'}
              {answerKey.numericTolerance ? ` (numeric tolerance ±${answerKey.numericTolerance})` : ''}
              {answerKey.caseSensitive ? ' · case sensitive' : ''}
            </Alert>
          ) : null}

          {data.explanation ? (
            <div className="preview-explanation">
              <h3>Explanation</h3>
              <p>{data.explanation}</p>
            </div>
          ) : null}

          <dl className="definition-list">
            <dt>Subject</dt>
            <dd>{data.subject_id}</dd>
            <dt>Bank</dt>
            <dd>{data.question_bank_id}</dd>
            <dt>Topic</dt>
            <dd>{data.topic ?? '—'}</dd>
            <dt>Tags</dt>
            <dd>{(JSON.parse(data.tags || '[]') as string[]).join(', ') || '—'}</dd>
            <dt>Last updated</dt>
            <dd>{formatDate(data.updated_at)}</dd>
          </dl>

          <div className="modal-actions">
            <Link className="btn btn--primary" to={`/questions/${data.id}/edit`} onClick={onClose}>
              Edit question
            </Link>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [subjectId, setSubjectId] = useState('');
  const [bankId, setBankId] = useState('');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<{ imported: number; failed: number; errors: { line: number; message: string }[] } | null>(null);
  const [error, setError] = useState('');

  const subjects = useQuery({
    queryKey: ['subjects', 'options'],
    queryFn: () => api.list<Subject>('/subjects', { pageSize: 100 }),
    enabled: open,
  });
  const banks = useQuery({
    queryKey: ['question-banks', 'options', subjectId],
    queryFn: () => api.list<QuestionBank>('/question-banks', { pageSize: 100, subjectId: subjectId || undefined }),
    enabled: open,
  });

  const importCsv = useMutation({
    mutationFn: () =>
      api.post<{ imported: number; failed: number; errors: { line: number; message: string }[] }>('/questions/import', {
        questionBankId: Number(bankId),
        subjectId: Number(subjectId),
        csv,
      }),
    onSuccess: async (response) => {
      setResult(response);
      setError('');
      toast.notify(`${response.imported} question(s) imported.`, 'success');
      await queryClient.invalidateQueries({ queryKey: ['questions'] });
    },
    onError: (caught) => {
      setError(caught instanceof ApiError ? caught.message : 'The import failed.');
    },
  });

  const template =
    'type,text,topic,difficulty,marks,negativeMarks,optionA,optionB,optionC,optionD,correctAnswer,explanation,tags\n' +
    'MCQ,"Which data structure uses FIFO ordering?",Queues,EASY,2,0,Stack,Queue,Heap,Tree,B,"A queue removes the oldest element first.",data-structures\n' +
    'TRUE_FALSE,"An index always improves write throughput.",Indexing,MEDIUM,1,0,,,,,FALSE,"Indexes speed up reads but add write cost.",database\n' +
    'FILL_BLANK,"The SQL clause that filters aggregated groups is ____.",SQL,MEDIUM,2,0,,,,,HAVING|having,"HAVING runs after GROUP BY.",sql';

  return (
    <Modal open={open} title="Import questions from CSV" onClose={onClose} wide>
      <p className="text-sm text-muted">
        One question per row. Required columns: <code>type</code> and <code>text</code>. Supported types: MCQ, TRUE_FALSE,
        SHORT_ANSWER, ESSAY, FILL_BLANK. For fill-in-the-blank questions separate accepted answers with a pipe character.
      </p>
      <div className="field-row">
        <SelectInput
          label="Subject"
          required
          value={subjectId}
          placeholder="Select a subject"
          options={(subjects.data?.data ?? []).map((subject) => ({ value: subject.id, label: subject.name }))}
          onChange={(event) => {
            setSubjectId(event.target.value);
            setBankId('');
          }}
        />
        <SelectInput
          label="Destination bank"
          required
          value={bankId}
          placeholder={subjectId ? 'Select a bank' : 'Select a subject first'}
          disabled={!subjectId}
          options={(banks.data?.data ?? []).map((bank) => ({ value: bank.id, label: bank.name }))}
          onChange={(event) => setBankId(event.target.value)}
        />
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextArea
        label="CSV content"
        rows={10}
        value={csv}
        onChange={(event) => setCsv(event.target.value)}
        hint="Paste the file contents, or download the template below and open it in a spreadsheet."
      />
      <div className="inline">
        <Button size="sm" onClick={() => setCsv(template)}>
          Insert template
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const blob = new Blob([template], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'question-import-template.csv';
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          <IconDownload size={15} /> Download template
        </Button>
      </div>
      {result ? (
        <Alert tone={result.failed ? 'warning' : 'success'} title={`${result.imported} imported, ${result.failed} rejected`}>
          {result.errors.length ? (
            <ul className="text-sm">
              {result.errors.map((entry) => (
                <li key={entry.line}>
                  Line {entry.line}: {entry.message}
                </li>
              ))}
            </ul>
          ) : (
            'Every row was imported successfully.'
          )}
        </Alert>
      ) : null}
      <div className="modal-actions">
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="primary"
          disabled={!subjectId || !bankId || csv.trim().length < 10}
          loading={importCsv.isPending}
          onClick={() => importCsv.mutate()}
        >
          Import questions
        </Button>
      </div>
      <Checkbox label="Only rows with valid data are imported" checked disabled hint="Invalid rows are reported and skipped." />
    </Modal>
  );
}
