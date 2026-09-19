import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useDebouncedValue } from '../lib/hooks';
import { QUESTION_TYPE_LABELS, type QuestionBank, type QuestionListItem } from '../types';
import { Badge, Button, Checkbox, SelectInput, StatusBadge, TextInput } from './ui';
import { IconChevronLeft, IconChevronRight, IconPlus, IconSearch, IconTrash } from './Icons';

export interface PaperQuestion {
  questionId: number;
  text: string;
  type: QuestionListItem['type'];
  difficulty: QuestionListItem['difficulty'];
  defaultMarks: number;
  marks: number;
  negativeMarks: number;
  topic: string | null;
  optionCount?: number;
}

/**
 * Adds questions from the bank to a paper. Marks can be overridden per paper without
 * changing the question itself, which keeps historical papers reproducible.
 */
export function QuestionPicker({
  subjectId,
  paperQuestions,
  onChange,
  showNegativeMarking,
}: {
  subjectId: string;
  paperQuestions: PaperQuestion[];
  onChange: (next: PaperQuestion[]) => void;
  showNegativeMarking: boolean;
}) {
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 300);
  const [bankId, setBankId] = useState('');
  const [type, setType] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 8;

  const banks = useQuery({
    queryKey: ['question-banks', 'picker', subjectId],
    queryFn: () => api.list<QuestionBank>('/question-banks', { pageSize: 100, subjectId: subjectId || undefined }),
    enabled: Boolean(subjectId),
  });

  const questions = useQuery({
    queryKey: ['questions', 'picker', { subjectId, bankId, type, difficulty, debounced, page }],
    queryFn: () =>
      api.list<QuestionListItem>('/questions', {
        subjectId: subjectId || undefined,
        questionBankId: bankId || undefined,
        type: type || undefined,
        difficulty: difficulty || undefined,
        status: 'ACTIVE',
        q: debounced,
        page,
        pageSize,
      }),
    enabled: Boolean(subjectId),
  });

  const selectedIds = useMemo(() => new Set(paperQuestions.map((question) => question.questionId)), [paperQuestions]);
  const totalMarks = paperQuestions.reduce((sum, question) => sum + Number(question.marks || 0), 0);

  const add = (question: QuestionListItem) => {
    onChange([
      ...paperQuestions,
      {
        questionId: question.id,
        text: question.text,
        type: question.type,
        difficulty: question.difficulty,
        defaultMarks: question.marks,
        marks: question.marks,
        negativeMarks: showNegativeMarking ? question.negative_marks : 0,
        topic: question.topic,
        optionCount: question.option_count,
      },
    ]);
  };

  const remove = (questionId: number) => onChange(paperQuestions.filter((question) => question.questionId !== questionId));

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= paperQuestions.length) return;
    const next = [...paperQuestions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  const update = (questionId: number, patch: Partial<PaperQuestion>) => {
    onChange(paperQuestions.map((question) => (question.questionId === questionId ? { ...question, ...patch } : question)));
  };

  const meta = questions.data?.meta;

  return (
    <div className="picker">
      <div className="picker__browser">
        <div className="filter-bar filter-bar--compact">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search the bank"
              aria-label="Search questions to add"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All banks"
            options={(banks.data?.data ?? []).map((bank) => ({ value: bank.id, label: bank.name }))}
            value={bankId}
            onChange={(event) => {
              setBankId(event.target.value);
              setPage(1);
            }}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All types"
            options={Object.entries(QUESTION_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="Any difficulty"
            options={[
              { value: 'EASY', label: 'Easy' },
              { value: 'MEDIUM', label: 'Medium' },
              { value: 'HARD', label: 'Hard' },
            ]}
            value={difficulty}
            onChange={(event) => {
              setDifficulty(event.target.value);
              setPage(1);
            }}
          />
        </div>

        {!subjectId ? (
          <p className="empty-inline">Select a subject first — questions belong to a subject.</p>
        ) : questions.isLoading ? (
          <p className="empty-inline">Loading questions…</p>
        ) : (questions.data?.data.length ?? 0) === 0 ? (
          <p className="empty-inline">No active questions match these filters.</p>
        ) : (
          <ul className="picker__list">
            {questions.data?.data.map((question) => (
              <li key={question.id}>
                <div className="picker__item">
                  <div>
                    <p className="cell-clamp">{question.text}</p>
                    <div className="picker__item-meta">
                      <Badge tone="outline">{QUESTION_TYPE_LABELS[question.type]}</Badge>
                      <StatusBadge status={question.difficulty} />
                      <span className="text-sm text-muted">
                        {question.marks} mark{question.marks === 1 ? '' : 's'}
                        {question.topic ? ` · ${question.topic}` : ''}
                      </span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => add(question)}
                    disabled={selectedIds.has(question.id)}
                    aria-label={selectedIds.has(question.id) ? 'Already added' : `Add question ${question.id}`}
                  >
                    {selectedIds.has(question.id) ? 'Added' : <IconPlus size={15} />}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {meta && meta.totalPages > 1 ? (
          <div className="picker__pager">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
              Previous
            </Button>
            <span className="text-sm text-muted">
              Page {meta.page} of {meta.totalPages} ({meta.total} questions)
            </span>
            <Button size="sm" disabled={page >= meta.totalPages} onClick={() => setPage((value) => value + 1)}>
              Next
            </Button>
          </div>
        ) : null}
      </div>

      <div className="picker__paper">
        <div className="picker__paper-header">
          <h3>Paper</h3>
          <span className="text-sm text-muted">
            {paperQuestions.length} question{paperQuestions.length === 1 ? '' : 's'} · {totalMarks} mark
            {totalMarks === 1 ? '' : 's'}
          </span>
        </div>

        {paperQuestions.length === 0 ? (
          <p className="empty-inline">No questions added yet. Choose questions from the bank on the left.</p>
        ) : (
          <ol className="paper-list">
            {paperQuestions.map((question, index) => (
              <li key={question.questionId} className="paper-list__item">
                <div className="paper-list__main">
                  <span className="paper-list__position">{index + 1}</span>
                  <div>
                    <p className="cell-clamp">{question.text}</p>
                    <div className="picker__item-meta">
                      <Badge tone="outline">{QUESTION_TYPE_LABELS[question.type]}</Badge>
                      <StatusBadge status={question.difficulty} />
                    </div>
                  </div>
                </div>
                <div className="paper-list__controls">
                  <TextInput
                    aria-label={`Marks for question ${index + 1}`}
                    type="number"
                    min={0.25}
                    step={0.25}
                    value={String(question.marks)}
                    onChange={(event) => update(question.questionId, { marks: Number(event.target.value) })}
                    wrapperClassName="paper-list__marks"
                  />
                  {showNegativeMarking ? (
                    <TextInput
                      aria-label={`Negative marks for question ${index + 1}`}
                      type="number"
                      min={0}
                      step={0.25}
                      value={String(question.negativeMarks)}
                      onChange={(event) => update(question.questionId, { negativeMarks: Number(event.target.value) })}
                      wrapperClassName="paper-list__marks"
                    />
                  ) : null}
                  <div className="inline">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move question ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <IconChevronLeft size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Move question ${index + 1} down`}
                      disabled={index === paperQuestions.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <IconChevronRight size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button icon-button--danger"
                      aria-label={`Remove question ${index + 1}`}
                      onClick={() => remove(question.questionId)}
                    >
                      <IconTrash size={15} />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}

        <Checkbox
          label="Marks can differ from the question default"
          checked
          disabled
          hint="Overriding marks affects only this paper and never edits the stored question."
        />
      </div>
    </div>
  );
}
