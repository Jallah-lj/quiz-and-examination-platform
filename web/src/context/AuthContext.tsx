import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  clearSessionToken,
  getSessionToken,
  isStorageAvailable,
  setCsrfToken,
  setSessionToken,
} from '../lib/api';
import type { LoginResponse, MeResponse, SessionUser } from '../types';

interface AuthContextValue {
  user: SessionUser | null;
  unreadNotifications: number;
  status: 'loading' | 'authenticated' | 'anonymous';
  /** True when the server says a session exists but resolved without a user (never trust the client). */
  login: (email: string, password: string) => Promise<SessionUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  hasPermission: (...permissions: string[]) => boolean;
  hasRole: (...roles: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [unread, setUnread] = useState(0);
  const [status, setStatus] = useState<'loading' | 'authenticated' | 'anonymous'>('loading');

  const { data, error, isFetched, refetch } = useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => api.get<MeResponse>('/auth/me'),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!isFetched) return;
    if (data?.authenticated && data.user) {
      setUser(data.user);
      setUnread(data.unreadNotifications ?? 0);
      setStatus('authenticated');
    } else {
      setUser(null);
      setStatus('anonymous');
    }
  }, [data, isFetched]);

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) {
      setUser(null);
      setStatus('anonymous');
    }
  }, [error]);

  const login = useCallback(
    async (email: string, password: string) => {
      // Ask for the token transport as well: harmless where cookies work, essential
      // where the browser blocks them (embedded/iframe previews).
      const result = await api.post<LoginResponse>('/auth/login', { email, password }, {
        headers: { 'X-Session-Transport': 'bearer' },
      });
      if (result.sessionToken) setSessionToken(result.sessionToken);
      if (result.csrfToken) setCsrfToken(result.csrfToken);

      // Confirm the session is actually usable from this browser context before we let
      // the user in; otherwise every screen would fail with a generic load error.
      let me = await api.get<MeResponse>('/auth/me');
      if (!me.authenticated || !me.user) {
        // A credential left over from an earlier session (for example a token issued
        // before the database was rebuilt) can only ever shadow a fresh sign-in, never
        // help. Drop everything the client kept and confirm once more with cookie-only
        // state before reporting a failure.
        const hadToken = Boolean(getSessionToken());
        clearSessionToken();
        // Keep the CSRF value issued with this sign-in: a cookie-less client still needs it
        // for state-changing requests, and the retry below may succeed without the cookie.
        if (result.csrfToken) setCsrfToken(result.csrfToken);
        me = await api.get<MeResponse>('/auth/me');
        if (!me.authenticated || !me.user) {
          throw new ApiError(
            401,
            'SESSION_NOT_ESTABLISHED',
            me.sessionStatus === 'unresolved' || hadToken
              ? 'The server did not accept the sign-in for this browser. Please reload the page and sign in again; if it keeps happening, contact your administrator.'
              : isStorageAvailable()
                ? 'Your browser discarded the sign-in cookie and the fallback session token did not reach the server. Reload the page (hard reload) and sign in again.'
                : 'This browser blocks cookies and site storage, which are required to keep you signed in. Enable them for this site, or open the application in a new browser tab.',
          );
        }
      }

      if (me.csrfToken) setCsrfToken(me.csrfToken);
      setUser(result.user);
      setStatus('authenticated');
      await queryClient.invalidateQueries();
      void refetch();
      return result.user;
    },
    [queryClient, refetch],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // A failed logout must still clear client state; the server session expiry handles the rest.
    }
    clearSessionToken();
    setUser(null);
    setUnread(0);
    setStatus('anonymous');
    queryClient.clear();
  }, [queryClient]);

  const refresh = useCallback(async () => {
    const result = await refetch();
    if (result.data?.authenticated && result.data.user) {
      setUser(result.data.user);
      setUnread(result.data.unreadNotifications ?? 0);
      setStatus('authenticated');
    }
  }, [refetch]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      unreadNotifications: unread,
      status,
      login,
      logout,
      refresh,
      hasPermission: (...permissions: string[]) => {
        if (!user) return false;
        if (user.role === 'super_admin') return true;
        return permissions.some((permission) => user.permissions.includes(permission));
      },
      hasRole: (...roles: string[]) => Boolean(user && roles.includes(user.role)),
    }),
    [user, unread, status, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

/** Convenience hook returning just the signed-in user (guaranteed inside protected routes). */
export function useCurrentUser(): SessionUser {
  const { user } = useAuth();
  if (!user) throw new Error('No signed-in user in this route');
  return user;
}
