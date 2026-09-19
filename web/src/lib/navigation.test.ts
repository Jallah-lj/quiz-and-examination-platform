/**
 * Every link the app can send a user to must exist in the router.
 *
 * Notification and exception links are generated on the server and followed by a button in
 * the interface, so a stale path there is a dead end the user only discovers by clicking.
 * That is exactly what happened with the retired `/student/...` prefix, and with an
 * exception that pointed at `/grading/queue` instead of `/grading`.
 *
 * The router is the source of truth: this reads the routes out of App.tsx and checks every
 * link literal produced by the server and every navigation target declared in the web app.
 */
import { describe, expect, it } from 'vitest';
import { APP_ROUTES, knownLink } from './links';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Tests run from web/, but the repository root keeps both workspaces.
const webRoot = existsSync(resolve(process.cwd(), 'src/App.tsx')) ? process.cwd() : resolve(process.cwd(), 'web');
const repoRoot = resolve(webRoot, '..');

const appSource = readFileSync(resolve(webRoot, 'src/App.tsx'), 'utf8');

/** Router paths with their parameters collapsed to `:p`, so `/results/12` matches `/results/:p`. */
function routePatterns(): string[][] {
  return Array.from(appSource.matchAll(/path="([^"]+)"/g), (match) => match[1])
    .filter((path) => path !== '*')
    .map((path) =>
      path
        .split('?')[0]
        .replace(/:[A-Za-z]+/g, ':p')
        .replace(/\/+$/, '')
        .split('/')
        .filter(Boolean),
    );
}

const ROUTES = routePatterns();

/** Resolves a link the way the router would, including parameterised children. */
function resolves(link: string): boolean {
  const segments = link
    .split('?')[0]
    .replace(/\$\{[^}]+\}/g, ':p')
    .replace(/:[A-Za-z]+/g, ':p')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
  return ROUTES.some(
    (route) => route.length === segments.length && route.every((part, index) => part === ':p' || part === segments[index]),
  );
}

/** Server files that generate links the user is invited to follow. */
const SERVER_FILES = [
  'src/routes/dashboards.ts',
  'src/routes/system.ts',
  'src/services/quizzes.ts',
  'src/services/exams.ts',
  'src/services/scheduler.ts',
  'src/db/seed.ts',
];

function serverLinks(): { link: string; file: string }[] {
  const links: { link: string; file: string }[] = [];
  for (const relative of SERVER_FILES) {
    const absolute = resolve(repoRoot, 'server', relative);
    if (!existsSync(absolute)) continue;
    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/link:\s*[`']([^`']+)[`']/g)) {
      links.push({ link: match[1], file: relative });
    }
    for (const match of source.matchAll(/link:\s*`([^`]+)`/g)) {
      links.push({ link: match[1], file: relative });
    }
  }
  return links;
}

describe('notification and exception links', () => {
  const links = serverLinks();

  it('links somewhere, and the router recognises every one', () => {
    expect(links.length, 'no server links were found to check').toBeGreaterThan(5);
    const dead = links.filter((entry) => !resolves(entry.link)).map((entry) => `${entry.link} (${entry.file})`);
    expect(dead, `these links lead to the not-found page: ${dead.join(', ')}`).toEqual([]);
  });

  it('never links to the retired /student prefix', () => {
    const legacy = links.filter((entry) => entry.link.startsWith('/student/'));
    expect(legacy, 'candidates have no /student routes; link to the shared page instead').toEqual([]);
  });

  it('is reachable by the role the notification is addressed to', () => {
    // The examinations page renders a candidate view, so the route must accept attempt.take
    // as well as the staff permissions; otherwise the link shows a forbidden page.
    const route = appSource.slice(appSource.indexOf('path="/examinations"'));
    expect(route.slice(0, 400)).toContain('attempt.take');
  });
});

describe('in-app navigation targets', () => {
  it('only navigates to routes that exist', () => {
    const files = ['src/components/AppLayout.tsx', 'src/pages/dashboard/InstitutionDashboardView.tsx', 'src/pages/dashboard/PlatformDashboardPage.tsx'];
    const targets: { target: string; file: string }[] = [];
    for (const file of files) {
      const source = readFileSync(resolve(webRoot, file), 'utf8');
      for (const match of source.matchAll(/<Link[^>]*\bto=\{?[`"]([^`"}]+)[`"]/g)) {
        targets.push({ target: match[1], file });
      }
    }
    const dead = targets.filter((entry) => !resolves(entry.target)).map((entry) => `${entry.target} (${entry.file})`);
    expect(dead, `these navigation targets do not exist: ${dead.join(', ')}`).toEqual([]);
  });
});

describe('link guard', () => {
  it('keeps its route list in step with the router, in both directions', () => {
    // Public authentication pages are reachable without the app shell and are not listed.
    const PUBLIC = ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email', '/'];
    const routed = Array.from(appSource.matchAll(/path="([^"]+)"/g), (match) => match[1]).filter(
      (path) => path !== '*' && !PUBLIC.includes(path),
    );

    const missing = APP_ROUTES.filter((route) => !routed.includes(route));
    expect(missing, `listed here but absent from App.tsx: ${missing.join(', ')}`).toEqual([]);
    const unlisted = routed.filter((route) => !APP_ROUTES.includes(route as (typeof APP_ROUTES)[number]));
    expect(unlisted, `routed but missing from the guard table: ${unlisted.join(', ')}`).toEqual([]);
  });

  it('rejects links a stored notification could still hold', () => {
    // The prefix that produced a dead end in the field.
    expect(knownLink('/student/results')).toBeNull();
    expect(knownLink('/grading/queue')).toBeNull();
    expect(knownLink('https://example.test/elsewhere')).toBeNull();
    expect(knownLink(null)).toBeNull();
    expect(knownLink(undefined)).toBeNull();
  });

  it('accepts real routes, including parameterised children and query strings', () => {
    expect(knownLink('/results')).toBe('/results');
    expect(knownLink('/results/12')).toBe('/results/12');
    expect(knownLink('/examinations?status=ACTIVE')).toBe('/examinations?status=ACTIVE');
    expect(knownLink('/examinations/3')).toBe('/examinations/3');
    expect(knownLink('/grading')).toBe('/grading');
    expect(knownLink('/grading/attempts/9')).toBe('/grading/attempts/9');
    expect(knownLink('/')).toBe('/dashboard');
    // A query string cannot smuggle in a route that does not exist.
    expect(knownLink('/grading/queue?tab=all')).toBeNull();
  });
});
