import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { Alert, Button, TextInput, useToast } from '../../components/ui';
import { IconShield } from '../../components/Icons';

type View = 'login' | 'register' | 'forgot' | 'reset' | 'verify';

export default function AuthPages({ initialView }: { initialView: View }) {
  const [view, setView] = useState<View>(initialView);
  useEffect(() => setView(initialView), [initialView]);

  return (
    <div className="auth-layout">
      <div className="auth-aside">
        <div className="auth-aside__brand">
          <span className="brand-mark" aria-hidden="true">
            ES
          </span>
          <div>
            <strong>ExamSys</strong>
            <small>Examination &amp; assessment management</small>
          </div>
        </div>
        <h1>Run examinations with confidence</h1>
        <ul className="auth-aside__list">
          <li>Server-authoritative timers and automatic submission.</li>
          <li>Question banks, randomised papers and negative marking.</li>
          <li>Deterministic auto-grading with manual review where it matters.</li>
          <li>Institution-level data isolation and a complete audit trail.</li>
        </ul>
        <p className="auth-aside__note">
          <IconShield size={15} /> Sessions are server-validated. Every sensitive action is authorised on the server and
          written to the audit log.
        </p>
      </div>

      <div className="auth-panel">
        <div className="auth-panel__inner">
          {view === 'login' ? <LoginForm /> : null}
          {view === 'register' ? <RegisterForm /> : null}
          {view === 'forgot' ? <ForgotForm /> : null}
          {view === 'reset' ? <ResetForm /> : null}
          {view === 'verify' ? <VerifyForm /> : null}
          <AuthFooter view={view} />
        </div>
      </div>
    </div>
  );
}

function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth-card">
      <h2>{title}</h2>
      {subtitle ? <p className="auth-card__subtitle">{subtitle}</p> : null}
      {children}
      {footer ? <div className="auth-card__footer">{footer}</div> : null}
    </div>
  );
}

function LoginForm() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(redirectTarget(location.state) ?? '/dashboard', { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        setLocked(true);
        setError(caught.message);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Sign-in failed. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in" subtitle="Use the account issued by your institution.">
      <form onSubmit={submit} noValidate>
        {error ? (
          <Alert tone={locked ? 'warning' : 'danger'} title={locked ? 'Too many attempts' : 'Sign-in failed'}>
            {error}
          </Alert>
        ) : null}
        <TextInput
          label="Email address"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextInput
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" variant="primary" loading={busy} className="btn--block">
          Sign in
        </Button>
        <div className="auth-links">
          <Link to="/forgot-password">Forgot your password?</Link>
          <Link to="/register">Register as a candidate</Link>
        </div>
      </form>
    </AuthCard>
  );
}

