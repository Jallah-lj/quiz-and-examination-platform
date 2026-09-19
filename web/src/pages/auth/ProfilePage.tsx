import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDateTime, titleCase } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import { Badge, Button, Card, ConfirmDialog, DataTable, DefinitionList, PageHeader, TextInput, useToast } from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';

interface SessionRow {
  id: number;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  current: boolean;
}

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<SessionRow | null>(null);

  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => api.get<SessionRow[]>('/auth/sessions'),
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api.post('/auth/change-password', {
        currentPassword,
        newPassword,
      }),
    onSuccess: async () => {
      toast.notify('Password updated. Your other sessions were signed out.', 'success');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordError('');
      await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
    onError: (caught) => setPasswordError(caught instanceof ApiError ? caught.message : 'The password could not be changed.'),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => api.delete(`/auth/sessions/${id}`),
    onSuccess: async () => {
      toast.notify('Session revoked.', 'success');
      setRevokeTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    },
    onError: (caught) => {
      toast.notify(caught instanceof ApiError ? caught.message : 'The session could not be revoked.', 'error');
      setRevokeTarget(null);
    },
  });

  const resendVerification = useMutation({
    mutationFn: () => api.post<{ message: string; verificationToken?: string }>('/auth/resend-verification'),
    onSuccess: async (result) => {
      toast.notify(result.verificationToken ? 'Verification link generated — check the notification panel.' : result.message, 'success');
      await refresh();
    },
    onError: (caught) => toast.notify(caught instanceof ApiError ? caught.message : 'The email could not be re-sent.', 'error'),
  });

  if (!user) return null;

  const submitPassword = (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword.length < 10) {
      setPasswordError('Use at least 10 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('The new passwords do not match.');
      return;
    }
    changePassword.mutate();
  };

  return (
    <div className="page">
      <PageHeader title="Profile & passwords" description="Your account details, active sessions and password." />

      <div className="split-2">
        <Card title="Account">
          <DefinitionList
            items={[
              { term: 'Name', description: user.fullName },
              { term: 'Email', description: user.email },
              { term: 'Role', description: <Badge tone="outline">{user.roleName}</Badge> },
              { term: 'Institution', description: user.institution?.name ?? 'Platform administration' },
              ...(user.student
                ? [
                    { term: 'Candidate number', description: user.student.student_code },
                    { term: 'Class', description: user.student.class_name ?? 'Not assigned' },
                    { term: 'Department', description: user.student.department_name ?? '—' },
                  ]
                : []),
              ...(user.teacher
                ? [
                    { term: 'Staff number', description: user.teacher.staff_code },
                    { term: 'Designation', description: user.teacher.designation ?? '—' },
                    { term: 'Department', description: user.teacher.department_name ?? '—' },
                  ]
                : []),
            ]}
          />
          <Button onClick={() => resendVerification.mutate()} loading={resendVerification.isPending}>
            Re-send verification email
          </Button>
        </Card>

        <Card title="Change password">
          <form onSubmit={submitPassword} noValidate>
            {passwordError ? <p className="field__error">{passwordError}</p> : null}
            <TextInput
              label="Current password"
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
            <TextInput
              label="New password"
              type="password"
              required
              autoComplete="new-password"
              hint="At least 10 characters. All other sessions will be signed out."
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <TextInput
              label="Confirm new password"
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            <Button type="submit" variant="primary" loading={changePassword.isPending}>
              Update password
            </Button>
          </form>
        </Card>
      </div>

      <Card title="Permissions" description="Granted to your role. Sensitive actions are always re-checked on the server.">
        <div className="chip-list chip-list--permissions">
          {user.permissions.map((permission) => (
            <li key={permission}>{permission}</li>
          ))}
        </div>
      </Card>

      <Card title="Active sessions" flush>
        {sessions.error ? (
          <div className="card__body">
            <ErrorState message="Sessions could not be loaded." onRetry={() => void sessions.refetch()} />
          </div>
        ) : (
          <DataTable
            rows={sessions.data ?? []}
            rowKey={(row) => row.id}
            loading={sessions.isLoading}
            empty={<p>No other sessions are active.</p>}
            columns={[
              {
                key: 'device',
                header: 'Device',
                render: (row) => (
                  <div>
                    <strong>{row.user_agent ? row.user_agent.split(')')[0]?.replace('Mozilla/5.0 (', '') : 'Unknown device'}</strong>
                    <div className="text-sm text-muted">{row.ip_address ?? 'unknown address'}</div>
                  </div>
                ),
              },
              { key: 'created', header: 'Signed in', render: (row) => formatDateTime(row.created_at) },
              { key: 'seen', header: 'Last seen', render: (row) => (row.last_seen_at ? formatDateTime(row.last_seen_at) : '—') },
              { key: 'expires', header: 'Expires', render: (row) => formatDateTime(row.expires_at) },
              { key: 'current', header: 'Status', render: (row) => (row.current ? <Badge tone="success">This session</Badge> : <Badge tone="outline">Active</Badge>) },
              {
                key: 'actions',
                header: '',
                align: 'right',
                render: (row) =>
                  row.current ? (
                    <span className="text-sm text-muted">Cannot revoke current session</span>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setRevokeTarget(row)}>
                      Revoke
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(revokeTarget)}
        title="Revoke this session"
        message={`The device signed in from ${revokeTarget?.ip_address ?? 'an unknown address'} will be signed out immediately.`}
        confirmLabel="Revoke session"
        busy={revoke.isPending}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget.id)}
        onCancel={() => setRevokeTarget(null)}
      />

      <p className="text-sm text-muted">
        Signed in as {titleCase(user.role)}. Password changes and session revocations are recorded in the audit log.
      </p>
    </div>
  );
}
