/**
 * Candidate registrations arrive as `pending` accounts and cannot sign in until an
 * administrator approves them. The approval is the point of the screen for those rows, so it
 * is tested from the list to the request: the details the candidate supplied are shown before
 * the decision, nothing is sent until the dialog is confirmed, and accounts that are not
 * waiting for approval never offer the action.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import UsersPage from './UsersPage';
import { ToastProvider } from '../../components/ui';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 2, fullName: 'Dr. Amelia Hart', role: 'institution_admin', roleName: 'Institution Administrator' },
    hasPermission: () => true,
    unreadNotifications: 0,
    logout: async () => undefined,
    refresh: async () => undefined,
  }),
}));

const PENDING_ID = 41;
const ACTIVE_ID = 42;

const pendingCandidate = {
  id: PENDING_ID,
  full_name: 'Aline Uwase',
  email: 'aline.uwase@northgate.edu',
  status: 'pending',
  phone: '+250 788 123 456',
  date_of_birth: '2006-04-17',
  gender: 'female',
  student_code: 'REG-00041',
  last_login_at: null,
  created_at: '2026-09-18T09:15:00.000Z',
  institution_id: 2,
  email_verified_at: null,
  role: 'student',
  role_name: 'Student / Candidate',
  institution_name: 'Northgate Institute of Technology',
  locked: 0,
};

const activeAccount = {
  ...pendingCandidate,
  id: ACTIVE_ID,
  full_name: 'Bob Mensah',
  email: 'bob.mensah@northgate.edu',
  status: 'active',
  date_of_birth: null,
  gender: null,
  student_code: 'NIT-2025-0001',
  email_verified_at: '2026-09-01T10:00:00.000Z',
};

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function installFetch() {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (/\/api\/users\/\d+\/approve$/.test(url) && method === 'POST') {
      return respond({ data: { message: 'Aline Uwase can now sign in.', userId: PENDING_ID } });
    }
    if (/\/api\/users\/\d+\/status$/.test(url) && method === 'POST') {
      return respond({ data: { message: 'Account status updated to disabled.' } });
    }
    if (url.includes('/api/users') && method === 'GET') {
      const rows = [pendingCandidate, activeAccount];
      return respond({ data: rows, meta: { page: 1, pageSize: 20, total: rows.length, totalPages: 1 } });
    }
    return respond({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 1 } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <UsersPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const approvals = (calls: Call[]) => calls.filter((call) => call.url.endsWith('/approve'));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('approving a candidate registration', () => {
  it('offers the decision only on the account that is waiting for it', async () => {
    installFetch();
    renderPage();

    expect(await screen.findByText('Aline Uwase')).toBeTruthy();
    // One pending candidate, one approval button — not one per row.
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Decline' })).toHaveLength(1);
    // The approved account keeps the ordinary status control.
    expect(screen.getAllByRole('button', { name: 'Status' })).toHaveLength(1);
  });

  it('shows what the candidate submitted, and sends nothing until it is confirmed', async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Aline Uwase');
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Approve Aline Uwase?')).toBeTruthy();
    expect(within(dialog).getByText('+250 788 123 456')).toBeTruthy();
    expect(within(dialog).getByText('2006-04-17')).toBeTruthy();
    expect(within(dialog).getByText('Female')).toBeTruthy();
    expect(within(dialog).getByText('REG-00041')).toBeTruthy();
    expect(within(dialog).getByText(/has not confirmed their email address/)).toBeTruthy();
    // Opening the dialog is not a decision.
    expect(approvals(calls)).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(approvals(calls)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const confirmed = await screen.findByRole('dialog');
    await user.click(within(confirmed).getByRole('button', { name: 'Approve registration' }));

    await waitFor(() => expect(approvals(calls)).toHaveLength(1));
    expect(approvals(calls)[0].url).toContain(`/api/users/${PENDING_ID}/approve`);
    expect(await screen.findByText('Aline Uwase can now sign in.')).toBeTruthy();
  });

  it('declines through the status endpoint, keeping the record instead of deleting it', async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Aline Uwase');
    await user.click(screen.getByRole('button', { name: 'Decline' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Decline Aline Uwase?')).toBeTruthy();
    expect(within(dialog).getByText(/audit trail are kept/)).toBeTruthy();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Decline registration' }));

    await waitFor(() => expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const declined = calls.find((call) => call.method === 'POST');
    expect(declined?.url).toContain(`/api/users/${PENDING_ID}/status`);
    expect(declined?.body).toEqual({ status: 'disabled' });
    // A disabled account is not deleted: no DELETE is ever issued from this screen.
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
});
