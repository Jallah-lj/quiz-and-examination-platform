import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from './api';

/** Debounces fast-changing input (search boxes) so the API is not hammered. */
export function useDebouncedValue<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Small state container for list screens: debounced search text plus arbitrary filters,
 * always resetting pagination when a filter changes.
 */
export function useListState<TFilters extends Record<string, string>>(initial: TFilters, initialPageSize = 20) {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<TFilters>(initial);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const debouncedSearch = useDebouncedValue(search);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, pageSize]);

  const updateFilter = useCallback((key: keyof TFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  }, []);

  const resetFilters = useCallback(() => {
    setFilters(initial);
    setSearch('');
    setPage(1);
    // `initial` is a literal per screen; intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const query = useMemo(
    () => ({ ...filters, q: debouncedSearch, page, pageSize }),
    [filters, debouncedSearch, page, pageSize],
  );

  return {
    search,
    setSearch,
    filters,
    updateFilter,
    resetFilters,
    page,
    setPage,
    pageSize,
    setPageSize,
    query,
  };
}

/** Human-readable message for any thrown error, never leaking internals. */
export function errorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * Server clock: the server is the single source of truth for examination timing.
 * We keep an offset between the browser clock and the server clock and re-sync it
 * on every heartbeat so a wrong client clock cannot shorten an attempt.
 */
export function useServerClock() {
  const offsetRef = useRef(0);
  const [, forceTick] = useState(0);

  const sync = useCallback((serverTime: string) => {
    const server = new Date(serverTime).getTime();
    if (!Number.isNaN(server)) offsetRef.current = server - Date.now();
  }, []);

  const now = useCallback(() => Date.now() + offsetRef.current, []);
  const offsetMs = offsetRef.current;

  const tick = useCallback(() => forceTick((value) => value + 1), []);

  return { sync, now, tick, offsetMs };
}

/** Ticks every second while `active`; used by the examination countdown. */
export function useInterval(callback: () => void, delayMs: number | null) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (delayMs === null) return;
    const id = window.setInterval(() => saved.current(), delayMs);
    return () => window.clearInterval(id);
  }, [delayMs]);
}

/** Locks body scroll while a modal/sheet is open. */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener('change', listener);
    return () => list.removeEventListener('change', listener);
  }, [query]);
  return matches;
}
