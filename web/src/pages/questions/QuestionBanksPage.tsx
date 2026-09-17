import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import type { QuestionBank, Subject } from '../../types';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Modal,
  PageHeader,
  Pagination,
  SelectInput,
  StatusBadge,
  TextArea,
  TextInput,
  useToast,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { IconEdit, IconPlus, IconSearch } from '../../components/Icons';

export default function QuestionBanksPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useListState({ subjectId: '', status: '' });
  const [editing, setEditing] = useState<QuestionBank | 'new' | null>(null);

  const subjects = useQuery({
    queryKey: ['subjects', 'options'],
    queryFn: () => api.list<Subject>('/subjects', { pageSize: 100 }),
    staleTime: 5 * 60_000,
  });

  const banks = useQuery({
    queryKey: ['question-banks', list.query],
    queryFn: () =>
      api.list<QuestionBank>('/question-banks', {
        ...list.query,
        subjectId: list.filters.subjectId || undefined,
        status: list.filters.status || undefined,
      }),
  });

  const canManage = true;

  return (
    <div className="page">
      <PageHeader
        title="Question banks"
        description="Banks group questions by subject. Examiners draw questions from banks when building papers."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <IconPlus size={16} /> New bank
          </Button>
        }
      />

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search banks"
              aria-label="Search question banks"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All subjects"
            options={(subjects.data?.data ?? []).map((subject) => ({ value: subject.id, label: subject.name }))}
            value={list.filters.subjectId}
            onChange={(event) => list.updateFilter('subjectId', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All statuses"
            options={[
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
            ]}
            value={list.filters.status}
            onChange={(event) => list.updateFilter('status', event.target.value)}
          />
        </div>

        {banks.error ? (
          <div className="card__body">
            <ErrorState message="Question banks could not be loaded." onRetry={() => void banks.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              rows={banks.data?.data ?? []}
              rowKey={(row) => row.id}
              loading={banks.isLoading}
              empty={
                <div>
                  <h3>No question banks yet</h3>
                  <p>Create a bank for each subject before writing questions.</p>
                </div>
              }
              columns={[
                {
                  key: 'name',
                  header: 'Bank',
                  render: (row) => (
                    <div>
                      <Link className="link-strong" to={`/questions?bankId=${row.id}&subjectId=${row.subject_id}`}>
                        {row.name}
                      </Link>
                      <div className="text-sm text-muted">{row.description || 'No description'}</div>
                    </div>
                  ),
                },
                {
                  key: 'subject',
                  header: 'Subject',
                  render: (row) => (
                    <span>
                      {row.subject_name}
                      <div className="text-sm text-muted">{row.subject_code}</div>
                    </span>
                  ),
                },
                { key: 'questions', header: 'Questions', align: 'right', render: (row) => `${row.active_questions ?? 0} active / ${row.total_questions ?? 0}` },
                { key: 'owner', header: 'Created by', render: (row) => row.created_by_name ?? '—' },
                { key: 'status', header: 'Status', render: (row) => <StatusBadge status={row.status === 'active' ? 'ACTIVE_STATUS' : 'ARCHIVED'} /> },
                { key: 'updated', header: 'Updated', render: (row) => formatDate(row.updated_at) },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (row) => (
                    <div className="table-actions">
                      <Link className="btn btn--sm" to={`/questions?bankId=${row.id}&subjectId=${row.subject_id}`}>
                        Open
                      </Link>
                      {canManage ? (
                        <button type="button" className="icon-button" aria-label={`Edit ${row.name}`} onClick={() => setEditing(row)}>
                          <IconEdit size={16} />
                        </button>
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={banks.data?.meta.total ?? 0}
              totalPages={banks.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <BankModal
        target={editing}
        subjects={subjects.data?.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          toast.notify('Question bank saved.', 'success');
          await queryClient.invalidateQueries({ queryKey: ['question-banks'] });
        }}
      />
    </div>
  );
}

function BankModal({
  target,
  subjects,
  onClose,
  onSaved,
}: {
  target: QuestionBank | 'new' | null;
  subjects: Subject[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isNew = target === 'new';
  const bank = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('active');
  const [error, setError] = useState('');

  // Re-seed the form whenever a different bank is opened.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const key = isNew ? 'new' : bank ? String(bank.id) : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setName(bank?.name ?? '');
    setSubjectId(bank ? String(bank.subject_id) : '');
    setDescription(bank?.description ?? '');
    setStatus(bank?.status ?? 'active');
    setError('');
  }

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api.post<QuestionBank>('/question-banks', {
            name: name.trim(),
            subjectId: Number(subjectId),
            description: description.trim() || null,
          })
        : api.patch<QuestionBank>(`/question-banks/${bank?.id}`, {
            name: name.trim(),
            description: description.trim() || null,
            status,
          }),
    onSuccess: onSaved,
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'The bank could not be saved.'),
  });

  return (
    <Modal
      open={Boolean(target)}
      title={isNew ? 'New question bank' : `Edit ${bank?.name ?? 'bank'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={name.trim().length < 2 || (isNew && !subjectId)}
            onClick={() => save.mutate()}
          >
            {isNew ? 'Create bank' : 'Save changes'}
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextInput label="Bank name" required value={name} onChange={(event) => setName(event.target.value)} />
      {isNew ? (
        <SelectInput
          label="Subject"
          required
          value={subjectId}
          placeholder="Select a subject"
          options={subjects.map((subject) => ({ value: subject.id, label: `${subject.name} (${subject.code})` }))}
          onChange={(event) => setSubjectId(event.target.value)}
        />
      ) : (
        <p className="text-sm text-muted">
          Subject: <strong>{bank?.subject_name}</strong>. A bank keeps the subject of its questions, so it cannot be moved.
        </p>
      )}
      <TextArea label="Description" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
      {!isNew ? (
        <SelectInput
          label="Status"
          value={status}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'archived', label: 'Archived — hidden from new papers' },
          ]}
          onChange={(event) => setStatus(event.target.value)}
        />
      ) : null}
      {!isNew && (bank?.total_questions ?? 0) > 0 ? (
        <p className="text-sm text-muted">
          <Badge tone="outline">{bank?.total_questions} questions</Badge> Archiving a bank does not remove its questions
          from historical papers.
        </p>
      ) : null}
    </Modal>
  );
}
