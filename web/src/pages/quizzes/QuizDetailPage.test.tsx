/**
 * The assignment "Remove" action is destructive, so it must ask first and must only
 * reach the API after the administrator confirms.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import QuizDetailPage from './QuizDetailPage';
import { ToastProvider } from '../../components/ui';

const QUIZ_ID = 9;
const ASSIGNMENT_ID = 31;

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 4, fullName: 'Ama Boateng', role: 'teacher', roleName: 'Teacher' },
    hasPermission: () => true,
    unreadNotifications: 0,
    logout: async () => undefined,
    refresh: async () => undefined,
  }),
}));

const detail = {
  quiz: {
    id: QUIZ_ID,
    title: 'Week 4 recap quiz',
    status: 'ACTIVE',
    subject_name: 'Data Structures',
    class_name: 'CS-201',
    created_by_name: 'Ama Boateng',
    instructions: 'Answer every question.',
    time_limit_minutes: 20,
    max_attempts: 1,
    pass_percentage: 50,
    available_from: '2026-09-01T08:00:00.000Z',
    available_until: '2026-09-30T08:00:00.000Z',
  },
  questions: [
    {
      id: 26,
      text: 'Which structure offers O(1) average lookup?',
      type: 'MCQ',
      topic: null,
      difficulty: 'EASY',
      marks: 5,
      negative_marks: 0,
      position: 1,
      option_count: 4,
    },
  ],
  assignments: [
    {
      id: ASSIGNMENT_ID,
      class_id: 1,
      group_id: null,
      student_id: null,
      assigned_at: '2026-09-02T09:00:00.000Z',
      class_name: 'CS-201',
      group_name: null,
      student_name: null,
      student_code: null,
    },
  ],
  stats: { attempts: 0, in_progress: 0, awaiting_grading: 0, average_percentage: 0 },
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
    const respond = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith(`/api/quizzes/${QUIZ_ID}/assignments/${ASSIGNMENT_ID}`) && method === 'DELETE') {
      return respond({ data: { message: 'Assignment removed.' } });
    }
    if (url.endsWith(`/api/quizzes/${QUIZ_ID}/attempts`)) return respond({ data: [] });
    if (url.endsWith(`/api/quizzes/${QUIZ_ID}`)) return respond({ data: detail });
    return respond({ data: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/quizzes/${QUIZ_ID}`]}>
          <Routes>
            <Route path="/quizzes/:quizId" element={<QuizDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('quiz assignment removal', () => {
  it('asks for confirmation before calling the API', async () => {
    const calls = installFetch();
    const user = userEvent.setup();
    renderPage();

    const removeButton = await screen.findByRole('button', { name: 'Remove' });
    await user.click(removeButton);

    // No request yet — only a dialog explaining what will happen.
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove this assignment')).toBeTruthy();
    expect(
      within(dialog).getByText(/candidates in CS-201 will no longer see this quiz/i),
    ).toBeTruthy();

    // Cancelling leaves everything alone.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);

    // Confirming issues exactly one delete for that assignment.
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove assignment' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1));
    expect(calls.find((call) => call.method === 'DELETE')?.url).toContain(
      `/api/quizzes/${QUIZ_ID}/assignments/${ASSIGNMENT_ID}`,
    );
  });
});
