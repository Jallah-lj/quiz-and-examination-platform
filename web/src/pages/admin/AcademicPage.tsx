import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useListState } from '../../lib/hooks';
import { useAuth } from '../../context/AuthContext';
import type { ClassRow, Department, Group, Student, Subject, Teacher } from '../../types';
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
  Tabs,
  TextArea,
  TextInput,
  useToast,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { IconEdit, IconPlus, IconSearch } from '../../components/Icons';

type TabKey = 'departments' | 'classes' | 'subjects' | 'groups';

export default function AcademicPage() {
  const [tab, setTab] = useState<TabKey>('departments');
  const { hasPermission } = useAuth();

  const tabs = [
    { key: 'departments', label: 'Departments' },
    { key: 'classes', label: 'Classes' },
    { key: 'subjects', label: 'Subjects' },
    { key: 'groups', label: 'Groups' },
  ].filter((entry) => {
    if (entry.key === 'departments') return hasPermission('department.manage');
    if (entry.key === 'classes') return hasPermission('class.view', 'class.manage');
    if (entry.key === 'subjects') return hasPermission('subject.view', 'subject.manage');
    return hasPermission('class.manage', 'student.manage');
  });

  return (
    <div className="page">
      <PageHeader
        title="Academic structure"
        description="Departments, classes, subjects and study groups. Examinations and question banks are organised by subject."
      />
      <Tabs tabs={tabs} active={tab} onChange={(key) => setTab(key as TabKey)} />
      {tab === 'departments' ? <DepartmentsPanel /> : null}
      {tab === 'classes' ? <ClassesPanel /> : null}
      {tab === 'subjects' ? <SubjectsPanel /> : null}
      {tab === 'groups' ? <GroupsPanel /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------- departments */
function DepartmentsPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useListState({ status: '' });
  const [editing, setEditing] = useState<Department | 'new' | null>(null);

  const departments = useQuery({
    queryKey: ['departments', list.query],
    queryFn: () => api.list<Department>('/departments', { ...list.query, status: list.filters.status || undefined }),
  });

  const heads = useQuery({
    queryKey: ['teachers', 'options'],
    queryFn: () => api.list<Teacher>('/teachers', { pageSize: 200 }),
  });

  return (
    <>
      <Card
        flush
        title="Departments"
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setEditing('new')}
          >
            <IconPlus size={15} /> New department
          </Button>
        }
      >
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search departments"
              aria-label="Search departments"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
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
        {departments.error ? (
          <div className="card__body">
            <ErrorState message="Departments could not be loaded." onRetry={() => void departments.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              rows={departments.data?.data ?? []}
              rowKey={(row) => row.id}
              loading={departments.isLoading}
              empty={<p>No departments yet.</p>}
              columns={[
                {
                  key: 'name',
                  header: 'Department',
                  render: (row) => (
                    <div>
                      <strong>{row.name}</strong>
                      <div className="text-sm text-muted">{row.code}</div>
                    </div>
                  ),
                },
                { key: 'head', header: 'Head', render: (row) => row.head_name ?? '—' },
                { key: 'classes', header: 'Classes', align: 'right', render: (row) => row.class_count ?? 0 },
                { key: 'subjects', header: 'Subjects', align: 'right', render: (row) => row.subject_count ?? 0 },
                { key: 'teachers', header: 'Examiners', align: 'right', render: (row) => row.teacher_count ?? 0 },
                { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'active' ? 'success' : 'outline'}>{row.status}</Badge> },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (row) => (
                    <button type="button" className="icon-button" aria-label={`Edit ${row.name}`} onClick={() => setEditing(row)}>
                      <IconEdit size={16} />
                    </button>
                  ),
                },
              ]}
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={departments.data?.meta.total ?? 0}
              totalPages={departments.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <DepartmentModal
        target={editing}
        heads={heads.data?.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          toast.notify('Department saved.', 'success');
          await queryClient.invalidateQueries({ queryKey: ['departments'] });
        }}
      />
    </>
  );
}

function DepartmentModal({
  target,
  heads,
  onClose,
  onSaved,
}: {
  target: Department | 'new' | null;
  heads: Teacher[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isNew = target === 'new';
  const department = target && target !== 'new' ? target : null;
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [headUserId, setHeadUserId] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const key = isNew ? 'new' : department ? String(department.id) : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setError('');
    setName(department?.name ?? '');
    setCode(department?.code ?? '');
    setHeadUserId(department?.head_user_id ? String(department.head_user_id) : '');
    setDescription(department?.description ?? '');
  }

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api.post('/departments', {
            name: name.trim(),
            code: code.trim().toUpperCase(),
            description: description.trim() || null,
            headUserId: headUserId ? Number(headUserId) : null,
          })
        : api.patch(`/departments/${department?.id}`, {
            name: name.trim(),
            description: description.trim() || null,
            headUserId: headUserId ? Number(headUserId) : null,
          }),
    onSuccess: onSaved,
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'The department could not be saved.'),
  });

  return (
    <Modal
      open={Boolean(target)}
      title={isNew ? 'New department' : `Edit ${department?.name ?? 'department'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="field-row">
        <TextInput label="Name" required value={name} onChange={(event) => setName(event.target.value)} />
        <TextInput label="Code" required disabled={!isNew} value={code} onChange={(event) => setCode(event.target.value)} />
      </div>
      <SelectInput
        label="Head of department"
        placeholder="Not assigned"
        options={heads.map((teacher) => ({ value: teacher.id, label: `${teacher.full_name} (${teacher.staff_code})` }))}
        value={headUserId}
        onChange={(event) => setHeadUserId(event.target.value)}
      />
      <TextArea label="Description" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
    </Modal>
  );
}

/* ----------------------------------------------------------------------- classes */
function ClassesPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useListState({ departmentId: '', status: '' });
  const [editing, setEditing] = useState<ClassRow | 'new' | null>(null);
  const [enrolTarget, setEnrolTarget] = useState<ClassRow | null>(null);

  const classes = useQuery({
    queryKey: ['classes', list.query],
    queryFn: () =>
      api.list<ClassRow>('/classes', {
        ...list.query,
        departmentId: list.filters.departmentId || undefined,
        status: list.filters.status || undefined,
      }),
  });

  const departments = useQuery({
    queryKey: ['departments', 'options'],
    queryFn: () => api.list<Department>('/departments', { pageSize: 100 }),
  });

  const teachers = useQuery({
    queryKey: ['teachers', 'options'],
    queryFn: () => api.list<Teacher>('/teachers', { pageSize: 200 }),
  });

  return (
    <>
      <Card
        flush
        title="Classes"
        actions={
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <IconPlus size={15} /> New class
          </Button>
        }
      >
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search classes"
              aria-label="Search classes"
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
              { value: 'archived', label: 'Archived' },
            ]}
            value={list.filters.status}
            onChange={(event) => list.updateFilter('status', event.target.value)}
          />
        </div>
        {classes.error ? (
          <div className="card__body">
            <ErrorState message="Classes could not be loaded." onRetry={() => void classes.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              rows={classes.data?.data ?? []}
              rowKey={(row) => row.id}
              loading={classes.isLoading}
              empty={<p>No classes yet.</p>}
              columns={[
                {
                  key: 'name',
                  header: 'Class',
                  render: (row) => (
                    <div>
                      <strong>{row.name}</strong>
                      <div className="text-sm text-muted">
                        {row.code} · {row.academic_year}
                        {row.level ? ` · ${row.level}` : ''}
                      </div>
                    </div>
                  ),
                },
                { key: 'department', header: 'Department', render: (row) => row.department_name ?? '—' },
                { key: 'teacher', header: 'Class teacher', render: (row) => row.class_teacher_name ?? '—' },
                { key: 'students', header: 'Candidates', align: 'right', render: (row) => row.student_count ?? 0 },
                { key: 'capacity', header: 'Capacity', align: 'right', render: (row) => row.capacity ?? '—' },
                { key: 'room', header: 'Room', render: (row) => row.room ?? '—' },
                { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'active' ? 'success' : 'outline'}>{row.status}</Badge> },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (row) => (
                    <div className="table-actions">
                      <Button size="sm" onClick={() => setEnrolTarget(row)}>
                        Enrol
                      </Button>
                      <button type="button" className="icon-button" aria-label={`Edit ${row.name}`} onClick={() => setEditing(row)}>
                        <IconEdit size={16} />
                      </button>
                    </div>
                  ),
                },
              ]}
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={classes.data?.meta.total ?? 0}
              totalPages={classes.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <ClassModal
        target={editing}
        departments={departments.data?.data ?? []}
        teachers={teachers.data?.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          toast.notify('Class saved.', 'success');
          await queryClient.invalidateQueries({ queryKey: ['classes'] });
        }}
      />

      <EnrolModal
        target={enrolTarget}
        onClose={() => setEnrolTarget(null)}
        onSaved={async (moved) => {
          setEnrolTarget(null);
          toast.notify(`${moved} candidate(s) enrolled.`, 'success');
          await queryClient.invalidateQueries({ queryKey: ['classes'] });
        }}
      />
    </>
  );
}

function ClassModal({
  target,
  departments,
  teachers,
  onClose,
  onSaved,
}: {
  target: ClassRow | 'new' | null;
  departments: Department[];
  teachers: Teacher[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isNew = target === 'new';
  const klass = target && target !== 'new' ? target : null;
  const [form, setForm] = useState({
    name: '',
    code: '',
    level: '',
    academicYear: new Date().getFullYear() + '/' + (new Date().getFullYear() + 1),
    departmentId: '',
    classTeacherId: '',
    capacity: '',
    room: '',
    status: 'active',
  });
  const [error, setError] = useState('');
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const key = isNew ? 'new' : klass ? String(klass.id) : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setError('');
    setForm({
      name: klass?.name ?? '',
      code: klass?.code ?? '',
      level: klass?.level ?? '',
      academicYear: klass?.academic_year ?? new Date().getFullYear() + '/' + (new Date().getFullYear() + 1),
      departmentId: klass?.department_id ? String(klass.department_id) : '',
      classTeacherId: klass?.class_teacher_id ? String(klass.class_teacher_id) : '',
      capacity: klass?.capacity ? String(klass.capacity) : '',
      room: klass?.room ?? '',
      status: klass?.status ?? 'active',
    });
  }

  const update = (field: keyof typeof form, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api.post('/classes', {
            name: form.name.trim(),
            code: form.code.trim().toUpperCase(),
            level: form.level.trim() || null,
            academicYear: form.academicYear.trim(),
            departmentId: form.departmentId ? Number(form.departmentId) : null,
            classTeacherId: form.classTeacherId ? Number(form.classTeacherId) : null,
            capacity: form.capacity ? Number(form.capacity) : null,
            room: form.room.trim() || null,
          })
        : api.patch(`/classes/${klass?.id}`, {
            name: form.name.trim(),
            level: form.level.trim() || null,
            academicYear: form.academicYear.trim(),
            departmentId: form.departmentId ? Number(form.departmentId) : null,
            classTeacherId: form.classTeacherId ? Number(form.classTeacherId) : null,
            capacity: form.capacity ? Number(form.capacity) : null,
            room: form.room.trim() || null,
            status: form.status,
          }),
    onSuccess: onSaved,
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'The class could not be saved.'),
  });

  return (
    <Modal
      open={Boolean(target)}
      title={isNew ? 'New class' : `Edit ${klass?.name ?? 'class'}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="field-row">
        <TextInput label="Class name" required value={form.name} onChange={(event) => update('name', event.target.value)} />
        <TextInput label="Code" required disabled={!isNew} value={form.code} onChange={(event) => update('code', event.target.value)} />
        <TextInput label="Level" value={form.level} onChange={(event) => update('level', event.target.value)} />
      </div>
      <div className="field-row">
        <TextInput label="Academic year" required value={form.academicYear} onChange={(event) => update('academicYear', event.target.value)} />
        <SelectInput
          label="Department"
          placeholder="Not assigned"
          options={departments.map((row) => ({ value: row.id, label: row.name }))}
          value={form.departmentId}
          onChange={(event) => update('departmentId', event.target.value)}
        />
        <SelectInput
          label="Class teacher"
          placeholder="Not assigned"
          options={teachers.map((teacher) => ({ value: teacher.id, label: teacher.full_name ?? '' }))}
          value={form.classTeacherId}
          onChange={(event) => update('classTeacherId', event.target.value)}
        />
      </div>
      <div className="field-row">
        <TextInput label="Capacity" type="number" min={1} value={form.capacity} onChange={(event) => update('capacity', event.target.value)} />
        <TextInput label="Room" value={form.room} onChange={(event) => update('room', event.target.value)} />
        {!isNew ? (
          <SelectInput
            label="Status"
            value={form.status}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
            ]}
            onChange={(event) => update('status', event.target.value)}
          />
        ) : null}
      </div>
    </Modal>
  );
}

