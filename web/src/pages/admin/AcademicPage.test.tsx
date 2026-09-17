/**
 * Groups are referenced by examination assignments, so removing one is destructive and
 * must be confirmed before the request is sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AcademicPage from './AcademicPage';
import { ToastProvider } from '../../components/ui';

const GROUP_ID = 5;

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 2, fullName: 'Dr. Amelia Hart', role: 'institution_admin', roleName: 'Institution Administrator' },
    hasPermission: () => true,
    unreadNotifications: 0,
    logout: async () => undefined,
    refresh: async () => undefined,
  }),
}));

const group = {
  id: GROUP_ID,
  institution_id: 1,
  class_id: 3,
  name: 'Algorithms Clinic',
  description: 'Weekly problem clinic',
  member_count: 5,
  created_at: '2026-09-01T08:00:00.000Z',
  updated_at: '2026-09-01T08:00:00.000Z',
};

interface Call {
  url: string;
  method: string;
}

function installFetch() {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const list = (rows: unknown[]) =>
      new Response(JSON.stringify({ data: rows, meta: { page: 1, pageSize: 200, total: rows.length, totalPages: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const respond = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (url.includes('/api/groups/') && method === 'DELETE') return respond({ data: { message: 'Group removed.' } });
    if (url.includes('/api/groups')) return list([group]);
    if (url.includes('/api/classes')) return list([{ id: 3, name: 'CS-201', code: 'CS201', academic_year: '2026' }]);
    if (url.includes('/api/departments')) return list([]);
    if (url.includes('/api/teachers')) return list([]);
    return list([]);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('group removal', () => {
  it('confirms before deleting and mentions the membership that goes with it', async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter>
            <AcademicPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('tab', { name: 'Groups' }));
    expect(await screen.findByText('Algorithms Clinic')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove Algorithms Clinic')).toBeTruthy();
    expect(within(dialog).getByText(/5 membership record/)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove group' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1));
    expect(calls.find((call) => call.method === 'DELETE')?.url).toContain(`/api/groups/${GROUP_ID}`);
  });
});
