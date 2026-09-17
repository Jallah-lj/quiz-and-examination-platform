/**
 * Single API client for the SPA.
 *
 * - requests are same-origin (`/api/...`) and always send the session cookie;
 * - the CSRF token is read from the readable cookie and echoed in a header, which the
 *   server compares against the value bound to the session;
 * - failures are normalised into ApiError so screens can render field errors, empty
 *   states and permission messages consistently.
 */

export interface ApiErrorDetail {
  field?: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetail[];

  constructor(status: number, code: string, message: string, details: ApiErrorDetail[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Maps the server's field-level details for direct use in form components. */
  fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const detail of this.details) {
      if (detail.field && !map[detail.field]) map[detail.field] = detail.message;
    }
    return map;
  }
}

const CSRF_COOKIE = 'examsys_session_csrf';
const TOKEN_STORAGE_KEY = 'examsys_session_token';
const CSRF_STORAGE_KEY = 'examsys_csrf_token';

/**
 * Session transport.
 *
 * The HttpOnly session cookie is the primary transport. Some hosting contexts (an SPA
 * rendered inside a cross-site iframe, embedded webviews, browsers that block
 * third-party cookies) cannot store that cookie, which would leave every request
 * anonymous. When the server offers the token transport (`sessionToken` in the login
 * response), we keep it in `sessionStorage` — scoped to the tab, dropped when the tab
 * closes — and send it as `Authorization: Bearer`. The cookie keeps precedence on the
 * server, so this changes nothing where cookies already work.
 */
// Mirrors of the stored values, so a browser that blocks session storage still keeps a
// working session for as long as the tab is open.
let memoryToken = '';
let memoryCsrf = '';

function readStorage(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private mode); the in-memory copy still applies.
  }
}

export function getSessionToken(): string {
  return readStorage(TOKEN_STORAGE_KEY) || memoryToken;
}

export function setSessionToken(token: string): void {
  memoryToken = token;
  writeStorage(TOKEN_STORAGE_KEY, token);
}

/** False when the browser blocks cookies/session storage entirely. */
export function isStorageAvailable(): boolean {
  try {
    window.sessionStorage.setItem('examsys_probe', '1');
    window.sessionStorage.removeItem('examsys_probe');
    return typeof document.cookie === 'string';
  } catch {
    return false;
  }
}

export function clearSessionToken(): void {
  memoryToken = '';
  memoryCsrf = '';
  writeStorage(TOKEN_STORAGE_KEY, '');
  writeStorage(CSRF_STORAGE_KEY, '');
}

export function setCsrfToken(token: string): void {
  memoryCsrf = token;
  writeStorage(CSRF_STORAGE_KEY, token);
}

export function readCsrfToken(): string {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  if (match) return decodeURIComponent(match[1]);
  // Cookie unavailable (or unreadable): fall back to the token issued at sign-in.
  return readStorage(CSRF_STORAGE_KEY) || memoryCsrf;
}

/**
 * Auth headers shared by JSON requests, uploads and file exports.
 *
 * The session token is sent in both `Authorization` and `X-Session-Token`. Some proxies —
 * sandbox and preview gateways in particular — strip `Authorization` while passing other
 * headers through; the server accepts either, so a single credential reaches it by at
 * least one route. Both are verified server-side against the database.
 */
export function authHeaders(includeCsrf: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getSessionToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-Session-Token'] = token;
  }
  if (includeCsrf) {
    const csrf = readCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  return headers;
}

export type QueryValue = string | number | boolean | null | undefined;

export function buildQuery(params: Record<string, QueryValue> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /** List endpoints keep `{ data, meta }`; single-resource calls unwrap `data`. */
  unwrap?: boolean;
  /** Extra request headers (for example the session-transport negotiation). */
  headers?: Record<string, string>;
}

/**
 * Single-resource endpoints answer with `{ data: ... }`; list endpoints answer with
 * `{ data, meta }`. Screens consume the payload of the former directly, so unwrap it
 * here instead of repeating `.data` on every screen. Endpoints that already answer
 * with a bare array/object pass through untouched.
 */
function unwrapPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : payload;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeaders(method !== 'GET'),
    ...options.headers,
  };

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`/api${path}${buildQuery(options.query)}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK', 'The server could not be reached. Check your connection and try again.');
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (response.ok) return (await response.text()) as unknown as T;
    throw new ApiError(response.status, 'INTERNAL', 'The server returned an unexpected response.');
  }

  const payload = await response.json();
  if (!response.ok) {
    // A rejected token transport is dead weight: drop it so the app returns to the
    // sign-in screen instead of looping on 401s.
    if (response.status === 401 && getSessionToken()) clearSessionToken();
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'INTERNAL',
      error.message ?? 'Something went wrong. Please try again.',
      Array.isArray(error.details)
        ? error.details.map((detail: unknown) =>
            typeof detail === 'string' ? { message: detail } : (detail as ApiErrorDetail),
          )
        : [],
    );
  }
  return (options.unwrap === false ? payload : unwrapPayload(payload)) as T;
}

export interface ListMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ListResponse<T> {
  data: T[];
  meta: ListMeta;
}

export const api = {
  get: <T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown, options?: { headers?: Record<string, string> }) =>
    request<T>(path, { method: 'POST', body, headers: options?.headers }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }),

  async list<T>(path: string, query?: Record<string, QueryValue>, signal?: AbortSignal): Promise<ListResponse<T>> {
    // Keeps the `{ data, meta }` envelope so screens can read pagination metadata.
    return request<ListResponse<T>>(path, { method: 'GET', query, signal, unwrap: false });
  },

  /** Fetches a report export and hands the file to the browser. */
  async download(path: string, query: Record<string, QueryValue>, fallbackName: string): Promise<void> {
    const response = await fetch(`/api${path}${buildQuery(query)}`, {
      credentials: 'same-origin',
      headers: { Accept: '*/*', ...authHeaders(false) },
    });
    if (!response.ok) {
      let message = 'The export could not be generated.';
      try {
        const payload = await response.json();
        message = payload?.error?.message ?? message;
      } catch {
        // keep the default message
      }
      throw new ApiError(response.status, 'EXPORT_FAILED', message);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename="?([^";]+)"?/);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = match?.[1] ?? fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
};