function EnrolModal({
  target,
  onClose,
  onSaved,
}: {
  target: ClassRow | null;
  onClose: () => void;
  onSaved: (moved: number) => Promise<void>;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState('');

  const students = useQuery({
    queryKey: ['students', 'options', target?.id],
    queryFn: () => api.list<Student>('/students', { pageSize: 300, status: 'active' }),
    enabled: Boolean(target),
  });

  const enrol = useMutation({
    mutationFn: () => api.post<{ moved: number }>(`/classes/${target?.id}/students`, { studentIds: selected }),
    onSuccess: (result) => void onSaved(result.moved ?? selected.length),
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'Enrolment failed.'),
  });

  return (
    <Modal
      open={Boolean(target)}
      title={`Enrol candidates into ${target?.name ?? ''}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!selected.length} loading={enrol.isPending} onClick={() => enrol.mutate()}>
            Enrol {selected.length || ''} candidate(s)
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Alert tone="info">Moving a candidate between classes changes which examinations they are assigned to by class.</Alert>
      <div className="checkbox-grid checkbox-grid--dense">
        {(students.data?.data ?? []).map((student) => (
          <label key={student.id} className="checkbox-card checkbox-card--dense">
            <input
              type="checkbox"
              checked={selected.includes(student.id)}
              onChange={(event) =>
                setSelected((current) => (event.target.checked ? [...current, student.id] : current.filter((id) => id !== student.id)))
              }
            />
            <span>
              <strong>{student.full_name}</strong>
              <small>
                {student.student_code}
                {student.class_name ? ` · currently ${student.class_name}` : ''}
              </small>
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------- subjects */
function SubjectsPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useListState({ departmentId: '', status: '' });
  const [editing, setEditing] = useState<Subject | 'new' | null>(null);

  const subjects = useQuery({
    queryKey: ['subjects', list.query],
    queryFn: () =>
      api.list<Subject>('/subjects', {
        ...list.query,
        departmentId: list.filters.departmentId || undefined,
        status: list.filters.status || undefined,
      }),
  });

  const departments = useQuery({
    queryKey: ['departments', 'options'],
    queryFn: () => api.list<Department>('/departments', { pageSize: 100 }),
  });

  return (
    <>
      <Card
        flush
        title="Subjects"
        actions={
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <IconPlus size={15} /> New subject
          </Button>
        }
      >
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search subjects"
              aria-label="Search subjects"
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
        </div>
        {subjects.error ? (
          <div className="card__body">
            <ErrorState message="Subjects could not be loaded." onRetry={() => void subjects.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              rows={subjects.data?.data ?? []}
              rowKey={(row) => row.id}
              loading={subjects.isLoading}
              empty={<p>No subjects yet.</p>}
              columns={[
                {
                  key: 'name',
                  header: 'Subject',
                  render: (row) => (
                    <div>
                      <strong>{row.name}</strong>
                      <div className="text-sm text-muted">{row.code}</div>
                    </div>
                  ),
                },
                { key: 'department', header: 'Department', render: (row) => row.department_name ?? '—' },
                { key: 'credits', header: 'Credit hours', align: 'right', render: (row) => row.credit_hours ?? '—' },
                { key: 'questions', header: 'Questions', align: 'right', render: (row) => row.question_count ?? 0 },
                { key: 'banks', header: 'Banks', align: 'right', render: (row) => row.bank_count ?? 0 },
                { key: 'exams', header: 'Examinations', align: 'right', render: (row) => row.exam_count ?? 0 },
                { key: 'teachers', header: 'Examiners', align: 'right', render: (row) => row.teacher_count ?? 0 },
                { key: 'status', header: 'Status', render: (row) => <Badge tone={row.status === 'active' ? 'success' : 'outline'}>{row.status}</Badge> },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (row) => (
                    <button type="button" className="icon-button" aria-label={`Edit ${row.name}`} onClick={() => setEditing(row)}>
                      <IconEdit size={16} />
                    </button>
                  ),
                },
              ]}
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={subjects.data?.meta.total ?? 0}
              totalPages={subjects.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <SubjectModal
        target={editing}
        departments={departments.data?.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          toast.notify('Subject saved.', 'success');
          await queryClient.invalidateQueries({ queryKey: ['subjects'] });
        }}
      />
    </>
  );
}

function SubjectModal({
  target,
  departments,
  onClose,
  onSaved,
}: {
  target: Subject | 'new' | null;
  departments: Department[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isNew = target === 'new';
  const subject = target && target !== 'new' ? target : null;
  const [form, setForm] = useState({ name: '', code: '', departmentId: '', creditHours: '', description: '', status: 'active' });
  const [error, setError] = useState('');
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const key = isNew ? 'new' : subject ? String(subject.id) : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setError('');
    setForm({
      name: subject?.name ?? '',
      code: subject?.code ?? '',
      departmentId: subject?.department_id ? String(subject.department_id) : '',
      creditHours: subject?.credit_hours ? String(subject.credit_hours) : '',
      description: subject?.description ?? '',
      status: subject?.status ?? 'active',
    });
  }

  const update = (field: keyof typeof form, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? api.post('/subjects', {
            name: form.name.trim(),
            code: form.code.trim().toUpperCase(),
            departmentId: form.departmentId ? Number(form.departmentId) : null,
            creditHours: form.creditHours ? Number(form.creditHours) : null,
            description: form.description.trim() || null,
          })
        : api.patch(`/subjects/${subject?.id}`, {
            name: form.name.trim(),
            departmentId: form.departmentId ? Number(form.departmentId) : null,
            creditHours: form.creditHours ? Number(form.creditHours) : null,
            description: form.description.trim() || null,
            status: form.status,
          }),
    onSuccess: onSaved,
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'The subject could not be saved.'),
  });

  return (
    <Modal
      open={Boolean(target)}
      title={isNew ? 'New subject' : `Edit ${subject?.name ?? 'subject'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="field-row">
        <TextInput label="Name" required value={form.name} onChange={(event) => update('name', event.target.value)} />
        <TextInput label="Code" required disabled={!isNew} value={form.code} onChange={(event) => update('code', event.target.value)} />
      </div>
      <div className="field-row">
        <SelectInput
          label="Department"
          placeholder="Not assigned"
          options={departments.map((row) => ({ value: row.id, label: row.name }))}
          value={form.departmentId}
          onChange={(event) => update('departmentId', event.target.value)}
        />
        <TextInput label="Credit hours" type="number" min={0} value={form.creditHours} onChange={(event) => update('creditHours', event.target.value)} />
        {!isNew ? (
          <SelectInput
            label="Status"
            value={form.status}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
            ]}
            onChange={(event) => update('status', event.target.value)}
          />
        ) : null}
      </div>
      <TextArea label="Description" rows={2} value={form.description} onChange={(event) => update('description', event.target.value)} />
    </Modal>
  );
}

