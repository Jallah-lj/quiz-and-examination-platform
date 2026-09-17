/**
 * Session cookie policy.
 *
 * Two environments must both work:
 *
 * - **Local development over plain HTTP** (`http://localhost:5173`). A `Secure` cookie is
 *   discarded by the browser on an insecure origin, and `SameSite=None` is rejected
 *   outright unless the cookie is also `Secure`. Requiring HTTPS here produces the classic
 *   "login succeeds, every later request is anonymous" failure, so the cookie is issued as
 *   `Secure=false; SameSite=Lax` for HTTP requests.
 * - **Embedded / proxied deployments over HTTPS** (preview hosts, iframes on another
 *   site). The document is top-level *elsewhere*, so a `Lax` cookie is never sent with the
 *   cross-site API calls. There the cookie must be `SameSite=None; Secure`.
 *
 * The transport is therefore derived from the request itself, and an explicit
 * `COOKIE_SECURE` / `COOKIE_SAME_SITE` setting always overrides the automatic choice.
 */
import type { CookieOptions, Request } from 'express';
import { env } from '../config/env';

function requestIsSecure(req: Request): boolean {
  if (req.secure) return true;
  // Behind a TLS-terminating proxy (the sandbox preview host, a load balancer).
  const forwarded = req.header('x-forwarded-proto');
  return typeof forwarded === 'string' && forwarded.split(',')[0].trim().toLowerCase() === 'https';
}

export interface SessionCookiePolicy {
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  /** True when the policy came from an explicit COOKIE_* setting. */
  configured: boolean;
}

export function sessionCookiePolicy(req: Request): SessionCookiePolicy {
  const secureConfigured = process.env.COOKIE_SECURE !== undefined;
  const sameSiteConfigured = process.env.COOKIE_SAME_SITE !== undefined;
  const secure = secureConfigured ? env.cookieSecure : requestIsSecure(req);
  // Browsers only accept `SameSite=None` on secure cookies, so it is never chosen for HTTP.
  const sameSite = sameSiteConfigured ? env.cookieSameSite : secure ? 'none' : 'lax';
  return { secure, sameSite, configured: secureConfigured || sameSiteConfigured };
}

/** Cookie attributes for the session and its readable double-submit CSRF companion. */
export function sessionCookieOptions(req: Request, expires: Date): CookieOptions {
  const { secure, sameSite } = sessionCookiePolicy(req);
  return { path: '/', expires, secure, sameSite };
}
