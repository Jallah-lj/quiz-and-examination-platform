/**
 * Question banks store their status in lower case ("active"), while the status badge maps
 * the documented upper-case states. Passing the raw value through a ternary produced the
 * literal "ACTIVE_STATUS", which matched nothing and rendered a grey "Active status" cell.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import QuestionBanksPage from './QuestionBanksPage';
import { ToastProvider } from '../../components/ui';

function installFetch(banks: unknown[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const list = (rows: unknown[]) =>
      new Response(JSON.stringify({ data: rows, meta: { page: 1, pageSize: 100, total: rows.length, totalPages: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/api/question-banks')) return list(banks);
    return list([]);
  });
  vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('question bank status', () => {
  it('renders the active state as a success badge, not an unmapped literal', async () => {
    installFetch([
      {
        id: 1,
        institution_id: 2,
        subject_id: 1,
        name: 'Data Structures — Core Bank',
        description: null,
        created_by: 2,
        status: 'active',
        created_at: '2026-09-01T08:00:00.000Z',
        updated_at: '2026-09-01T08:00:00.000Z',
        subject_name: 'Data Structures',
        subject_code: 'CS201',
        active_questions: 12,
        total_questions: 12,
      },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter>
            <QuestionBanksPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    const row = (await screen.findByText('Data Structures — Core Bank')).closest('tr')!;
    const badge = within(row).getByText('Active');
    expect(badge).toBeTruthy();
    // The state is carried by the documented tone, and reads as one word.
    expect(badge.getAttribute('class')).toContain('badge--success');
    expect(within(row).queryByText('Active status')).toBeNull();
  });

  it('maps an archived bank to its own state', async () => {
    installFetch([
      {
        id: 2,
        institution_id: 2,
        subject_id: 1,
        name: 'Retired bank',
        description: null,
        created_by: 2,
        status: 'archived',
        created_at: '2026-09-01T08:00:00.000Z',
        updated_at: '2026-09-01T08:00:00.000Z',
        subject_name: 'Data Structures',
        active_questions: 0,
        total_questions: 4,
      },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter>
            <QuestionBanksPage />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );

    const row = (await screen.findByText('Retired bank')).closest('tr')!;
    const badge = within(row).getByText('Archived');
    expect(badge.getAttribute('class')).toContain('badge--outline');
  });
});
