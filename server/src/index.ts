import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import { assertValidConfig, env } from './config/env';
import { getDb } from './db';
import apiRouter from './routes';
import { authenticate } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { createRateLimiter, noStore, securityHeaders } from './middleware/security';
import { startScheduler, type SchedulerHandle } from './services/scheduler';
import { bootstrapPlatform, ensureDemoData, syncRolesAndPermissions } from './db/bootstrap';
import type { AuthedRequest } from './types';

assertValidConfig();

const db = getDb();
const app = express();
let scheduler: SchedulerHandle | null = null;

if (env.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
// No ETags: API bodies are user-specific, and a conditional request must never be
// answered with a replayed 304 from a previous (possibly unauthenticated) response.
// Hashed static assets are served with immutable caching instead.
app.set('etag', false);

app.use(securityHeaders);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

// Cross-origin support is opt-in and restricted to explicitly configured origins.
app.use((req, res, next) => {
  const origin = req.header('origin');
  if (!origin) return next();
  const allowed = env.corsOrigins.includes(origin) || env.corsOrigins.includes('*');
  if (!allowed) return next();
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

// Development-only request log. It records how a request authenticated — which is the
// fastest way to diagnose clients whose cookies are blocked — and never logs secrets.
if (!env.isProd) {
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      const authed = req as AuthedRequest;
      const hasCookie = Boolean(req.cookies?.[env.cookieName]);
      const hasBearer = Boolean(req.header('authorization'));
      const hasTokenHeader = Boolean(req.header('x-session-token') || req.header('x-auth-token'));
      const presented =
        [hasCookie ? 'cookie' : null, hasBearer ? 'bearer' : null, hasTokenHeader ? 'token-header' : null]
          .filter(Boolean)
          .join('+') || 'none';
      // Header *names* only, never values: this is how we tell whether a proxy is dropping
      // the credential (or the cookie) before the request ever reaches the application.
      const headerNames = Object.keys(req.headers).sort().join(',');
      // eslint-disable-next-line no-console
      console.log(
        `[req] ${req.method} ${req.originalUrl} ${res.statusCode} ` +
          `presented=${presented} user=${authed.user ? `#${authed.user.id}` : 'none'} ${Date.now() - startedAt}ms` +
          (presented === 'none' ? ` headers=[${headerNames}]` : ''),
      );
    });
    next();
  });
}

app.use(authenticate);

app.use('/api', noStore);

const globalLimiter = createRateLimiter({ windowMs: 60_000, max: 600, keyPrefix: 'global' });
app.use('/api', globalLimiter, apiRouter);

app.use('/api', notFoundHandler);

// Serve the built SPA when it exists (single-service deployment).
const webDist = env.webDistDir;
if (env.serveWeb && fs.existsSync(webDist)) {
  app.use(
    express.static(webDist, {
      index: false,
      setHeaders: (res, filePath) => {
        if (/\.(js|css|woff2?|png|svg|jpg)$/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.json({
      data: {
        name: env.appName,
        message: 'ExamSys API is running. Start the web client with `npm run dev:web`.',
        api: '/api/health',
      },
    });
  });
}

app.use(errorHandler);

async function start(): Promise<void> {
  // Migration and RBAC catalogue first: a re-created data directory must come back ready
  // to serve, never half-initialised.
  syncRolesAndPermissions(db);
  await bootstrapPlatform(db);

  if (env.seedDemoData) {
    const provisioned = await ensureDemoData(db);
    if (provisioned.seeded) {
      // eslint-disable-next-line no-console
      console.log(
        `[examsys] empty database — provisioned labelled demo data (${provisioned.reason}). ` +
          'Set SEED_DEMO_DATA=false to run without demo records.',
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[examsys] sessions: cookie "${env.cookieName}" (policy follows the request transport; ` +
      `explicit override COOKIE_SECURE=${process.env.COOKIE_SECURE ?? 'unset'} COOKIE_SAME_SITE=${process.env.COOKIE_SAME_SITE ?? 'unset'}), ` +
      `bearer fallback ${env.allowSessionTokens ? 'enabled' : 'disabled'}, ` +
      `tokens signed with ${process.env.SESSION_SECRET ? 'SESSION_SECRET from the environment' : 'a development secret stored beside the database'}`,
  );

  if (env.schedulerEnabled) {
    scheduler = startScheduler(db, {
      onRun: (summary) => {
        if (summary.attemptsExpired || summary.examsActivated || summary.remindersSent) {
          // eslint-disable-next-line no-console
          console.log('[scheduler]', JSON.stringify(summary));
        }
      },
    });
  }

  const server = app.listen(env.port, env.host, () => {
    // eslint-disable-next-line no-console
    console.log(`[examsys] API listening on http://${env.host}:${env.port} (${env.nodeEnv})`);
  });

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[examsys] received ${signal}, shutting down`);
    scheduler?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[examsys] failed to start', error);
    process.exit(1);
  });
}

export { app, start };
