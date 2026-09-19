import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import type { InstitutionSetting, SystemInfo } from '../../types';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DataTable,
  DefinitionList,
  Field,
  PageHeader,
  StatCard,
  useToast,
} from '../../components/ui';
import { ErrorState } from '../../components/StatusPages';

interface SettingField {
  key: string;
  label: string;
  hint: string;
  type: 'boolean' | 'number' | 'text';
}

const SETTING_FIELDS: SettingField[] = [
  { key: 'defaultPassPercentage', label: 'Default pass percentage', hint: 'Applied when a paper does not set its own pass mark.', type: 'number' },
  { key: 'defaultExamDurationMinutes', label: 'Default examination duration (minutes)', hint: 'Pre-filled when creating a new examination.', type: 'number' },
  { key: 'defaultQuizDurationMinutes', label: 'Default quiz duration (minutes)', hint: 'Pre-filled when creating a new quiz.', type: 'number' },
  { key: 'maxAttemptsPerExam', label: 'Maximum attempts per examination', hint: 'Upper bound offered when creating papers.', type: 'number' },
  { key: 'requireEmailVerification', label: 'Require email verification before sign-in', hint: 'Applies to self-registered candidate accounts.', type: 'boolean' },
  { key: 'allowSelfRegistration', label: 'Allow candidate self-registration', hint: 'Registrations still require administrator activation.', type: 'boolean' },
  { key: 'resultReleaseRequiresApproval', label: 'Require approval before releasing results', hint: 'Adds a review step for examiners without publish rights.', type: 'boolean' },
  { key: 'supportEmail', label: 'Support email shown to candidates', hint: 'Shown on error screens and notification footers.', type: 'text' },
];

export default function SystemPage() {
  const { hasPermission, user } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const isPlatformAdmin = user?.role === 'super_admin';

  const info = useQuery({
    queryKey: ['system', 'info'],
    queryFn: () => api.get<SystemInfo>('/system/info'),
  });

  const canEditSettings = hasPermission('settings.manage') && !isPlatformAdmin;

  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<InstitutionSetting>('/settings'),
    enabled: canEditSettings,
  });

  const [form, setForm] = useState<Record<string, unknown>>({});
  const [seedKey, setSeedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    const key = JSON.stringify(settings.data);
    if (key === seedKey) return;
    setSeedKey(key);
    setForm(settings.data.settings ?? {});
  }, [settings.data, seedKey]);

  const save = useMutation({
    mutationFn: () => api.put('/settings', { settings: form }),
    onSuccess: async () => {
      toast.notify('Institution settings saved.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (caught) => toast.notify(caught instanceof ApiError ? caught.message : 'Settings could not be saved.', 'error'),
  });

  return (
    <div className="page">
      <PageHeader
        title="System status"
        description="Runtime information, operational limits and institution settings."
      />

      {info.error ? <ErrorState message="System information could not be loaded." onRetry={() => void info.refetch()} /> : null}

      {info.data ? (
        <>
          <div className="stat-grid stat-grid--compact">
            <StatCard label="Application" value={info.data.application} meta={`Environment: ${info.data.environment}`} />
            <StatCard label="Schema version" value={info.data.schemaVersion} />
            <StatCard label="Server time" value={formatDateTime(info.data.serverTime)} />
            <StatCard
              label="Demonstration data"
              value={info.data.demoDataEnabled ? <Badge tone="warning">Enabled</Badge> : <Badge tone="success">Disabled</Badge>}
              meta="Seeded demo records are labelled and never mixed with production statistics."
            />
          </div>

          <div className="split-2">
            <Card title="Record counts">
              <DefinitionList
                items={[
                  { term: 'User accounts', description: info.data.counts.users },
                  { term: 'Audit entries', description: info.data.counts.audit_entries },
                  { term: 'Active sessions', description: info.data.counts.active_sessions },
                ]}
              />
            </Card>
            <Card title="Operational limits">
              <DefinitionList
                items={[
                  { term: 'Failed sign-ins before lockout', description: info.data.limits.loginMaxAttempts },
                  { term: 'Lockout duration', description: `${info.data.limits.loginLockMinutes} minutes` },
                  { term: 'Session lifetime', description: `${info.data.limits.sessionTtlHours} hours` },
                  { term: 'Clock grace for submissions', description: `${info.data.limits.attemptClockGraceSeconds} seconds` },
                ]}
              />
              <Alert tone="info">
                These limits come from server configuration and environment variables. They are never stored in the browser
                and cannot be changed by a candidate.
              </Alert>
            </Card>
          </div>
        </>
      ) : null}

      {canEditSettings ? (
        <Card
          title="Institution settings"
          description="Settings are stored per institution and applied to default values and policy decisions."
          actions={
            <Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>
              Save settings
            </Button>
          }
        >
          {settings.isLoading ? <p className="text-muted">Loading settings…</p> : null}
          <div className="settings-grid">
            {SETTING_FIELDS.map((field) => {
              if (field.type === 'boolean') {
                return (
                  <Checkbox
                    key={field.key}
                    label={field.label}
                    hint={field.hint}
                    checked={Boolean(form[field.key])}
                    onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.checked }))}
                  />
                );
              }
              return (
                <Field key={field.key} label={field.label} htmlFor={`setting-${field.key}`} hint={field.hint}>
                  <input
                    id={`setting-${field.key}`}
                    className="input"
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={form[field.key] === undefined || form[field.key] === null ? '' : String(form[field.key])}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        [field.key]: field.type === 'number' ? Number(event.target.value) : event.target.value,
                      }))
                    }
                  />
                </Field>
              );
            })}
          </div>
          <p className="text-sm text-muted">
            Settings that are not listed remain at their server defaults. Sensitive values such as secrets and database
            credentials are configured through environment variables and are never editable here.
          </p>
        </Card>
      ) : isPlatformAdmin ? (
        <Card title="Platform administration">
          <Alert tone="info" title="Institution settings are managed per institution">
            Sign in as an institution administrator to configure defaults for that institution, or create accounts for an
            institution from the Institutions page.
          </Alert>
          <DataTable
            rows={[]}
            rowKey={() => 'none'}
            empty={<p>Platform-wide configuration is read-only in this interface by design.</p>}
            columns={[{ key: 'none', header: 'No editable platform settings' }]}
          />
        </Card>
      ) : null}

      {settings.error ? (
        <Alert tone="warning" title="Settings unavailable">
          Your account can view system status but does not have permission to read institution settings.
        </Alert>
      ) : null}

      <Card title="Data protection notes" flush>
        <ul className="notes-list">
          <li>Passwords are hashed with bcrypt; reset and session tokens are stored only as hashes.</li>
          <li>All examination timing decisions are made on the server, and submissions are locked once recorded.</li>
          <li>Every privileged action is written to the audit log with actor, address and metadata.</li>
          <li>Demonstration data is clearly labelled and never mixed with production statistics.</li>
        </ul>
      </Card>
    </div>
  );
}
