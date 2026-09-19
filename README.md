# ExamSys — Quiz & Examination Management Platform

Multi-institution platform for creating, scheduling, sitting, marking and publishing
quizzes and examinations. Deterministic logic only: there is no AI, no generated
content and no automated subjective marking anywhere in the system.

- **Server** — Express 4 + better-sqlite3 + TypeScript (CommonJS), REST API under `/api`,
  server-authoritative examination timing, RBAC enforced on every route.
- **Web** — Vite + React 18 + React Router 6 + TanStack Query (SPA).

## Getting started

```bash
npm install                     # installs both workspaces
npm run seed --workspace server # creates data/examsys.sqlite and labelled demo data
npm run dev                     # API on :4000, web client on :5173
```

The web client proxies `/api` to the API (`VITE_API_TARGET`, default `http://127.0.0.1:4000`),
so the browser only ever talks to one origin.

Other scripts: `npm run build` (type-check + production bundle), `npm start` (serve API and
`web/dist` from one process), `npm run reset` (rebuild the database from scratch),
`npm test`, `npm run typecheck`.

## Demo accounts

Seeded records are marked as demo data (`institutions.is_demo = 1`) and never mix with
production statistics. All demo accounts share the password in `DEMO_PASSWORD`
(default `Demo-Password1`).

| Role | Sign-in |
| --- | --- |
| Institution Administrator | `demo.admin@northgate.edu` |
| Teacher / Examiner (1–5) | `demo.teacher1@northgate.edu` … `demo.teacher5@northgate.edu` |
| Student / Candidate (1–30) | `demo.student001@northgate.edu` … `demo.student030@northgate.edu` |

`npm run seed` also creates the **first platform administrator** (`admin@examsys.local`
by default). Its password is never hard-coded: it comes from `PLATFORM_ADMIN_PASSWORD`
when that value passes the strength check, otherwise a random one is generated and
printed once. `PLATFORM_ADMIN_EMAIL` overrides the address.

## Configuration

Secrets and environment-specific settings come from the environment; the defaults in
`server/src/config/env.ts` are development-only. See `server/.env.example`.

| Variable | Purpose |
| --- | --- |
| `DATABASE_FILE` | SQLite file (default `data/examsys.sqlite`) |
| `JWT_SECRET`, `SESSION_SECRET` | Token/session secrets — required in production |
| `PORT`, `HOST` | API binding (default `4000`, `0.0.0.0`) |
| `COOKIE_SECURE`, `COOKIE_SAME_SITE`, `SESSION_TTL_HOURS` | Session cookie policy |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_MINUTES` | Sign-in lockout policy |
| `ATTEMPT_CLOCK_GRACE_SECONDS` | Grace window applied to server-side submission timing |
| `CORS_ORIGINS` | Extra origins allowed to call the API (comma separated) |
| `APP_BASE_URL` | Public address used to build links inside account emails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Outbound mail for password reset and address verification (see below) |
| `SERVE_WEB` | Serve `web/dist` from the API process (default on) |
| `ALLOW_SESSION_TOKENS` | Allow the bearer session transport (see below) |
| `SEED_DEMO_DATA`, `SCHEDULER_ENABLED` | Demo seed on boot, background scheduler |

## Session transport

Sign-in normally returns an `HttpOnly` session cookie plus a readable CSRF cookie that
the SPA echoes in `X-CSRF-Token` (double-submit). No credential is ever stored in
`localStorage`.

The cookie attributes follow the request transport, so both cases work without
configuration:

| Request arrives over | Session cookie | Why |
| --- | --- | --- |
| plain HTTP (`http://localhost:5173`) | `Secure=false; SameSite=Lax` | Browsers drop `Secure` cookies on insecure origins, and reject `SameSite=None` unless it is also `Secure` |
| HTTPS (preview hosts, reverse proxies, embedded iframes) | `Secure=true; SameSite=None` | The document is top-level on another site, so a `Lax` cookie would never be sent |

`COOKIE_SECURE` / `COOKIE_SAME_SITE` override the automatic choice when a deployment
needs a fixed policy.

## Account email

Password reset and address verification are only completable by the account owner, so the
link is emailed rather than returned to the caller:

- **Production**: set `SMTP_HOST` (plus `SMTP_FROM`, and `SMTP_USER`/`SMTP_PASS` if the relay
  authenticates). Without it the server fails the send loudly and records the failure in the
  audit log — it never pretends the message went out.
- **Development**: with no mail server configured, messages are written to
  `data/outbox/*.eml`, and the log line names the file. That is where a reset link can be
  read during local work. `GET /api/system/info` reports the active transport.
- Tokens are never written to logs, and the neutral response to `POST /api/auth/forgot-password`
  is identical whether or not the address exists.

## Secrets and persistent sessions

Session, CSRF and password-reset tokens are stored as HMACs keyed with `SESSION_SECRET`.
If that key changes, every stored session stops validating while browsers still hold
their cookies — which presents as "sign-in succeeds, then every request is anonymous".

- **Production**: `JWT_SECRET` and `SESSION_SECRET` must be supplied by the environment
  (at least 32 characters); the server refuses to start otherwise.
- **Development**: when they are not set, a random value is generated **once** and stored
  in `dev-secrets.json` next to the database, so restarts — and container restarts — keep
  existing sessions valid. `.cache/`, `/tmp` and other scratch locations are deliberately
  not used: they are wiped when environments are re-created, which silently logs everyone out.

## Boot provisioning

Startup is self-healing: migrations run, the RBAC catalogue is synchronised, and on a
database without institutions the server creates the first platform administrator and
(unless `SEED_DEMO_DATA=false`) the labelled demo data. A re-created data directory
therefore comes back usable instead of half-initialised. A database that already holds
any institution is never seeded — demo records can only ever be added to an empty one.
Seeding is disabled by default in production.

Some hosting contexts cannot keep that cookie — an SPA embedded in a cross-site iframe
or a webview where third-party cookies are blocked. In those contexts the browser would
store nothing, and every request after sign-in would be anonymous. To cover this the
client asks for `X-Session-Transport: bearer` at sign-in; when `ALLOW_SESSION_TOKENS` is
enabled (default outside production) the response also carries `sessionToken`, which the
SPA keeps in `sessionStorage` (tab-scoped, dropped on close) and sends as
`Authorization: Bearer`. The cookie still takes precedence, CSRF is still required for
state-changing requests, and disabling the flag restores cookie-only behaviour. If
neither transport can be established the sign-in screen reports it explicitly instead of
letting every page fail with a generic error.

## Project layout

```
server/
  src/config        environment and validation
  src/db            schema migrations, bootstrap, demo seed
  src/lib           errors, crypto, grading, lifecycles, exporters
  src/middleware     authentication, RBAC, rate limiting, security headers, errors
  src/services      domain logic (auth, attempts, exams, quizzes, grading, results, reports…)
  src/routes        REST endpoints, mounted by src/routes/index.ts
  src/test-utils    integration harness (in-memory database)
web/
  src/lib           API client, formatters, hooks
  src/components    design-system components, layout, charts
  src/pages         one module per screen, matching the routes in src/App.tsx
  src/styles        design system stylesheet
```

## Testing

```bash
npm run typecheck       # server + web
npm test                # server suites, then web suites
```

Server suites cover grading, exam lifecycles, the attempt engine, end-to-end API flows
and security behaviour (tenant isolation, token handling, privilege escalation,
injection, rate limiting, response hygiene). Web suites cover the API client contract
and the examination interface (navigation, answer persistence, submission, timer).
