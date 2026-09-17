import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, THEME_STORAGE_KEY, resolveTheme, useTheme } from './ThemeContext';

/** Minimal control surface so the provider can be driven from a test. */
function Controls() {
  const { preference, resolved, setPreference, toggle } = useTheme();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="resolved">{resolved}</span>
      <button type="button" onClick={toggle}>
        Toggle
      </button>
      <button type="button" onClick={() => setPreference('light')}>
        Light
      </button>
      <button type="button" onClick={() => setPreference('dark')}>
        Dark
      </button>
      <button type="button" onClick={() => setPreference('system')}>
        System
      </button>
    </div>
  );
}

/** jsdom has no matchMedia; this stub lets the test decide the system preference. */
function installMatchMedia(prefersDark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, handler: (event: MediaQueryListEvent) => void) => listeners.add(handler),
    removeEventListener: (_: string, handler: (event: MediaQueryListEvent) => void) => listeners.delete(handler),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query),
  );
  return {
    emit(next: boolean) {
      query.matches = next;
      for (const handler of listeners) handler({ matches: next } as MediaQueryListEvent);
    },
  };
}

describe('theme preference', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts on the system palette and follows a change made while the app is open', async () => {
    const system = installMatchMedia(true);
    render(
      <ThemeProvider>
        <Controls />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('preference')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    await act(async () => {
      system.emit(false);
    });
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('honours an explicit choice and remembers it for the next visit', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Controls />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    // The system preference no longer wins once a choice is stored.
    expect(screen.getByTestId('preference')).toHaveTextContent('light');
  });

  it('restores a stored choice on mount', () => {
    installMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <Controls />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('toggles to the opposite of what is on screen, not of the stored preference', async () => {
    installMatchMedia(true);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Controls />
      </ThemeProvider>,
    );

    // Stored preference is "system" and the system is dark: the first press must give light.
    await user.click(screen.getByRole('button', { name: 'Toggle' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    await user.click(screen.getByRole('button', { name: 'Toggle' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('ignores a corrupted stored value instead of throwing', () => {
    installMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    render(
      <ThemeProvider>
        <Controls />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('preference')).toHaveTextContent('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('resolveTheme', () => {
  it('maps preferences onto the palette actually applied', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
