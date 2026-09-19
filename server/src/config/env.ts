import path from 'node:path';
import dotenv from 'dotenv';
import { loadOrCreateDevSecret } from './secrets';

const rootDir = path.resolve(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(rootDir, '.env') });

/**
 * Secrets are never hard-coded. In production each one must be supplied through the
 * environment; for local development a stable value is generated once and kept beside
 * the database (see `config/secrets.ts`) so that restarting the server — or rebuilding
 * the sandbox image — never invalidates live sessions.
 */
function resolveSecret(envName: string, dataDir: string): string {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (isProd) {
    throw new Error(`${envName} must be set to at least 32 characters in production.`);
  }
  if (fromEnv && fromEnv.length > 0 && fromEnv.length < 32) {
    throw new Error(`${envName} must be at least 32 characters long.`);
  }
  const { secret, created } = loadOrCreateDevSecret(envName, dataDir);
  if (created) {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] ${envName} not set — generated a development secret in ${path.join(dataDir, 'dev-secrets.json')}. ` +
        'Set it in the environment for any shared or production deployment.',
    );
  }
  return secret;
}

const isProd = process.env.NODE_ENV === 'production';
const resolvedEnv = process.env.NODE_ENV ?? 'development';

const databaseFile =
  process.env.DATABASE_FILE ??
  (resolvedEnv === 'test'
    ? path.join(rootDir, '.cache', `test-${process.pid}-${Date.now()}.sqlite`)
    : path.join(rootDir, 'data', 'examsys.sqlite'));
// Secrets travel with the data they sign, so a recycled temp directory can never
// silently orphan every stored session. The test database is intentionally ephemeral.
const secretsDir = resolvedEnv === 'test' ? path.join(rootDir, '.cache') : path.dirname(databaseFile);

export const env = {
  nodeEnv: resolvedEnv,
  isProd,
  isTest: resolvedEnv === 'test',
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseFile,
  jwtSecret: resolveSecret('JWT_SECRET', secretsDir),
  sessionSecret: resolveSecret('SESSION_SECRET', secretsDir),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
  cookieName: process.env.COOKIE_NAME ?? 'examsys_session',
  cookieSecure: process.env.COOKIE_SECURE === 'true' || isProd,
  cookieSameSite: (process.env.COOKIE_SAME_SITE ?? 'lax') as 'lax' | 'strict' | 'none',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? (isProd ? 12 : 10)),
  loginMaxAttempts: Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5),
  loginLockMinutes: Number(process.env.LOGIN_LOCK_MINUTES ?? 15),
  attemptClockGraceSeconds: Number(process.env.ATTEMPT_CLOCK_GRACE_SECONDS ?? 20),
  exposeResetTokens: process.env.EXPOSE_RESET_TOKENS === 'true' || !isProd,
  /**
   * Allows the SPA to receive its session token in the login response body and send it
   * back as `Authorization: Bearer`. Needed when the client runs in a context where
   * cookies are blocked (cross-site iframe previews, embedded webviews). The HttpOnly
   * session cookie stays the primary transport; production defaults to cookie-only.
   */
  allowSessionTokens: process.env.ALLOW_SESSION_TOKENS === 'true' || !isProd,
  webDistDir: path.join(rootDir, 'web', 'dist'),
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  serveWeb: process.env.SERVE_WEB !== 'false',
  trustProxy: process.env.TRUST_PROXY === 'true',
  appName: process.env.APP_NAME ?? 'ExamSys',
  /** Public address of this deployment, used to build links inside account emails. */
  appBaseUrl: process.env.APP_BASE_URL ?? '',
  /** The SPA's development port, used as the last-resort link base when nothing is set. */
  webDevPort: Number(process.env.WEB_DEV_PORT ?? 5173),
  /*
   * Outbound email. `SMTP_HOST` is what switches real delivery on; without it the server
   * writes messages to a development outbox and refuses to pretend it sent them in
   * production. Credentials come from the environment only.
   */
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? 'no-reply@examsys.local',
  },
  // Demo records are a development convenience: never enabled implicitly in production.
  seedDemoData: process.env.SEED_DEMO_DATA ? process.env.SEED_DEMO_DATA === 'true' : !isProd,
  schedulerEnabled: process.env.SCHEDULER_ENABLED !== 'false',
};

export const rootDirectory = rootDir;

/** Generic runtime config validation used at boot to fail fast. */
export function assertValidConfig(): void {
  if (!Number.isInteger(env.port) || env.port <= 0 || env.port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }
  if (env.loginMaxAttempts < 1) throw new Error('LOGIN_MAX_ATTEMPTS must be >= 1');
}
