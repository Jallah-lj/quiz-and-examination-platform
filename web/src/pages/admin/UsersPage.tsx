import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDateTime, titleCase } from '../../lib/format';
import { useListState } from '../../lib/hooks';
import { useAuth } from '../../context/AuthContext';
import type { ClassRow, Department, Institution, PermissionRow, RoleRow, UserRow } from '../../types';
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
  Tabs,
  TextInput,
  useToast,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';
import { IconPlus, IconSearch, IconShield } from '../../components/Icons';

interface UserForm {
  fullName: string;
  email: string;
  role: string;
  password: string;
  phone: string;
  institutionId: string;
  studentCode: string;
  classId: string;
  staffCode: string;
  departmentId: string;
  designation: string;
  specialization: string;
  status: string;
}

const emptyUser: UserForm = {
  fullName: '',
  email: '',
  role: 'student',
  password: '',
  phone: '',
  institutionId: '',
  studentCode: '',
  classId: '',
  staffCode: '',
  departmentId: '',
  designation: '',
  specialization: '',
  status: 'active',
};

export default function UsersPage() {
  const { user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const isPlatformAdmin = user?.role === 'super_admin';
  const [tab, setTab] = useState('accounts');
  const list = useListState({ role: '', status: '', institutionId: '' });
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [statusTarget, setStatusTarget] = useState<UserRow | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ['users', list.query],
    queryFn: () =>
      api.list<UserRow>('/users', {
        ...list.query,
        role: list.filters.role || undefined,
        status: list.filters.status || undefined,
        institutionId: list.filters.institutionId || undefined,
      }),
  });

  const institutions = useQuery({
    queryKey: ['institutions', 'options'],
    queryFn: () => api.list<Institution>('/institutions', { pageSize: 100 }),
    enabled: isPlatformAdmin,
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api.post(`/users/${id}/status`, { status }),
    onSuccess: async (_result, variables) => {
      toast.notify(`Account status set to ${variables.status}.`, 'success');
      setStatusTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (caught) => {
      toast.notify(caught instanceof ApiError ? caught.message : 'The status could not be changed.', 'error');
      setStatusTarget(null);
    },
  });

  const resetPassword = useMutation({
    mutationFn: (id: number) => api.post<{ temporaryPassword?: string }>(`/users/${id}/reset-password`, {}),
    onSuccess: async (result) => {
      setTemporaryPassword(result.temporaryPassword ?? null);
      toast.notify('Password reset. Hand the temporary password to the user securely.', 'success');
      setResetTarget(null);
    },
    onError: (caught) => {
      toast.notify(caught instanceof ApiError ? caught.message : 'The password could not be reset.', 'error');
      setResetTarget(null);
    },
  });

  const revokeSessions = useMutation({
    mutationFn: (id: number) => api.post(`/users/${id}/revoke-sessions`),
    onSuccess: () => toast.notify('All sessions for this account have been revoked.', 'success'),
    onError: (caught) => toast.notify(caught instanceof ApiError ? caught.message : 'Sessions could not be revoked.', 'error'),
  });

  const rows = users.data?.data ?? [];

  return (
    <div className="page">
      <PageHeader
        title="User accounts"
        description="Accounts, roles, permissions and access control. Every change is written to the audit log."
        actions={
          hasPermission('user.create') ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <IconPlus size={16} /> New account
            </Button>
          ) : null
        }
      />

      <Tabs
        tabs={[
          { key: 'accounts', label: 'Accounts', count: users.data?.meta.total },
          ...(hasPermission('role.manage') ? [{ key: 'roles', label: 'Roles & permissions' }] : []),
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'accounts' ? (
        <>
          <div className="stat-grid stat-grid--compact">
            <StatCard label="Accounts" value={users.data?.meta.total ?? 0} />
            <StatCard label="Active" value={rows.filter((row) => row.status === 'active').length} tone="success" />
            <StatCard label="Suspended or disabled" value={rows.filter((row) => row.status !== 'active').length} tone={rows.some((row) => row.status !== 'active') ? 'warning' : 'neutral'} />
            <StatCard label="Currently locked out" value={rows.filter((row) => row.locked).length} tone={rows.some((row) => row.locked) ? 'danger' : 'neutral'} />
          </div>

          <Card flush>
            <div className="filter-bar">
              <div className="search-input">
                <IconSearch size={16} />
                <input
                  type="search"
                  className="input"
                  placeholder="Search name or email"
                  aria-label="Search users"
                  value={list.search}
                  onChange={(event) => list.setSearch(event.target.value)}
                />
              </div>
              <SelectInput
                wrapperClassName="filter-bar__field"
                placeholder="All roles"
                options={[
                  { value: 'super_admin', label: 'Super administrator' },
                  { value: 'institution_admin', label: 'Institution administrator' },
                  { value: 'teacher', label: 'Examiner' },
                  { value: 'student', label: 'Candidate' },
                ]}
                value={list.filters.role}
                onChange={(event) => list.updateFilter('role', event.target.value)}
              />
              <SelectInput
                wrapperClassName="filter-bar__field"
                placeholder="All statuses"
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'pending', label: 'Pending activation' },
                  { value: 'suspended', label: 'Suspended' },
                  { value: 'disabled', label: 'Disabled' },
                ]}
                value={list.filters.status}
                onChange={(event) => list.updateFilter('status', event.target.value)}
              />
              {isPlatformAdmin ? (
                <SelectInput
                  wrapperClassName="filter-bar__field"
                  placeholder="All institutions"
                  options={(institutions.data?.data ?? []).map((institution) => ({ value: institution.id, label: institution.name }))}
                  value={list.filters.institutionId}
                  onChange={(event) => list.updateFilter('institutionId', event.target.value)}
                />
              ) : null}
              <Button size="sm" onClick={list.resetFilters}>
                Clear
              </Button>
            </div>

            {users.error ? (
              <div className="card__body">
                <ErrorState message="Accounts could not be loaded." onRetry={() => void users.refetch()} />
              </div>
            ) : (
              <>
                <DataTable
                  rows={rows}
                  rowKey={(row) => row.id}
                  loading={users.isLoading}
                  empty={<p>No accounts match these filters.</p>}
                  columns={[
                    {
                      key: 'name',
                      header: 'Account',
                      render: (row) => (
                        <div>
                          <strong>{row.full_name}</strong>
                          <div className="text-sm text-muted">{row.email}</div>
                        </div>
                      ),
                    },
                    { key: 'role', header: 'Role', render: (row) => <Badge tone="outline">{row.role_name}</Badge> },
                    { key: 'institution', header: 'Institution', render: (row) => row.institution_name ?? 'Platform' },
                    {
                      key: 'status',
                      header: 'Status',
                      render: (row) => (
                        <div className="inline">
                          <Badge tone={row.status === 'active' ? 'success' : row.status === 'suspended' ? 'danger' : 'warning'}>
                            {row.status}
                          </Badge>
                          {row.locked ? <Badge tone="danger">Locked out</Badge> : null}
                          {!row.email_verified_at ? <Badge tone="outline">Unverified</Badge> : null}
                        </div>
                      ),
                    },
                    { key: 'last_login', header: 'Last sign-in', render: (row) => (row.last_login_at ? formatDateTime(row.last_login_at) : 'Never') },
                    {
                      key: 'actions',
                      header: '',
                      align: 'right',
                      render: (row) => (
                        <div className="table-actions">
                          {hasPermission('user.update') ? (
                            <Button size="sm" onClick={() => setEditing(row)}>
                              Edit
                            </Button>
                          ) : null}
                          {hasPermission('user.status') ? (
                            <Button size="sm" onClick={() => setStatusTarget(row)}>
                              Status
                            </Button>
                          ) : null}
                          {hasPermission('user.reset_password') ? (
                            <Button size="sm" onClick={() => setResetTarget(row)}>
                              Reset password
                            </Button>
                          ) : null}
                          {hasPermission('user.status') ? (
                            <Button size="sm" variant="ghost" onClick={() => revokeSessions.mutate(row.id)}>
                              Sign out everywhere
                            </Button>
                          ) : null}
                        </div>
                      ),
                    },
                  ]}
                />
                <Pagination
                  page={list.page}
                  pageSize={list.pageSize}
                  total={users.data?.meta.total ?? 0}
                  totalPages={users.data?.meta.totalPages ?? 1}
                  onPageChange={list.setPage}
                />
              </>
            )}
          </Card>
        </>
      ) : (
        <RolesPanel />
      )}

      <UserModal
        target={editing}
        isPlatformAdmin={isPlatformAdmin}
        institutions={institutions.data?.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={async (password) => {
          setEditing(null);
          if (password) setTemporaryPassword(password);
          toast.notify(password ? 'Account created with a temporary password.' : 'Account updated.', 'success');
          await queryClient.invalidateQueries({ queryKey: ['users'] });
        }}
      />

      <ConfirmDialog
        open={Boolean(statusTarget)}
        title={`Change status for ${statusTarget?.full_name ?? ''}`}
        message="Suspending or disabling an account immediately blocks sign-in and invalidates existing sessions. Historical records are preserved."
        confirmLabel="Set to suspended"
        busy={setStatus.isPending}
        onConfirm={() => statusTarget && setStatus.mutate({ id: statusTarget.id, status: 'suspended' })}
        onCancel={() => setStatusTarget(null)}
      />

      <ConfirmDialog
        open={Boolean(resetTarget)}
        title={`Reset password for ${resetTarget?.full_name ?? ''}`}
        message="A new temporary password is generated. Existing sessions are revoked and the user must change the password at next sign-in. The action is recorded in the audit log."
        confirmLabel="Reset password"
        tone="primary"
        busy={resetPassword.isPending}
        onConfirm={() => resetTarget && resetPassword.mutate(resetTarget.id)}
        onCancel={() => setResetTarget(null)}
      />

      <Modal open={Boolean(temporaryPassword)} title="Temporary password" onClose={() => setTemporaryPassword(null)}>
        <Alert tone="warning" title="Share this password securely">
          It is shown once and never stored in readable form. The user should change it immediately after signing in.
        </Alert>
        <p className="code-block" style={{ fontSize: 18 }}>
          {temporaryPassword}
        </p>
        <div className="modal-actions">
          <Button
            onClick={() => {
              if (temporaryPassword) void navigator.clipboard?.writeText(temporaryPassword);
              toast.notify('Password copied to the clipboard.', 'info');
            }}
          >
            Copy
          </Button>
          <Button variant="primary" onClick={() => setTemporaryPassword(null)}>
            Done
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function UserModal({
  target,
  isPlatformAdmin,
  institutions,
  onClose,
  onSaved,
}: {
  target: UserRow | 'new' | null;
  isPlatformAdmin: boolean;
  institutions: Institution[];
  onClose: () => void;
  onSaved: (temporaryPassword?: string) => Promise<void>;
}) {
  const isNew = target === 'new';
  const account = target && target !== 'new' ? target : null;
  const [form, setForm] = useState<UserForm>(emptyUser);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const classes = useQuery({
    queryKey: ['classes', 'options'],
    queryFn: () => api.list<ClassRow>('/classes', { pageSize: 200 }),
    enabled: isNew && (form.role === 'student' || form.role === 'institution_admin'),
  });

  const departments = useQuery({
    queryKey: ['departments', 'options'],
    queryFn: () => api.list<Department>('/departments', { pageSize: 100 }),
    enabled: isNew && form.role === 'teacher',
  });

  const key = isNew ? 'new' : account ? String(account.id) : null;
  if (key !== seededFor) {
    setSeededFor(key);
    setErrors({});
    setError('');
    setForm(
      account
        ? { ...emptyUser, fullName: account.full_name, email: account.email, role: account.role, phone: account.phone ?? '', institutionId: account.institution_id ? String(account.institution_id) : '', status: account.status }
        : emptyUser,
    );
  }

  const update = (field: keyof UserForm, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const save = useMutation({
    mutationFn: async () => {
      if (isNew) {
        const response = await api.post<{ temporaryPassword?: string }>('/users', {
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          role: form.role,
          password: form.password || undefined,
          phone: form.phone.trim() || null,
          institutionId: isPlatformAdmin && form.institutionId ? Number(form.institutionId) : undefined,
          studentCode: form.role === 'student' ? form.studentCode.trim() || undefined : undefined,
          classId: form.role === 'student' && form.classId ? Number(form.classId) : undefined,
          staffCode: form.role === 'teacher' ? form.staffCode.trim() || undefined : undefined,
          departmentId: form.role === 'teacher' && form.departmentId ? Number(form.departmentId) : undefined,
          designation: form.role === 'teacher' ? form.designation.trim() || null : undefined,
          specialization: form.role === 'teacher' ? form.specialization.trim() || null : undefined,
        });
        return response.temporaryPassword;
      }
      await api.patch(`/users/${account?.id}`, {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
      });
      return undefined;
    },
    onSuccess: (password) => void onSaved(password),
    onError: (caught) => {
      if (caught instanceof ApiError) {
        setErrors(caught.fieldErrors());
        setError(caught.message);
      } else {
        setError('The account could not be saved.');
      }
    },
  });

  return (
    <Modal
      open={Boolean(target)}
      title={isNew ? 'New user account' : `Edit ${account?.full_name ?? 'account'}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {isNew ? 'Create account' : 'Save changes'}
          </Button>
        </>
      }
    >
      {error && !Object.keys(errors).length ? <Alert tone="danger">{error}</Alert> : null}
      <div className="field-row">
        <TextInput label="Full name" required value={form.fullName} error={errors.fullName} onChange={(event) => update('fullName', event.target.value)} />
        <TextInput label="Email address" type="email" required value={form.email} error={errors.email} onChange={(event) => update('email', event.target.value)} />
      </div>

      {isNew ? (
        <>
          <div className="field-row">
            <SelectInput
              label="Role"
              required
              value={form.role}
              options={[
                { value: 'student', label: 'Candidate' },
                { value: 'teacher', label: 'Examiner' },
                ...(isPlatformAdmin
                  ? [
                      { value: 'institution_admin', label: 'Institution administrator' },
                      { value: 'super_admin', label: 'Super administrator' },
                    ]
                  : [{ value: 'institution_admin', label: 'Institution administrator' }]),
              ]}
              onChange={(event) => update('role', event.target.value)}
            />
            {isPlatformAdmin && form.role !== 'super_admin' ? (
              <SelectInput
                label="Institution"
                required
                placeholder="Select an institution"
                options={institutions.map((institution) => ({ value: institution.id, label: institution.name }))}
                value={form.institutionId}
                error={errors.institutionId}
                onChange={(event) => update('institutionId', event.target.value)}
              />
            ) : null}
            <TextInput
              label="Initial password"
              type="password"
              hint="Optional — a temporary password is generated when empty."
              value={form.password}
              error={errors.password}
              onChange={(event) => update('password', event.target.value)}
            />
          </div>

          {form.role === 'student' ? (
            <div className="field-row">
              <TextInput label="Candidate number" value={form.studentCode} onChange={(event) => update('studentCode', event.target.value)} />
              <SelectInput
                label="Class"
                placeholder="Not assigned"
                options={(classes.data?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                value={form.classId}
                onChange={(event) => update('classId', event.target.value)}
              />
            </div>
          ) : null}

          {form.role === 'teacher' ? (
            <div className="field-row">
              <TextInput label="Staff number" value={form.staffCode} onChange={(event) => update('staffCode', event.target.value)} />
              <SelectInput
                label="Department"
                placeholder="Not assigned"
                options={(departments.data?.data ?? []).map((row) => ({ value: row.id, label: row.name }))}
                value={form.departmentId}
                onChange={(event) => update('departmentId', event.target.value)}
              />
              <TextInput label="Designation" value={form.designation} onChange={(event) => update('designation', event.target.value)} />
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="field-row">
            <TextInput label="Phone" value={form.phone} onChange={(event) => update('phone', event.target.value)} />
            <TextInput label="Role" value={titleCase(account?.role)} disabled />
          </div>
          <Alert tone="info">
            Roles are changed by an administrator with role management permission. Use the Roles tab to review which
            permissions a role carries.
          </Alert>
        </>
      )}
    </Modal>
  );
}

function RolesPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [roleId, setRoleId] = useState<number | null>(null);

  const roles = useQuery({
    queryKey: ['users', 'roles'],
    queryFn: () => api.get<RoleRow[]>('/users/roles'),
  });

  const permissions = useQuery({
    queryKey: ['users', 'permissions'],
    queryFn: () => api.get<PermissionRow[]>('/users/permissions'),
  });

  const rolePermissions = useQuery({
    queryKey: ['users', 'roles', roleId, 'permissions'],
    queryFn: () => api.get<{ roleId: number; permissions: string[] }>(`/users/roles/${roleId}/permissions`),
    enabled: Boolean(roleId),
  });

  const [selected, setSelected] = useState<string[]>([]);
  const [seededFor, setSeededFor] = useState<number | null>(null);
  if (rolePermissions.data && rolePermissions.data.roleId !== seededFor) {
    setSeededFor(rolePermissions.data.roleId);
    setSelected(rolePermissions.data.permissions);
  }

  const save = useMutation({
    mutationFn: () => api.put(`/users/roles/${roleId}/permissions`, { permissions: selected }),
    onSuccess: async () => {
      toast.notify('Role permissions updated. Affected users see the change on their next request.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (caught) => toast.notify(caught instanceof ApiError ? caught.message : 'Permissions could not be saved.', 'error'),
  });

  const grouped = (permissions.data ?? []).reduce<Record<string, PermissionRow[]>>((accumulator, permission) => {
    const category = permission.category || 'general';
    accumulator[category] = accumulator[category] ?? [];
    accumulator[category].push(permission);
    return accumulator;
  }, {});

  return (
    <div className="split-2">
      <Card title="Roles" flush>
        <DataTable
          rows={roles.data ?? []}
          rowKey={(row) => row.id}
          loading={roles.isLoading}
          columns={[
            {
              key: 'name',
              header: 'Role',
              render: (row) => (
                <div>
                  <strong>{row.name}</strong>
                  <div className="text-sm text-muted">{row.code}</div>
                </div>
              ),
            },
            { key: 'scope', header: 'Scope', render: (row) => <Badge tone="outline">{row.scope}</Badge> },
            { key: 'permissions', header: 'Permissions', align: 'right', render: (row) => row.permissionCount },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (row) => (
                <Button size="sm" onClick={() => setRoleId(row.id)}>
                  <IconShield size={15} /> Review
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="Permissions"
        description={roleId ? `Editing permissions for ${roles.data?.find((role) => role.id === roleId)?.name ?? 'role'}` : 'Select a role to review its permissions.'}
      >
        {!roleId ? (
          <p className="text-muted">Choose a role on the left to see and adjust the permissions it grants.</p>
        ) : rolePermissions.isLoading ? (
          <p className="text-muted">Loading permissions…</p>
        ) : (
          <>
            {roles.data?.find((role) => role.id === roleId)?.code === 'super_admin' ? (
              <Alert tone="warning">
                The platform administrator role always holds every permission. Changes here do not restrict it.
              </Alert>
            ) : null}
            {Object.entries(grouped).map(([category, entries]) => (
              <div key={category} className="permission-group">
                <h3>{titleCase(category)}</h3>
                <div className="checkbox-grid checkbox-grid--dense">
                  {entries.map((permission) => (
                    <label key={permission.code} className="checkbox-card checkbox-card--dense">
                      <input
                        type="checkbox"
                        checked={selected.includes(permission.code)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked ? [...current, permission.code] : current.filter((code) => code !== permission.code),
                          )
                        }
                      />
                      <span>
                        <strong>{permission.code}</strong>
                        <small>{permission.description}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="form-actions">
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                Save permissions
              </Button>
              <Button onClick={() => setSelected(rolePermissions.data?.permissions ?? [])}>Reset</Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
