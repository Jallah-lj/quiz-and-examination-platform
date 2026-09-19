import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Never retry authentication, authorisation or validation failures.
        if (error instanceof ApiError) {
          if ([401, 403, 404, 422, 409].includes(error.status)) return false;
          return failureCount < 2;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
