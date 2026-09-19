import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// --- jsdom gaps that the application code legitimately relies on -------------

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

if (!window.scrollTo) {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

if (!window.navigator.clipboard) {
  // `configurable` lets @testing-library/user-event install its own clipboard stub.
  Object.defineProperty(window.navigator, 'clipboard', {
    writable: true,
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
}

// --- fetch + CSRF cookie stubs ----------------------------------------------
// The API client reads the CSRF cookie and sends it back on unsafe requests. Tests
// replace `fetch` per-suite but keep the cookie helper working by default.

export const CSRF_COOKIE = 'examsys_session_csrf';

export function setCsrfCookie(token = 'test-csrf-token'): void {
  document.cookie = `${CSRF_COOKIE}=${token}; path=/`;
}

beforeEach(() => {
  setCsrfCookie();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Clear cookies between tests so a suite cannot leak authentication state.
  document.cookie.split(';').forEach((entry) => {
    const name = entry.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
});
