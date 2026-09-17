import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  api,
  authHeaders,
  buildQuery,
  clearSessionToken,
  getSessionToken,
  readCsrfToken,
  setCsrfToken,
  setSessionToken,
} from './api';
import { CSRF_COOKIE, setCsrfCookie } from '../test/setup';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('api client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setCsrfCookie('csrf-from-cookie');
    clearSessionToken();
  });

  afterEach(() => {
    clearSessionToken();
    vi.unstubAllGlobals();
  });

  it('reads the CSRF token from the readable cookie', () => {
    expect(readCsrfToken()).toBe('csrf-from-cookie');
    document.cookie = `${CSRF_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    expect(readCsrfToken()).toBe('');
  });

  it('uses the session cookie as the default transport (no Authorization header)', () => {
    expect(getSessionToken()).toBe('');
    expect(authHeaders(false)).toEqual({});
  });

  it('sends the stored session token as a bearer header when cookies are unavailable', async () => {
    // Simulates a browser that blocks the session cookie: the token from the login
    // response is kept in session storage and used for every request instead.
    setSessionToken('token-from-login-response');
    setCsrfToken('csrf-from-login-response');
    document.cookie = `${CSRF_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;

    // Both transports carry the same token: some proxies strip Authorization, so the
    // dedicated header is the fallback route to the server.
    expect(authHeaders(true)).toEqual({
      Authorization: 'Bearer token-from-login-response',
      'X-Session-Token': 'token-from-login-response',
      'X-CSRF-Token': 'csrf-from-login-response',
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { authenticated: true } }));
    await api.get('/auth/me');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-from-login-response');
    // GET requests must not carry a CSRF header.
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { saved: true } }));
    await api.patch('/attempts/4/answers/9', { selectedOptions: ['A'] });
    const patchHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(patchHeaders.Authorization).toBe('Bearer token-from-login-response');
    expect(patchHeaders['X-CSRF-Token']).toBe('csrf-from-login-response');
  });

  it('keeps the session in memory when the browser blocks session storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError: storage is blocked');
    });
    try {
      // A browser with storage blocked has no readable CSRF cookie either.
      document.cookie = `${CSRF_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
      setSessionToken('memory-only-token');
      setCsrfToken('memory-only-csrf');
      // The storage writes failed, but the session must still be usable in this tab.
      expect(getSessionToken()).toBe('memory-only-token');
      expect(readCsrfToken()).toBe('memory-only-csrf');
      expect(authHeaders(true)).toEqual({
        Authorization: 'Bearer memory-only-token',
        'X-Session-Token': 'memory-only-token',
        'X-CSRF-Token': 'memory-only-csrf',
      });
    } finally {
      setItem.mockRestore();
    }
  });

  it('falls back to the stored CSRF token when the readable cookie is gone', () => {
    document.cookie = `${CSRF_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    expect(readCsrfToken()).toBe('');
    setCsrfToken('csrf-fallback');
    expect(readCsrfToken()).toBe('csrf-fallback');
    // The cookie still wins while it is readable.
    setCsrfCookie('csrf-from-cookie');
    expect(readCsrfToken()).toBe('csrf-from-cookie');
  });

  it('drops a rejected token so the app returns to the sign-in screen', async () => {
    setSessionToken('revoked-token');
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'You must sign in to continue.' } }, { status: 401 }),
    );
    await expect(api.get('/dashboard/admin')).rejects.toBeInstanceOf(ApiError);
    expect(getSessionToken()).toBe('');
  });

  it('omits empty query values and serialises the rest', () => {
    expect(buildQuery({ page: 2, q: '', status: undefined, mine: null })).toBe('?page=2');
    expect(buildQuery({})).toBe('');
  });

  it('sends the CSRF header on unsafe requests but keeps GET clean', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    await api.get('/auth/me');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/auth/me',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
    const getHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(getHeaders['X-CSRF-Token']).toBeUndefined();

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    await api.patch('/attempts/4/answers/9', { selectedOptions: ['A'] });
    const patchInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(patchInit.method).toBe('PATCH');
    expect((patchInit.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-from-cookie');
    expect(patchInit.body).toBe(JSON.stringify({ selectedOptions: ['A'] }));
  });

  it('unwraps the single-resource envelope so screens read payloads directly', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 2, fullName: 'Dr. Amelia Hart' } }));
    const user = await api.get<{ id: number; fullName: string }>('/auth/me');
    expect(user).toEqual({ id: 2, fullName: 'Dr. Amelia Hart' });
    expect(user).not.toHaveProperty('data');
  });

  it('passes bare-array and already-unwrapped payloads through untouched', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 1 }]));
    expect(await api.get<{ id: number }[]>('/grading-schemes')).toEqual([{ id: 1 }]);

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    expect(await api.get<unknown[]>('/notifications')).toEqual([]);
  });

  it('keeps the envelope on mutations that return the new resource', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 9, status: 'GRADED' } }, { status: 201 }));
    await expect(api.post<{ id: number }>('/attempts/9/submit', { reason: 'manual' })).resolves.toEqual({
      id: 9,
      status: 'GRADED',
    });
  });

  it('returns pagination metadata unchanged', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 1 }], meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 } }),
    );
    const result = await api.list<{ id: number }>('/questions');
    expect(result.data).toHaveLength(1);
    expect(result.meta.totalPages).toBe(1);
  });

  it('normalises API errors, including field-level details', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'The submitted data is invalid.',
            details: [
              { field: 'email', message: 'Enter a valid email address.' },
              { field: 'email', message: 'Duplicate ignored.' },
              'Password must be at least 10 characters.',
            ],
          },
        },
        { status: 422 },
      ),
    );

    const error = await api.post('/students', {}).catch((caught: unknown) => caught as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe('VALIDATION_ERROR');
    expect(apiError.fieldErrors()).toEqual({ email: 'Enter a valid email address.' });
    expect(apiError.details).toHaveLength(3);
    expect(apiError.isForbidden).toBe(false);
  });

  it('maps permission failures to ApiError with their status', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' } }, { status: 403 }),
    );
    const error = (await api.get('/quizzes').catch((caught: unknown) => caught)) as ApiError;
    expect(error.isForbidden).toBe(true);
    expect(error.message).toContain('permission');
  });

  it('turns a transport failure into a friendly network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const error = (await api.get('/dashboard/student').catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.code).toBe('NETWORK');
    expect(error.message).not.toContain('Failed to fetch');
  });

  it('does not leak the raw server message on 500 responses', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'INTERNAL', message: 'Something went wrong. The request was not completed.' } }, { status: 500 }),
    );
    const error = (await api.get('/reports/catalog').catch((caught: unknown) => caught)) as ApiError;
    expect(error.status).toBe(500);
    expect(error.message).not.toMatch(/sqlite|stack|SELECT/i);
  });

  it('downloads an export using the filename from the response headers', async () => {
    const blob = new Blob(['a,b\n1,2'], { type: 'text/csv' });
    fetchMock.mockResolvedValueOnce(
      new Response(blob, {
        status: 200,
        headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="results-2026.csv"' },
      }),
    );
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await api.download('/reports/exam-statistics', { format: 'csv' }, 'fallback.csv');
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe('results-2026.csv');
  });
});
