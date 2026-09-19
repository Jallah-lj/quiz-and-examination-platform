/**
 * Appearance (light / dark / system).
 *
 * The chosen preference is stored locally and applied to the document root as
 * `data-theme`, which is what every colour token in styles/app.css keys off. "system"
 * follows the operating-system preference and keeps following it while the app is open.
 *
 * index.html applies the same rule before the first paint, so a reload never flashes the
 * wrong palette; this module keeps the running app in sync afterwards.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'examsys.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Stored preference, falling back to "system" when nothing valid is stored. */
export function readStoredPreference(storage: Pick<Storage, 'getItem'> | null | undefined): ThemePreference {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    // Storage can be blocked in embedded browsers; the default still works.
    return 'system';
  }
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference, prefersDark = systemPrefersDark()): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Flips to the opposite of what is currently on screen. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  // Keeps native controls, scrollbars and form widgets in the matching palette.
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readStoredPreference(typeof window === 'undefined' ? null : window.localStorage),
  );
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());

  const resolved = resolveTheme(preference, prefersDark);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Follow the operating-system preference while the app is open.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DARK_QUERY);
    const handler = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    setPrefersDark(query.matches);
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handler);
      return () => query.removeEventListener('change', handler);
    }
    // Safari prior to 14 only offers the deprecated listener API.
    query.addListener?.(handler);
    return () => query.removeListener?.(handler);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; the session still switches immediately.
    }
  }, []);

  const toggle = useCallback(() => {
    setPreference(resolveTheme(preference, systemPrefersDark()) === 'dark' ? 'light' : 'dark');
  }, [preference, setPreference]);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, toggle }),
    [preference, resolved, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside a ThemeProvider');
  return context;
}