/* ------------------------------------------------------------------------ groups */
function GroupsPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Group | 'new' | null>(null);

  const groups = useQuery({
    queryKey: ['groups', 'all'],
    queryFn: () => api.list<Group>('/groups', { pageSize: 200 }),
  });

  const classes = useQuery({
    queryKey: ['classes', 'options'],
    queryFn: () => api.list<ClassRow>('/classes', { pageSize: 200 }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/groups/${id}`),
    onSuccess: async () => {
      toast.notify('Group removed.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
    onError: (caught) => toast.notify(caught instanceof ApiError ? caught.message : 'The group could not be removed.', 'error'),
  });

  return (
    <>
      <Card
        flush
        title="Study groups"
        actions={
          <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
            <IconPlus size={15} /> New group
          </Button>
        }
      >
        {groups.error ? (
          <div className="card__body">
            <ErrorState message="Groups could not be loaded." onRetry={() => void groups.refetch()} />
          </div>
        ) : (
          <DataTable
            rows={groups.data?.data ?? []}
            rowKey={(row) => row.id}
            loading={groups.isLoading}
            empty={<p>No study groups yet. Groups let you assign papers to a subset of a class.</p>}
            columns={[
              {
                key: 'name',
                header: 'Group',
                render: (row) => (
                  <div>
                    <strong>{row.name}</strong>
                    <div className="text-sm text-muted">{row.description || 'No description'}</div>
                  </div>
                ),
              },
              { key: 'class', header: 'Class', render: (row) => row.class_name ?? '—' },
              { key: 'members', header: 'Members', align: 'right', render: (row) => row.member_count ?? 0 },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) => (
                  <div className="table-actions">
                    <button type="button" className="icon-button" aria-label={`Edit ${row.name}`} onClick={() => setEditing(row)}>
                      <IconEdit size={16} />
                    </button>
                    <Button size="sm" variant="ghost" onClick={() => remove.mutate(row.id)}>
                      Remove
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>

      <GroupModal
        target={editing}
        classes={classes.data?.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          toast.notify('Group saved.', 'success');
          await queryClient.invalidateQueries({ queryKey: ['groups'] });
        }}
      />
    </>
  );
}

function GroupModal({
  target,
  classes,
  onClose,
  onSaved,
}: {
  target: Group | 'new' | null;
  classes: ClassRow[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const isNew = target === 'new';
  const group = target && target !== 'new' ? target : null;
  const [form, setForm] = useState({ name: '', classId: '', description: '', studentIds: [] as number[] });
  const [error, setError] = useState('');
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const students = useQuery({
    queryKey: ['students', 'options', form.classId],
    queryFn: () => api.list<Student>('/students', { pageSize: 300, classId: form.classId || undefined, status: 'active' }),
    enabled: Boolean(form.classId),
  });

  const members = useQuery({
    queryKey: ['group', group?.id],
    queryFn: () => api.get<{ members: { student_id: number }[] }>(`/groups/${group?.id}`),
    enabled: Boolean(group),
  });

  const key = isNew ? 'new' : group ? String(group.id) : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setError('');
    setForm({
      name: group?.name ?? '',
      classId: group?.class_id ? String(group.class_id) : '',
      description: group?.description ?? '',
      studentIds: [],
    });
  }

  if (members.data && group && form.studentIds.length === 0) {
    setForm((current) => ({ ...current, studentIds: members.data!.members.map((member) => member.student_id) }));
  }

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        classId: form.classId ? Number(form.classId) : null,
        description: form.description.trim() || null,
      };
      const saved = isNew ? await api.post<Group>('/groups', payload) : await api.patch<Group>(`/groups/${group?.id}`, payload);
      await api.post(`/groups/${saved.id}/members`, { studentIds: form.studentIds });
      return saved;
    },
    onSuccess: onSaved,
    onError: (caught) => setError(caught instanceof ApiError ? caught.message : 'The group could not be saved.'),
  });

  return (
    <Modal
      open={Boolean(target)}
      title={isNew ? 'New study group' : `Edit ${group?.name ?? 'group'}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save group
          </Button>
        </>
      }
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="field-row">
        <TextInput label="Group name" required value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
        <SelectInput
          label="Class"
          placeholder="Select a class"
          options={classes.map((row) => ({ value: row.id, label: row.name }))}
          value={form.classId}
          onChange={(event) => setForm((current) => ({ ...current, classId: event.target.value, studentIds: [] }))}
        />
      </div>
      <TextArea
        label="Description"
        rows={2}
        value={form.description}
        onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
      />
      <h3 className="modal-section-title">Members</h3>
      {!form.classId ? (
        <p className="text-sm text-muted">Select a class to choose members.</p>
      ) : (
        <div className="checkbox-grid checkbox-grid--dense">
          {(students.data?.data ?? []).map((student) => (
            <label key={student.id} className="checkbox-card checkbox-card--dense">
              <input
                type="checkbox"
                checked={form.studentIds.includes(student.id)}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    studentIds: event.target.checked
                      ? [...current.studentIds, student.id]
                      : current.studentIds.filter((id) => id !== student.id),
                  }))
                }
              />
              <span>
                <strong>{student.full_name}</strong>
                <small>{student.student_code}</small>
              </span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}
