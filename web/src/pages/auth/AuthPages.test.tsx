/**
 * End-to-end sign-in flow at the DOM level: the real form, the real auth context and the
 * real API client, with a stubbed transport. It guards the failure mode where sign-in is
 * accepted but no usable session reaches the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AuthPages from './AuthPages';
import { AuthProvider } from '../../context/AuthContext';
import { clearSessionToken, getSessionToken, readCsrfToken } from '../../lib/api';
import { ToastProvider } from '../../components/ui';

const ADMIN = {
  id: 2,
  fullName: 'Dr. Amelia Hart',
  email: 'demo.admin@northgate.edu',
  role: 'institution_admin',
  roleName: 'Institution Administrator',
  institutionId: 2,
  permissions: ['user.view', 'exam.view'],
};

interface Call {
  url: string;
  method: string;
  authorization?: string;
  csrf?: string;
}

function installTransport(
  options: { authenticated?: boolean; sessionToken?: string | null; loginStatus?: number } = {},
) {
  const calls: Call[] = [];
  const authenticated = options.authenticated ?? true;
  const sessionToken = options.sessionToken === undefined ? 'session-token-from-login' : options.sessionToken;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, authorization: headers.Authorization, csrf: headers['X-CSRF-Token'] });

    const respond = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (url.endsWith('/api/auth/login')) {
      if (options.loginStatus && options.loginStatus !== 200) {
        return respond({ error: { code: 'UNAUTHENTICATED', message: 'Incorrect email or password.' } }, options.loginStatus);
      }
      return respond({
        data: {
          user: ADMIN,
          csrfToken: 'csrf-from-login',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          ...(sessionToken ? { sessionToken, tokenTransport: 'bearer' } : {}),
        },
      });
    }
    if (url.endsWith('/api/auth/me')) {
      return respond({
        data: authenticated
          ? { authenticated: true, csrfToken: 'csrf-from-login', unreadNotifications: 0, user: ADMIN }
          : { authenticated: false, csrfToken: null, user: null },
      });
    }
    return respond({ data: {} });
  });

  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderLogin() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/login']}>
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<AuthPages initialView="login" />} />
              <Route path="/dashboard" element={<h1>Institution dashboard</h1>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('sign-in flow', () => {
  beforeEach(() => {
    // Clears the session-storage copy and the in-memory mirror together.
    clearSessionToken();
    document.cookie = 'examsys_session_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSessionToken();
  });

  it('signs in, keeps only the returned session, and reaches the dashboard', async () => {
    const user = userEvent.setup();
    const calls = installTransport();
    renderLogin();

    await user.type(screen.getByLabelText(/email address/i), 'demo.admin@northgate.edu');
    await user.type(screen.getByLabelText(/^password/i), 'Demo-Password1');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    expect(await screen.findByRole('heading', { name: /institution dashboard/i })).toBeInTheDocument();

    // The session issued by the server is what is kept — nothing is fabricated client-side.
    expect(getSessionToken()).toBe('session-token-from-login');

    // The confirmation call proves the session works before the user is let in, and it
    // carries the token as a bearer header so a cookie-blocked browser still works.
    // The bootstrap query runs before sign-in; the confirmation call is the latest one.
    const meCalls = calls.filter((call) => call.url.endsWith('/api/auth/me'));
    expect(meCalls.length).toBeGreaterThanOrEqual(2);
    expect(meCalls.at(-1)?.authorization).toBe('Bearer session-token-from-login');
  });

  it('uses the readable CSRF cookie as the fallback when the cookie is present', async () => {
    const user = userEvent.setup();
    document.cookie = 'examsys_session_csrf=csrf-from-cookie; path=/';
    installTransport({ sessionToken: null });
    renderLogin();

    await user.type(screen.getByLabelText(/email address/i), 'demo.admin@northgate.edu');
    await user.type(screen.getByLabelText(/^password/i), 'Demo-Password1');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    await screen.findByRole('heading', { name: /institution dashboard/i });
    // With the cookie transport in play no token is stored, and CSRF comes from the cookie.
    expect(getSessionToken()).toBe('');
    expect(readCsrfToken()).toBe('csrf-from-cookie');
  });

  it('refuses to continue when the session cannot be confirmed, and says why', async () => {
    const user = userEvent.setup();
    installTransport({ authenticated: false });
    renderLogin();

    await user.type(screen.getByLabelText(/email address/i), 'demo.admin@northgate.edu');
    await user.type(screen.getByLabelText(/^password/i), 'Demo-Password1');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    // Never enters the application on an unverifiable session...
    expect(screen.queryByRole('heading', { name: /institution dashboard/i })).not.toBeInTheDocument();
    // ...and the discarded token is not retried forever.
    expect(getSessionToken()).toBe('');
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not accept the session/i);
  });

  it('reports invalid credentials without leaking whether the account exists', async () => {
    const user = userEvent.setup();
    installTransport({ loginStatus: 401 });
    renderLogin();

    await user.type(screen.getByLabelText(/email address/i), 'ghost@nowhere.test');
    await user.type(screen.getByLabelText(/^password/i), 'Wrong-Password9');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/incorrect email or password/i);
    expect(alert.textContent).not.toMatch(/not found|no such user|unknown email/i);
    await waitFor(() => expect(getSessionToken()).toBe(''));
  });
});
