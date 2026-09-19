/**
 * The app's routes, as patterns.
 *
 * Links arrive from the server (notifications, dashboard exceptions) and are followed by a
 * button in the interface. When a stored link outlives the route it pointed at — as the
 * retired `/student/*` prefix did — the user is sent to the not-found page. Anything that
 * offers the user a stored link checks it against this table first, so a stale link shows
 * no button rather than a dead one.
 *
 * Matching is segment by segment rather than by prefix, so `/grading/queue` is rejected
 * even though `/grading` exists. `navigation.test.ts` asserts this table and App.tsx agree
 * in both directions, so it cannot drift away from the router.
 */
export const APP_ROUTES = [
  '/dashboard',
  '/profile',
  '/notifications',
  '/platform',
  '/institutions',
  '/institutions/:institutionId/dashboard',
  '/students',
  '/teachers',
  '/users',
  '/academic',
  '/grading-schemes',
  '/system',
  '/question-banks',
  '/questions',
  '/questions/new',
  '/questions/:questionId/edit',
  '/quizzes',
  '/quizzes/new',
  '/quizzes/:quizId',
  '/quizzes/:quizId/edit',
  '/examinations',
  '/examinations/new',
  '/examinations/:examId',
  '/examinations/:examId/edit',
  '/examinations/:examId/monitor',
  '/my-attempts',
  '/attempts/:attemptId/take',
  '/attempts/:attemptId/review',
  '/grading',
  '/grading/attempts/:attemptId',
  '/results',
  '/results/:resultId',
  '/reports',
  '/audit-logs',
] as const;

function segments(value: string): string[] {
  return value.split('?')[0].replace(/\/+$/, '').split('/').filter(Boolean);
}

/** True when a path matches a routed pattern, parameter segments matching any one segment. */
export function isRoutedPath(path: string): boolean {
  const parts = segments(path);
  return APP_ROUTES.some((route) => {
    const pattern = segments(route);
    return pattern.length === parts.length && pattern.every((step, index) => step.startsWith(':') || step === parts[index]);
  });
}

/**
 * Returns the link when the app can actually open it, otherwise null.
 * Query strings are preserved; the path is matched against the route table above.
 */
export function knownLink(link: string | null | undefined): string | null {
  if (!link) return null;
  if (link === '/' || link === '') return '/dashboard';
  const path = link.split('?')[0];
  return isRoutedPath(path) ? link : null;
}
