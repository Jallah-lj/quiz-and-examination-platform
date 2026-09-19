import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDateTime, titleCase } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import { useAuth } from '../../context/AuthContext';
import type { Institution } from '../../types';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
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
import { IconPlus, IconSearch } from '../../components/Icons';

interface InstitutionForm {
  name: string;
  code: string;
  type: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  timezone: string;
  adminName: string;
  adminEmail: string;
}

const emptyInstitution: InstitutionForm = {
  name: '',
  code: '',
  type: 'school',
  email: '',
  phone: '',
  address: '',
  city: '',
  country: '',
  timezone: 'UTC',
  adminName: '',
  adminEmail: '',
};

export default function InstitutionsPage() {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const list = useListState({ status: '' });
  const [editing, setEditing] = useState<Institution | 'new' | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ institution: Institution; status: string } | null>(null);
  const [credentials, setCredentials] = useState<{ email: string; password?: string } | null>(null);

  const institutions = useQuery({
    queryKey: ['institutions', list.query],
    queryFn: () => api.list<Institution>('/institutions', list.query),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api.post(`/institutions/${id}/status`, { status }),
    onSuccess: async (_result, variables) => {
      toast.notify(`Institution is now ${variables.status}.`, 'success');
      setStatusTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['institutions'] });
    },
    onError: (caught) => {
      toast.notify(caught instanceof ApiError ? caught.message : 'The status could not be changed.', 'error');
      setStatusTarget(null);
    },
  });

  const rows = institutions.data?.data ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Institutions"
        description="Each institution has its own users, academic structure, examinations and results. Data is isolated between institutions."
        actions={
          hasPermission('institution.create') ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <IconPlus size={16} /> New institution
            </Button>
          ) : null
        }
      />

      <div className="stat-grid stat-grid--compact">
        <StatCard label="Institutions" value={institutions.data?.meta.total ?? 0} />
        <StatCard label="Active" value={rows.filter((row) => row.status === 'active').length} tone="success" />
        <StatCard label="Candidates" value={rows.reduce((sum, row) => sum + (row.student_count ?? 0), 0)} />
        <StatCard label="Examiners" value={rows.reduce((sum, row) => sum + (row.teacher_count ?? 0), 0)} />
        <StatCard label="Examinations" value={rows.reduce((sum, row) => sum + (row.exam_count ?? 0), 0)} />
      </div>

      {rows.some((row) => row.is_demo) ? (
        <Alert tone="info" title="Demonstration data present">
          Institutions marked <strong>Demonstration</strong> contain sample records that are clearly labelled and never
          mixed with production statistics.
        </Alert>
      ) : null}

      <Card flush>
        <div className="filter-bar">
          <div className="search-input">
            <IconSearch size={16} />
            <input
              type="search"
              className="input"
              placeholder="Search institution name, code or city"
              aria-label="Search institutions"
              value={list.search}
              onChange={(event) => list.setSearch(event.target.value)}
            />
          </div>
          <SelectInput
            wrapperClassName="filter-bar__field"
            placeholder="All statuses"
            options={[
              { value: 'active', label: 'Active' },
              { value: 'suspended', label: 'Suspended' },
              { value: 'archived', label: 'Archived' },
            ]}
            value={list.filters.status}
            onChange={(event) => list.updateFilter('status', event.target.value)}
          />
        </div>

        {institutions.error ? (
          <div className="card__body">
            <ErrorState message="Institutions could not be loaded." onRetry={() => void institutions.refetch()} />
          </div>
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              loading={institutions.isLoading}
              empty={<p>No institutions have been created yet.</p>}
              columns={[
                {
                  key: 'name',
                  header: 'Institution',
                  render: (row) => (
                    <div>
                      <strong>{row.name}</strong>
                      <div className="text-sm text-muted">
                        {row.code} · {titleCase(row.type)}
                        {row.city ? ` · ${row.city}` : ''}
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'contact',
                  header: 'Contact',
                  render: (row) => (
                    <span className="text-sm">
                      {row.email ?? '—'}
                      {row.phone ? <div className="text-muted">{row.phone}</div> : null}
                    </span>
                  ),
                },
                { key: 'students', header: 'Candidates', align: 'right', render: (row) => row.student_count ?? 0 },
                { key: 'teachers', header: 'Examiners', align: 'right', render: (row) => row.teacher_count ?? 0 },
                { key: 'exams', header: 'Examinations', align: 'right', render: (row) => row.exam_count ?? 0 },
                {
                  key: 'status',
                  header: 'Status',
                  render: (row) => (
                    <div className="inline">
                      <Badge tone={row.status === 'active' ? 'success' : row.status === 'suspended' ? 'danger' : 'outline'}>{row.status}</Badge>
                      {row.is_demo ? <Badge tone="warning">Demonstration</Badge> : null}
                    </div>
                  ),
                },
                { key: 'created', header: 'Created', render: (row) => formatDateTime(row.created_at) },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (row) => (
                    <div className="table-actions">
                      {hasPermission('institution.manage') ? (
                        <Button size="sm" onClick={() => setEditing(row)}>
                          Edit
                        </Button>
                      ) : null}
                      {hasPermission('platform.manage') ? (
                        <>
                          <Button
                            size="sm"
                            onClick={() => setStatusTarget({ institution: row, status: row.status === 'active' ? 'suspended' : 'active' })}
                          >
                            {row.status === 'active' ? 'Suspend' : 'Reactivate'}
                          </Button>
                          <Link className="btn btn--sm" to={`/users?institutionId=${row.id}`}>
                            Accounts
                          </Link>
                        </>
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={institutions.data?.meta.total ?? 0}
              totalPages={institutions.data?.meta.totalPages ?? 1}
              onPageChange={list.setPage}
            />
          </>
        )}
      </Card>

      <InstitutionModal
        target={editing}
        onClose={() => setEditing(null)}
        onSaved={async (admin) => {
          setEditing(null);
          if (admin) setCredentials(admin);
          toast.notify('Institution saved.', 'success');
          await queryClient.invalidateQueries({ queryKey: ['institutions'] });
        }}
      />

      <ConfirmDialog
        open={Boolean(statusTarget)}
        title={statusTarget?.status === 'active' ? 'Reactivate institution' : 'Suspend institution'}
        message={
          statusTarget?.status === 'active'
            ? 'Users of this institution can sign in again.'
            : 'Suspending an institution immediately invalidates the sessions of all of its users. Historical records are preserved.'
        }
        confirmLabel={statusTarget?.status === 'active' ? 'Reactivate' : 'Suspend'}
        busy={setStatus.isPending}
        onConfirm={() => statusTarget && setStatus.mutate({ id: statusTarget.institution.id, status: statusTarget.status })}
        onCancel={() => setStatusTarget(null)}
      />

      <Modal open={Boolean(credentials)} title="Administrator account created" onClose={() => setCredentials(null)}>
        <Alert tone="warning" title="Share these credentials securely">
          The temporary password is shown once. The administrator must change it at first sign-in.
        </Alert>
        <p>
          Email: <strong>{credentials?.email}</strong>
        </p>
        {credentials?.password ? <p className="code-block">{credentials.password}</p> : null}
        <div className="modal-actions">
          <Button variant="primary" onClick={() => setCredentials(null)}>
            Done
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function InstitutionModal({
  target,
  onClose,
  onSaved,
}: {
  target: Institution | 'new' | null;
  onClose: () => void;
  onSaved: (admin?: { email: string; password?: string }) => Promise<void>;
}) {
  const isNew = target === 'new';
  const institution = target && target !== 'new' ? target : null;
  const [form, setForm] = useState<InstitutionForm>(emptyInstitution);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const key = isNew ? 'new' : institution ? String(institution.id) : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setErrors({});
    setError('');
    setForm(
      institution
        ? {
            ...emptyInstitution,
            name: institution.name,
            code: institution.code,
            type: institution.type,
            email: institution.email ?? '',
            phone: institution.phone ?? '',
            address: institution.address ?? '',
            city: institution.city ?? '',
            country: institution.country ?? '',
            timezone: institution.timezone,
          }
        : emptyInstitution,
    );
  }

  const update = (field: keyof InstitutionForm, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        const response = await api.post<{ institution: Institution; administrator?: { email: string; temporaryPassword?: string } }>(
          '/institutions',
          {
            name: form.name.trim(),
            code: form.code.trim().toUpperCase(),
            type: form.type,
            email: form.email.trim() || null,
            phone: form.phone.trim() || null,
            address: form.address.trim() || null,
            city: form.city.trim() || null,
            country: form.country.trim() || null,
            timezone: form.timezone.trim() || 'UTC',
            adminName: form.adminName.trim() || undefined,
            adminEmail: form.adminEmail.trim() || undefined,
          },
        );
        return response.administrator
          ? { email: response.administrator.email, password: response.administrator.temporaryPassword }
          : undefined;
      }
      await api.patch(`/institutions/${institution?.id}`, {
        name: form.name.trim(),
        type: form.type,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        country: form.country.trim() || null,
        timezone: form.timezone.trim(),
      });
      return undefined;
    },
    onSuccess: (admin) => void onSaved(admin),
    onError: (caught) => {
      if (caught instanceof ApiError) {
        setErrors(caught.fieldErrors());
        setError(caught.message);
      } else {
        setError('The institution could not be saved.');
      }
    },
  });

  return (
    <Modal
      open={Boolean(target)}
      title={isNew ? 'New institution' : `Edit ${institution?.name ?? 'institution'}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {isNew ? 'Create institution' : 'Save changes'}
          </Button>
        </>
      }
    >
      {error && !Object.keys(errors).length ? <Alert tone="danger">{error}</Alert> : null}
      <div className="field-row">
        <TextInput label="Institution name" required value={form.name} error={errors.name} onChange={(event) => update('name', event.target.value)} />
        <TextInput
          label="Short code"
          required
          disabled={!isNew}
          hint="Letters, numbers and hyphens only. Used in candidate numbers."
          value={form.code}
          error={errors.code}
          onChange={(event) => update('code', event.target.value)}
        />
      </div>
      <div className="field-row">
        <SelectInput
          label="Type"
          value={form.type}
          options={[
            { value: 'school', label: 'School' },
            { value: 'university', label: 'University' },
            { value: 'training_center', label: 'Training centre' },
            { value: 'certification_body', label: 'Certification body' },
            { value: 'organisation', label: 'Organisation' },
          ]}
          onChange={(event) => update('type', event.target.value)}
        />
        <TextInput label="Contact email" type="email" value={form.email} error={errors.email} onChange={(event) => update('email', event.target.value)} />
        <TextInput label="Phone" value={form.phone} onChange={(event) => update('phone', event.target.value)} />
      </div>
      <div className="field-row">
        <TextInput label="Address" value={form.address} onChange={(event) => update('address', event.target.value)} />
        <TextInput label="City" value={form.city} onChange={(event) => update('city', event.target.value)} />
        <TextInput label="Country" value={form.country} onChange={(event) => update('country', event.target.value)} />
        <TextInput label="Timezone" value={form.timezone} onChange={(event) => update('timezone', event.target.value)} />
      </div>

      {isNew ? (
        <>
          <h3 className="modal-section-title">First administrator (optional)</h3>
          <p className="text-sm text-muted">
            Create the institution administrator now and the server generates a temporary password shown once after
            creation.
          </p>
          <div className="field-row">
            <TextInput label="Administrator name" value={form.adminName} error={errors.adminName} onChange={(event) => update('adminName', event.target.value)} />
            <TextInput
              label="Administrator email"
              type="email"
              value={form.adminEmail}
              error={errors.adminEmail}
              onChange={(event) => update('adminEmail', event.target.value)}
            />
          </div>
        </>
      ) : null}
    </Modal>
  );
}
