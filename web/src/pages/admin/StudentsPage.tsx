import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDate, formatPercentage } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import { useAuth } from '../../context/AuthContext';
import type { ClassRow, Student } from '../../types';
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
import { IconEdit, IconPlus, IconSearch } from '../../components/Icons';

interface StudentForm {
  fullName: string;
  email: string;
  password: string;
  studentCode: string;
  classId: string;
  phone: string;
  guardianName: string;
  guardianPhone: string;
  dateOfBirth: string;
  gender: string;
  status: string;
}

const emptyForm: StudentForm = {
  fullName: '',
  email: '',
  password: '',
  studentCode: '',
  classId: '',
  phone: '',
  guardianName: '',
  guardianPhone: '',
  dateOfBirth: '',
  gender: '',
  status: 'active',
};

export default function StudentsPage() {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  // Deep links from the institution dashboard, e.g. /students?q=NIT-2025-0006, seed the
  // visible filters and search box so the list opens on the candidate in question.
  const [searchParams] = useSearchParams();
  const list = useListState(
    {
      classId: searchParams.get('classId') ?? '',
      status: searchParams.get('status') ?? '',
      departmentId: searchParams.get('departmentId') ?? '',
    },
    20,
    searchParams.get('q') ?? '',
  );
  const [editing, setEditing] = useState<Student | 'new' | null>(null);

  const classes = useQuery({
    queryKey: ['classes', 'options'],
    queryFn: () => api.list<ClassRow>('/classes', { pageSize: 200 }),
    staleTime: 5 * 60_000,
  });

  const students = useQuery({
    queryKey: ['students', list.query],
    queryFn: () =>
      api.list<Student>('/students', {
        ...list.query,
        classId: list.filters.classId || undefined,
        status: list.filters.status || undefined,
      }),
  });

  const rows = students.data?.data ?? [];
  const canManage = hasPermission('student.manage');

  return (
    <div className="page">
      <PageHeader
        title="Students"
        description="Candidate records, class placement, guardianship details and account status."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <IconPlus size={16} /> Add student
            </Button>
          ) : null
        }
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Candidates listed" value={students.data?.meta.total ?? 0} />
        <StatCard label="Active" value={rows.filter((row) => row.status === 'active').length} tone="success" />
        <StatCard label="Enrolled in classes" value={rows.filter((row) => row.class_id).length} />
        <StatCard label="With attempts" value={rows.filter((row) => (row.attempts ?? 0) > 0).length} />
      </div>

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search name, email or candidate number"
              aria-label="Search students"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All classes"
            options={(classes.data?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
            value={list.filters.classId}
            onChange={(event) => list.updateFilter('classId', event.target.value)}
          />
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All statuses"
            options={[
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
              { value: 'graduated', label: 'Graduated' },
              { value: 'suspended', label: 'Suspended' },
            ]}
            value={list.filters.status}
            onChange={(event) => list.updateFilter('status', event.target.value)}
          />
          <Button size="sm" onClick={list.resetFilters}>
            Clear
          </Button>
        </div>

        {students.error ? (
          <div className="card__body">
            <ErrorState message="Student records could not be loaded." onRetry={() => void students.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              loading={students.isLoading}
              empty={
                <div>
                  <h3>No student records</h3>
                  <p>Add candidates individually, or import a class list through the API.</p>
                </div>
              }
              columns={[
                {
                  key: 'name',
                  header: 'Candidate',
                  render: (row) => (
                    <div>
                      <strong>{row.full_name}</strong>
                      <div className="text-sm text-muted">{row.email}</div>
                    </div>
                  ),
                },
                { key: 'student_code', header: 'Candidate number', render: (row) => row.student_code },
                { key: 'class', header: 'Class', render: (row) => row.class_name ?? <span className="text-muted">Not assigned</span> },
                { key: 'department', header: 'Department', render: (row) => row.department_name ?? '—' },
                { key: 'attempts', header: 'Attempts', align: 'right', render: (row) => row.attempts ?? 0 },
                {
                  key: 'average',
                  header: 'Average',
                  align: 'right',
                  render: (row) => (row.average_percentage === null || row.average_percentage === undefined ? '—' : formatPercentage(row.average_percentage)),
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (row) => (
                    <Badge tone={row.status === 'active' ? 'success' : row.status === 'suspended' ? 'danger' : 'outline'}>
                      {row.status}
                    </Badge>
                  ),
                },
                { key: 'created', header: 'Registered', render: (row) => formatDate((row as unknown as { created_at?: string }).created_at) },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (row) =>
                    canManage ? (
                      <button type="button" className="icon-button" aria-label={`Edit ${row.full_name}`} onClick={() => setEditing(row)}>
                        <IconEdit size={16} />
                      </button>
                    ) : null,
                },
              ]}
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={students.data?.meta.total ?? 0}
              totalPages={students.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <StudentModal
        target={editing}
        classes={classes.data?.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={async (createdPassword) => {
          setEditing(null);
          if (createdPassword) {
            toast.notify(`Student created. Temporary password: ${createdPassword}`, 'success');
          } else {
            toast.notify('Student record updated.', 'success');
          }
          await queryClient.invalidateQueries({ queryKey: ['students'] });
        }}
      />
    </div>
  );
}

function StudentModal({
  target,
  classes,
  onClose,
  onSaved,
}: {
  target: Student | 'new' | null;
  classes: ClassRow[];
  onClose: () => void;
  onSaved: (createdPassword?: string) => Promise<void>;
}) {
  const isNew = target === 'new';
  const student = target && target !== 'new' ? target : null;
  const [form, setForm] = useState<StudentForm>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const key = isNew ? 'new' : student ? String(student.id) : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setErrors({});
    setError('');
    setForm(
      student
        ? {
            fullName: student.full_name ?? '',
            email: student.email ?? '',
            password: '',
            studentCode: student.student_code,
            classId: student.class_id ? String(student.class_id) : '',
            phone: student.phone ?? '',
            guardianName: student.guardian_name ?? '',
            guardianPhone: student.guardian_phone ?? '',
            dateOfBirth: student.date_of_birth ?? '',
            gender: student.gender ?? '',
            status: student.status,
          }
        : emptyForm,
    );
  }

  const update = (field: keyof StudentForm, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        const response = await api.post<{ temporaryPassword?: string }>('/students', {
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          password: form.password || undefined,
          studentCode: form.studentCode.trim() || undefined,
          classId: form.classId ? Number(form.classId) : null,
          phone: form.phone.trim() || null,
          guardianName: form.guardianName.trim() || null,
          guardianPhone: form.guardianPhone.trim() || null,
          dateOfBirth: form.dateOfBirth.trim() || null,
          gender: form.gender.trim() || null,
        });
        return response.temporaryPassword;
      }
      await api.patch(`/students/${student?.id}`, {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        studentCode: form.studentCode.trim(),
        classId: form.classId ? Number(form.classId) : null,
        phone: form.phone.trim() || null,
        guardianName: form.guardianName.trim() || null,
        guardianPhone: form.guardianPhone.trim() || null,
        dateOfBirth: form.dateOfBirth.trim() || null,
        gender: form.gender.trim() || null,
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
        setError('The student record could not be saved.');
      }
    },
  });

  return (
    <Modal
      open={Boolean(target)}
      title={isNew ? 'Add student' : `Edit ${student?.full_name ?? 'student'}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {isNew ? 'Create student' : 'Save changes'}
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
          label="Candidate number"
          hint={isNew ? 'Leave empty to generate automatically.' : undefined}
          value={form.studentCode}
          error={errors.studentCode}
          onChange={(event) => update('studentCode', event.target.value)}
        />
        <SelectInput
          label="Class"
          placeholder="Not assigned"
          options={classes.map((row) => ({ value: row.id, label: row.name }))}
          value={form.classId}
          error={errors.classId}
          onChange={(event) => update('classId', event.target.value)}
        />
      </div>
      {isNew ? (
        <TextInput
          label="Initial password"
          type="password"
          hint="Optional. Leave empty and the server generates a temporary password you can hand over."
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
            { value: 'graduated', label: 'Graduated' },
            { value: 'suspended', label: 'Suspended — cannot sign in' },
          ]}
          onChange={(event) => update('status', event.target.value)}
        />
      )}
      <div className="field-row">
        <TextInput label="Phone" value={form.phone} onChange={(event) => update('phone', event.target.value)} />
        <TextInput label="Date of birth" type="date" value={form.dateOfBirth} onChange={(event) => update('dateOfBirth', event.target.value)} />
        <TextInput label="Gender" value={form.gender} onChange={(event) => update('gender', event.target.value)} />
      </div>
      <div className="field-row">
        <TextInput label="Guardian name" value={form.guardianName} onChange={(event) => update('guardianName', event.target.value)} />
        <TextInput label="Guardian phone" value={form.guardianPhone} onChange={(event) => update('guardianPhone', event.target.value)} />
      </div>
      <Alert tone="info">
        Candidate accounts are created with the email address as their sign-in name. Examiners can view candidate records
        but only administrators may change them.
      </Alert>
    </Modal>
  );
}