function RegisterForm() {
  const toast = useToast();
  const [form, setForm] = useState({ fullName: '', email: '', password: '', confirm: '', institutionId: '', studentCode: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const { data: institutions } = useQuery({
    queryKey: ['public-institutions'],
    queryFn: () => api.get<{ id: number; name: string; code: string; country: string | null }[]>('/auth/public-institutions'),
  });

  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (form.password.length < 10) nextErrors.password = 'Use at least 10 characters.';
    if (form.password !== form.confirm) nextErrors.confirm = 'The passwords do not match.';
    if (!form.institutionId) nextErrors.institutionId = 'Select your institution.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setBusy(true);
    try {
      const response = await api.post<{ message: string }>('/auth/register', {
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        password: form.password,
        institutionId: Number(form.institutionId),
        studentCode: form.studentCode.trim() || undefined,
      });
      setDone(response.message);
      toast.notify('Registration submitted.', 'success');
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors(caught.fieldErrors());
        if (!Object.keys(caught.fieldErrors()).length) setErrors({ form: caught.message });
      }
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthCard title="Registration received" subtitle="Your account is awaiting activation.">
        <Alert tone="success">{done}</Alert>
        <Link className="btn btn--primary btn--block" to="/login">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Candidate registration" subtitle="An administrator activates new accounts before first sign-in.">
      <form onSubmit={submit} noValidate>
        {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}
        <TextInput
          label="Full name"
          required
          value={form.fullName}
          error={errors.fullName}
          onChange={(event) => update('fullName', event.target.value)}
        />
        <TextInput
          label="Email address"
          type="email"
          required
          autoComplete="email"
          value={form.email}
          error={errors.email}
          onChange={(event) => update('email', event.target.value)}
        />
        <div className="field-row">
          <TextInput
            label="Password"
            type="password"
            required
            autoComplete="new-password"
            hint="At least 10 characters."
            value={form.password}
            error={errors.password}
            onChange={(event) => update('password', event.target.value)}
          />
          <TextInput
            label="Confirm password"
            type="password"
            required
            autoComplete="new-password"
            value={form.confirm}
            error={errors.confirm}
            onChange={(event) => update('confirm', event.target.value)}
          />
        </div>
        <div className="field-row">
          <div className="field field--required">
            <label htmlFor="register-institution">Institution</label>
            <select
              id="register-institution"
              className="select"
              value={form.institutionId}
              onChange={(event) => update('institutionId', event.target.value)}
              aria-invalid={errors.institutionId ? 'true' : undefined}
            >
              <option value="">Select your institution</option>
              {(institutions ?? []).map((institution) => (
                <option key={institution.id} value={institution.id}>
                  {institution.name}
                </option>
              ))}
            </select>
            {errors.institutionId ? <span className="field__error">{errors.institutionId}</span> : null}
          </div>
          <TextInput
            label="Matriculation / candidate number"
            hint="Optional — helps the registry match your record."
            value={form.studentCode}
            error={errors.studentCode}
            onChange={(event) => update('studentCode', event.target.value)}
          />
        </div>
        <Button type="submit" variant="primary" loading={busy} className="btn--block">
          Create account
        </Button>
        <div className="auth-links">
          <Link to="/login">Already registered? Sign in</Link>
        </div>
      </form>
    </AuthCard>
  );
}

function ForgotForm() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [token, setToken] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await api.post<{ message: string; resetToken?: string }>('/auth/forgot-password', {
        email: email.trim(),
      });
      setMessage(response.message);
      setToken(response.resetToken ?? null);
    } catch (caught) {
      setMessage(caught instanceof ApiError ? caught.message : 'The request could not be processed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Reset your password" subtitle="We generate a single-use reset link that expires shortly.">
      <form onSubmit={submit} noValidate>
        {message ? <Alert tone="info">{message}</Alert> : null}
        <TextInput
          label="Email address"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button type="submit" variant="primary" loading={busy} className="btn--block">
          Request reset link
        </Button>
        {token ? (
          <Alert tone="warning" title="Development environment">
            Mail delivery is not configured, so the reset link is shown here:{' '}
            <Link to={`/reset-password?token=${encodeURIComponent(token)}`}>open reset link</Link>.
          </Alert>
        ) : null}
        <div className="auth-links">
          <Link to="/login">Back to sign in</Link>
        </div>
      </form>
    </AuthCard>
  );
}

function ResetForm() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 10) {
      setError('Use at least 10 characters.');
      return;
    }
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      toast.notify('Password updated. You can sign in now.', 'success');
      navigate('/login', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The reset link could not be used.');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthCard title="Reset link missing">
        <Alert tone="warning">
          This page needs a reset token. Request a new link from the <Link to="/forgot-password">password reset page</Link>.
        </Alert>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={submit} noValidate>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextInput
          label="New password"
          type="password"
          required
          hint="At least 10 characters."
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <TextInput
          label="Confirm new password"
          type="password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <Button type="submit" variant="primary" loading={busy} className="btn--block">
          Update password
        </Button>
      </form>
    </AuthCard>
  );
}

function VerifyForm() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token || state !== 'idle') return;
    setState('busy');
    api
      .post<{ message: string }>('/auth/verify-email', { token })
      .then((response) => {
        setMessage(response.message);
        setState('done');
      })
      .catch((caught) => {
        setMessage(caught instanceof ApiError ? caught.message : 'The verification link is not valid.');
        setState('error');
      });
  }, [token, state]);

  return (
    <AuthCard title="Email verification">
      {state === 'busy' || state === 'idle' ? (
        <Alert tone="info">Verifying your address…</Alert>
      ) : state === 'done' ? (
        <Alert tone="success">{message}</Alert>
      ) : (
        <Alert tone="danger">{message}</Alert>
      )}
      <Link className="btn btn--primary btn--block" to="/login">
        Continue to sign in
      </Link>
    </AuthCard>
  );
}

function AuthFooter({ view }: { view: View }) {
  const note = useMemo(() => {
    switch (view) {
      case 'login':
        return 'Accounts are locked temporarily after repeated failed sign-in attempts.';
      case 'register':
        return 'Registration requests are reviewed by your institution administrator.';
      case 'forgot':
        return 'Reset links are single-use and expire automatically.';
      case 'reset':
        return 'Choose a password you have not used before.';
      default:
        return 'Verification links expire automatically for your security.';
    }
  }, [view]);
  return <p className="auth-note">{note}</p>;
}

/** Preserves the page the user was trying to reach before being sent to sign-in. */
function redirectTarget(state: unknown): string | null {
  if (state && typeof state === 'object' && 'from' in state) {
    const from = (state as { from?: unknown }).from;
    if (typeof from === 'string' && from.startsWith('/')) return from;
  }
  return null;
}
