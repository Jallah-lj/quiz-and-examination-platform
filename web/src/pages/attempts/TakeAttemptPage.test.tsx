import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TakeAttemptPage from './TakeAttemptPage';
import { ToastProvider } from '../../components/ui';
import type { AttemptPaper } from '../../types';

const ATTEMPT_ID = 7;

function paper(overrides: Partial<AttemptPaper> = {}): AttemptPaper {
  const base = {
    attempt: {
      id: ATTEMPT_ID,
      attemptNo: 1,
      status: 'IN_PROGRESS',
      startedAt: '2026-09-17T10:00:00.000Z',
      expiresAt: '2026-09-17T10:30:00.000Z',
      submittedAt: null,
      submitReason: null,
      maxMarks: 6,
      examId: 3,
      quizId: null,
      title: 'Midterm Examination — Data Structures',
      code: 'CS201-MID',
      instructions: 'Answer all questions.',
      durationMinutes: 30,
      totalMarks: 6,
      passMarks: 3,
      allowReview: true,
      showCorrectAnswers: true,
      institutionName: 'Northgate Institute of Technology',
      integrityFlags: [],
      studentName: 'Sofia Mensah',
      studentCode: 'NIT-2025-0019',
    },
    serverTime: '2026-09-17T10:00:00.000Z',
    remainingSeconds: 900,
    graceSeconds: 5,
    questions: [
      {
        questionId: 26,
        position: 1,
        type: 'MCQ' as const,
        text: 'Which structure offers O(1) average lookup?',
        marks: 2,
        negativeMarks: 0.5,
        objective: true,
        options: [
          { label: 'A', text: 'Linked list' },
          { label: 'B', text: 'Hash table' },
        ],
        answerConfig: {},
      },
      {
        questionId: 27,
        position: 2,
        type: 'TRUE_FALSE' as const,
        text: 'A stack is FIFO.',
        marks: 1,
        negativeMarks: 0,
        objective: true,
        options: [
          { label: 'A', text: 'True' },
          { label: 'B', text: 'False' },
        ],
        answerConfig: {},
      },
      {
        questionId: 28,
        position: 3,
        type: 'ESSAY' as const,
        text: 'Explain amortised analysis.',
        marks: 3,
        negativeMarks: 0,
        objective: false,
        options: [],
        answerConfig: {},
      },
    ],
    answers: {},
    progress: { answered: 0, unanswered: 3, flagged: 0, total: 3 },
  };
  return { ...base, ...overrides } as unknown as AttemptPaper;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function installFetch(mockPaper: AttemptPaper, submitResult?: unknown) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method, body });

    const respond = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (url.endsWith(`/api/attempts/${ATTEMPT_ID}`) && method === 'GET') {
      return respond({ data: mockPaper });
    }
    if (url.includes(`/api/attempts/${ATTEMPT_ID}/answers/`)) {
      return respond({ data: { saved: true, serverTime: mockPaper.serverTime, remainingSeconds: 890 } });
    }
    if (url.endsWith(`/api/attempts/${ATTEMPT_ID}/heartbeat`)) {
      return respond({ data: { serverTime: mockPaper.serverTime, remainingSeconds: 890, status: 'IN_PROGRESS' } });
    }
    if (url.endsWith(`/api/attempts/${ATTEMPT_ID}/events`)) {
      return new Response(null, { status: 204 });
    }
    if (url.endsWith(`/api/attempts/${ATTEMPT_ID}/submit`)) {
      return respond({
        data:
          submitResult ?? {
            attemptId: ATTEMPT_ID,
            status: 'GRADED',
            objectiveMarks: 2,
            subjectiveMarks: 0,
            totalObtained: 2,
            maxMarks: 6,
            percentage: 33.33,
            grade: 'F',
            outcome: 'FAILED',
            requiresManualGrading: false,
            resultId: 12,
            resultPublished: false,
          },
      });
    }
    return respond({ error: { code: 'NOT_FOUND', message: `No handler for ${method} ${url}` } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/attempts/${ATTEMPT_ID}/take`]}>
          <Routes>
            <Route path="/attempts/:attemptId/take" element={<TakeAttemptPage />} />
            <Route path="/attempts/:attemptId/review" element={<p>Review screen</p>} />
            <Route path="/my-attempts" element={<p>My attempts</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('TakeAttemptPage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders the paper, candidate header and the first question', async () => {
    installFetch(paper());
    renderPage();

    expect(await screen.findByText(/Which structure offers O\(1\) average lookup\?/)).toBeInTheDocument();
    expect(screen.getByText(/Midterm Examination — Data Structures/)).toBeInTheDocument();
    expect(screen.getByText(/Sofia Mensah/)).toBeInTheDocument();
    // Marks and negative marking are stated in words, not only in colour.
    expect(screen.getByText(/2 marks/)).toBeInTheDocument();
    expect(screen.getByText(/−0.5 if incorrect/)).toBeInTheDocument();
  });

  it('moves between questions using the next/previous controls and the question panel', async () => {
    const user = userEvent.setup();
    installFetch(paper());
    renderPage();

    await screen.findByText(/Which structure offers/);

    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(await screen.findByText('A stack is FIFO.')).toBeInTheDocument();

    // The question panel exposes state through accessible labels, not colour alone.
    const panel = screen.getByRole('complementary', { name: /question navigation/i });
    await user.click(within(panel).getByRole('button', { name: /question 1,/i }));
    expect(await screen.findByText(/Which structure offers/)).toBeInTheDocument();
  });

  it('persists an answer to the server after the autosave debounce and reflects the saved state', async () => {
    const user = userEvent.setup();
    const calls = installFetch(paper());
    renderPage();

    await screen.findByText(/Which structure offers/);
    await user.click(screen.getByRole('radio', { name: /Hash table/i }));

    await waitFor(
      () => {
        const saved = calls.find((call) => call.method === 'PATCH' && call.url.includes('/answers/26'));
        expect(saved).toBeTruthy();
        expect(saved?.body).toEqual({ selectedOptions: ['B'], answerText: null, isFlagged: false });
      },
      { timeout: 4000 },
    );

    // The interface reports persistence in words so a candidate can trust it.
    expect(await screen.findByText(/All changes saved/)).toBeInTheDocument();
  });

  it('flags a question for review and records the flag server-side', async () => {
    const user = userEvent.setup();
    const calls = installFetch(paper());
    renderPage();

    await screen.findByText(/Which structure offers/);
    await user.click(screen.getByRole('button', { name: /mark for review/i }));

    await waitFor(
      () => {
        const flagged = calls.find((call) => call.method === 'PATCH' && call.url.includes('/answers/26'));
        expect((flagged?.body as { isFlagged?: boolean } | undefined)?.isFlagged).toBe(true);
      },
      { timeout: 4000 },
    );

    const panel = screen.getByRole('complementary', { name: /question navigation/i });
    expect(within(panel).getByText(/1 flagged/i)).toBeInTheDocument();
  });

  it('submits the attempt after confirmation and shows the immutable-result screen', async () => {
    const user = userEvent.setup();
    const calls = installFetch(paper());
    renderPage();

    await screen.findByText(/Which structure offers/);
    // Both the paper footer and the navigation panel expose submit; use the paper control.
    const mainSubmit = screen
      .getAllByRole('button', { name: /^submit attempt$/i })
      .find((button) => !button.closest('aside'));
    expect(mainSubmit).toBeTruthy();
    await user.click(mainSubmit!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Submitted answers are final/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^submit attempt$/i }));

    await waitFor(
      () => {
        expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/submit'))).toBe(true);
      },
      { timeout: 4000 },
    );

    // The candidate lands on the immutable result screen rather than the paper.
    expect(await screen.findByRole('heading', { name: /attempt submitted/i })).toBeInTheDocument();
    expect(screen.getByText('Withheld until release')).toBeInTheDocument();
    expect(screen.getByText('2 / 6')).toBeInTheDocument();
  });

  it('warns the candidate when less than two minutes remain', async () => {
    const soon = paper({ remainingSeconds: 90, serverTime: new Date().toISOString() });
    const calls = installFetch(soon);
    renderPage();

    expect(await screen.findByText(/Less than two minutes remaining/i)).toBeInTheDocument();
    // The warning is informational only; the paper keeps running until the deadline.
    expect(calls.some((call) => call.url.endsWith('/submit'))).toBe(false);
  });

  it('states the remaining time in words, not only in colour, when the deadline nears', async () => {
    // "under 5 min" is the amber state; the label must say so even if colour is unavailable.
    installFetch(paper({ remainingSeconds: 90, serverTime: new Date().toISOString() }));
    renderPage();

    const timer = await screen.findByRole('timer');
    expect(within(timer).getByText(/^remaining/)).toBeInTheDocument();
    expect(within(timer).getByText('under 5 min')).toBeInTheDocument();
    expect(timer.className).toContain('exam-timer--warning');
    expect(timer).toHaveAttribute('aria-label', expect.stringContaining('under 5 min'));
  });

  it('marks the final minute as the danger state', async () => {
    installFetch(paper({ remainingSeconds: 45, serverTime: new Date().toISOString() }));
    renderPage();

    const timer = await screen.findByRole('timer');
    expect(within(timer).getByText('under 1 min')).toBeInTheDocument();
    expect(timer.className).toContain('exam-timer--danger');
    // The wording is accurate: the countdown itself is under a minute.
    expect(timer.textContent).toMatch(/00:4\d/);
  });

  it('auto-submits with the time_expired reason when the server clock reaches zero', async () => {
    const expired = paper({ remainingSeconds: 1, serverTime: new Date().toISOString() });
    const calls = installFetch(expired);
    renderPage();

    await screen.findByText(/Which structure offers/);

    await waitFor(
      () => {
        const submit = calls.find((call) => call.method === 'POST' && call.url.endsWith('/submit'));
        expect(submit).toBeTruthy();
        expect((submit?.body as { reason?: string } | undefined)?.reason).toBe('time_expired');
      },
      { timeout: 5000 },
    );
  });
});
