import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useListState } from '../../lib/hooks';
import { useAuth } from '../../context/AuthContext';
import type { Department, Subject, Teacher } from '../../types';
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
  StatCard,
  TextInput,
  useToast,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { IconEdit, IconPlus, IconSearch, IconTeacher } from '../../components/Icons';

interface TeacherForm {
  fullName: string;
  email: string;
  password: string;
  staffCode: string;
  departmentId: string;
  designation: string;
  specialization: string;
  phone: string;
  status: string;
}

const emptyForm: TeacherForm = {
  fullName: '',
  email: '',
  password: '',
  staffCode: '',
  departmentId: '',
  designation: '',
  specialization: '',
  phone: '',
  status: 'active',
};

export default function TeachersPage() {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useListState({ departmentId: '', status: '' });
  const [editing, setEditing] = useState<Teacher | 'new' | null>(null);
  const [subjectTarget, setSubjectTarget] = useState<Teacher | null>(null);

  const departments = useQuery({
    queryKey: ['departments', 'options'],
    queryFn: () => api.list<Department>('/departments', { pageSize: 100 }),
    staleTime: 5 * 60_000,
  });

  const teachers = useQuery({
    queryKey: ['teachers', list.query],
    queryFn: () =>
      api.list<Teacher>('/teachers', {
        ...list.query,
        departmentId: list.filters.departmentId || undefined,
        status: list.filters.status || undefined,
      }),
  });

  const rows = teachers.data?.data ?? [];
  const canManage = hasPermission('teacher.manage');

  return (
    <div className="page">
      <PageHeader
        title="Examiners"
        description="Teaching staff who author questions, run examinations and mark written answers."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <IconPlus size={16} /> Add examiner
            </Button>
          ) : null
        }
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Examiners" value={teachers.data?.meta.total ?? 0} />
        <StatCard label="Active" value={rows.filter((row) => row.status === 'active').length} tone="success" />
        <StatCard label="With subject assignments" value={rows.filter((row) => (row.subject_count ?? 0) > 0).length} />
        <StatCard label="Departments covered" value={new Set(rows.map((row) => row.department_id).filter(Boolean)).size} />
      </div>

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search name, email or staff number"
              aria-label="Search examiners"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All departments"
            options={(departments.data?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
            value={list.filters.departmentId}
            onChange={(event) => list.updateFilter('departmentId', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All statuses"
            options={[
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
              { value: 'suspended', label: 'Suspended' },
            ]}
            value={list.filters.status}
            onChange={(event) => list.updateFilter('status', event.target.value)}
          />
          <Button size="sm" onClick={list.resetFilters}>
            Clear
          </Button>
        </div>

        {teachers.error ? (
          <div className="card__body">
            <ErrorState message="Examiner records could not be loaded." onRetry={() => void teachers.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              loading={teachers.isLoading}
              empty={
                <div>
                  <h3>No examiners yet</h3>
                  <p>Add teaching staff so they can create examinations and mark submissions.</p>
                </div>
              }
              columns={[
                {
                  key: 'name',
                  header: 'Examiner',
                  render: (row) => (
                    <div>
                      <strong>{row.full_name}</strong>
                      <div className="text-sm text-muted">{row.email}</div>
                    </div>
                  ),
                },
                { key: 'staff_code', header: 'Staff number', render: (row) => row.staff_code },
                { key: 'department', header: 'Department', render: (row) => row.department_name ?? '—' },
                { key: 'designation', header: 'Designation', render: (row) => row.designation ?? '—' },
                { key: 'specialization', header: 'Specialisation', render: (row) => row.specialization ?? '—' },
                { key: 'subjects', header: 'Subjects', align: 'right', render: (row) => row.subject_count ?? (row.subjects?.length ?? 0) },
                { key: 'exams', header: 'Examinations', align: 'right', render: (row) => row.exam_count ?? 0 },
                {
                  key: 'status',
                  header: 'Status',
                  render: (row) => (
                    <Badge tone={row.status === 'active' ? 'success' : row.status === 'suspended' ? 'danger' : 'outline'}>{row.status}</Badge>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (row) =>
                    canManage ? (
                      <div className="table-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Assign subjects to ${row.full_name}`}
                          onClick={() => setSubjectTarget(row)}
                        >
                          <IconTeacher size={16} />
                        </button>
                        <button type="button" className="icon-button" aria-label={`Edit ${row.full_name}`} onClick={() => setEditing(row)}>
                          <IconEdit size={16} />
                        </button>
                      </div>
                    ) : null,
                },
              ]}
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={teachers.data?.meta.total ?? 0}
              totalPages={teachers.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <TeacherModal
        target={editing}
        departments={departments.data?.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={async (password) => {
          setEditing(null);
          toast.notify(password ? `Examiner created. Temporary password: ${password}` : 'Examiner record updated.', 'success');
          await queryClient.invalidateQueries({ queryKey: ['teachers'] });
        }}
      />

      <SubjectAssignmentModal teacher={subjectTarget} onClose={() => setSubjectTarget(null)} />
    </div>
  );
}

function TeacherModal({
  target,
  departments,
  onClose,
  onSaved,
}: {
  target: Teacher | 'new' | null;
  departments: Department[];
  onClose: () => void;
  onSaved: (temporaryPassword?: string) => Promise<void>;
}) {
  const isNew = target === 'new';
  const teacher = target && target !== 'new' ? target : null;
  const [form, setForm] = useState<TeacherForm>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const key = isNew ? 'new' : teacher ? String(teacher.id) : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setErrors({});
    setError('');
    setForm(
      teacher
        ? {
            fullName: teacher.full_name ?? '',
            email: teacher.email ?? '',
            password: '',
            staffCode: teacher.staff_code,
            departmentId: teacher.department_id ? String(teacher.department_id) : '',
            designation: teacher.designation ?? '',
            specialization: teacher.specialization ?? '',
            phone: teacher.phone ?? '',
            status: teacher.status,
          }
        : emptyForm,
    );
  }

  const update = (field: keyof TeacherForm, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        const response = await api.post<{ temporaryPassword?: string }>('/teachers', {
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          password: form.password || undefined,
          staffCode: form.staffCode.trim() || undefined,
          departmentId: form.departmentId ? Number(form.departmentId) : null,
          designation: form.designation.trim() || null,
          specialization: form.specialization.trim() || null,
          phone: form.phone.trim() || null,
        });
        return response.temporaryPassword;
      }
      await api.patch(`/teachers/${teacher?.id}`, {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        staffCode: form.staffCode.trim(),
        departmentId: form.departmentId ? Number(form.departmentId) : null,
        designation: form.designation.trim() || null,
        specialization: form.specialization.trim() || null,
        phone: form.phone.trim() || null,
        status: form.status,
      });
      return undefined;
    },
    onSuccess: (password) => void onSaved(password),
    onError: (caught) => {
      if (caught instanceof ApiError) {
        setErrors(caught.fieldErrors());
        setError(caught.message);
      } else {
        setError('The examiner record could not be saved.');
      }
    },
  });

  return (
    <Modal
      open={Boolean(target)}
      title={isNew ? 'Add examiner' : `Edit ${teacher?.full_name ?? 'examiner'}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {isNew ? 'Create examiner' : 'Save changes'}
          </Button>
        </>
      }
    >
      {error && !Object.keys(errors).length ? <Alert tone="danger">{error}</Alert> : null}
      <div className="field-row">
        <TextInput label="Full name" required value={form.fullName} error={errors.fullName} onChange={(event) => update('fullName', event.target.value)} />
        <TextInput label="Email address" type="email" required value={form.email} error={errors.email} onChange={(event) => update('email', event.target.value)} />
      </div>
      <div className="field-row">
        <TextInput
          label="Staff number"
          hint={isNew ? 'Leave empty to generate automatically.' : undefined}
          value={form.staffCode}
          error={errors.staffCode}
          onChange={(event) => update('staffCode', event.target.value)}
        />
        <SelectInput
          label="Department"
          placeholder="Not assigned"
          options={departments.map((row) => ({ value: row.id, label: row.name }))}
          value={form.departmentId}
          error={errors.departmentId}
          onChange={(event) => update('departmentId', event.target.value)}
        />
      </div>
      <div className="field-row">
        <TextInput label="Designation" value={form.designation} onChange={(event) => update('designation', event.target.value)} />
        <TextInput label="Specialisation" value={form.specialization} onChange={(event) => update('specialization', event.target.value)} />
        <TextInput label="Phone" value={form.phone} onChange={(event) => update('phone', event.target.value)} />
      </div>
      {isNew ? (
        <TextInput
          label="Initial password"
          type="password"
          hint="Optional. A temporary password is generated when left empty."
          value={form.password}
          error={errors.password}
          onChange={(event) => update('password', event.target.value)}
        />
      ) : (
        <SelectInput
          label="Account status"
          value={form.status}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
            { value: 'suspended', label: 'Suspended — cannot sign in' },
          ]}
          onChange={(event) => update('status', event.target.value)}
        />
      )}
    </Modal>
  );
}

function SubjectAssignmentModal({ teacher, onClose }: { teacher: Teacher | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<number[]>([]);
  const seededFor = useRef<number | null>(null);

  const subjects = useQuery({
    queryKey: ['subjects', 'options'],
    queryFn: () => api.list<Subject>('/subjects', { pageSize: 200 }),
    enabled: Boolean(teacher),
  });

  const detail = useQuery({
    queryKey: ['teacher', teacher?.id],
    queryFn: () => api.get<Teacher>(`/teachers/${teacher?.id}`),
    enabled: Boolean(teacher),
  });

  // Pre-check the examiner's current subjects once the detail request resolves, and
  // re-seed only when a different examiner is opened — never on later re-renders,
  // otherwise clearing a subject would be silently undone.
  const teacherId = teacher?.id ?? null;
  useEffect(() => {
    if (!teacherId) {
      seededFor.current = null;
      setSelected([]);
      return;
    }
    if (seededFor.current === teacherId) return;
    if (!detail.isSuccess) return;
    seededFor.current = teacherId;
    setSelected((detail.data?.subjects ?? []).map((subject) => subject.id));
  }, [teacherId, detail.isSuccess, detail.data]);

  const save = useMutation({
    mutationFn: () => api.post(`/teachers/${teacher?.id}/subjects`, { subjectIds: selected }),
    onSuccess: async () => {
      toast.notify('Subject assignments updated.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['teachers'] });
      await queryClient.invalidateQueries({ queryKey: ['teacher', teacher?.id] });
      onClose();
    },
    onError: (caught) => toast.notify(caught instanceof ApiError ? caught.message : 'The assignments could not be saved.', 'error'),
  });

  return (
    <Modal
      open={Boolean(teacher)}
      title={`Subjects for ${teacher?.full_name ?? ''}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save assignments
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        Only assigned examiners can be picked as the owner of papers in these subjects, and only they (or administrators)
        can mark submissions for them.
      </p>
      <div className="checkbox-grid">
        {(subjects.data?.data ?? []).map((subject) => (
          <label key={subject.id} className="checkbox-card">
            <input
              type="checkbox"
              checked={selected.includes(subject.id)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked ? [...current, subject.id] : current.filter((id) => id !== subject.id),
                )
              }
            />
            <span>
              <strong>{subject.name}</strong>
              <small>{subject.code}</small>
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
