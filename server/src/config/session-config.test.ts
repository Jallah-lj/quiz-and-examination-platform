/**
 * Regression tests for the two configuration faults that make a correct sign-in look
 * broken: a signing key that changes behind stored sessions, and cookie attributes that
 * the browser silently refuses to store.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasDevSecret, loadOrCreateDevSecret } from './secrets';
import { sessionCookiePolicy } from '../lib/cookies';
import { hashToken } from '../lib/crypto';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'examsys-secrets-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('development signing secrets', () => {
  it('returns the same secret for every process start while the data directory lives', () => {
    const first = loadOrCreateDevSecret('SESSION_SECRET', dataDir);
    expect(first.created).toBe(true);
    expect(first.secret.length).toBeGreaterThanOrEqual(32);

    // A later boot (new module state, same data) must reuse the stored value: this is
    // what keeps sessions valid across restarts and container re-instantiation.
    const second = loadOrCreateDevSecret('SESSION_SECRET', dataDir);
    expect(second.created).toBe(false);
    expect(second.secret).toBe(first.secret);
    expect(hasDevSecret('SESSION_SECRET', dataDir)).toBe(true);
  });

  it('keeps different secrets per data directory and per name', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'examsys-secrets-b-'));
    try {
      const a = loadOrCreateDevSecret('SESSION_SECRET', dataDir).secret;
      const b = loadOrCreateDevSecret('SESSION_SECRET', other).secret;
      const jwt = loadOrCreateDevSecret('JWT_SECRET', dataDir).secret;
      expect(a).not.toBe(b);
      expect(a).not.toBe(jwt);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('replaces a truncated or corrupt store instead of accepting a weak key', () => {
    fs.writeFileSync(path.join(dataDir, 'dev-secrets.json'), JSON.stringify({ SESSION_SECRET: 'short' }));
    const { secret, created } = loadOrCreateDevSecret('SESSION_SECRET', dataDir);
    expect(created).toBe(true);
    expect(secret.length).toBeGreaterThanOrEqual(32);

    fs.writeFileSync(path.join(dataDir, 'dev-secrets.json'), 'not json at all');
    expect(loadOrCreateDevSecret('SESSION_SECRET', dataDir).secret.length).toBeGreaterThanOrEqual(32);
  });

  it('produces session hashes that stay verifiable after a restart', () => {
    // A token issued before the restart must still resolve afterwards: the hash must be
    // identical, which only holds when the key is stable.
    const before = loadOrCreateDevSecret('SESSION_SECRET', dataDir).secret;
    const token = 'token-issued-before-restart';
    const storedHash = hashToken(token, before);

    const afterRestart = loadOrCreateDevSecret('SESSION_SECRET', dataDir).secret;
    expect(hashToken(token, afterRestart)).toBe(storedHash);
  });

  it('writes the secret file with owner-only permissions', () => {
    loadOrCreateDevSecret('SESSION_SECRET', dataDir);
    const mode = fs.statSync(path.join(dataDir, 'dev-secrets.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('session cookie policy', () => {
  function policyFor(headers: Record<string, string> = {}) {
    const app = express();
    let captured: ReturnType<typeof sessionCookiePolicy> | null = null;
    app.get('/probe', (req, res) => {
      captured = sessionCookiePolicy(req);
      res.json(captured);
    });
    return request(app)
      .get('/probe')
      .set(headers)
      .then(() => captured!);
  }

  it('never requires HTTPS cookies on a plain-HTTP development origin', async () => {
    const policy = await policyFor({ host: 'localhost:5173' });
    // Secure cookies are dropped by browsers on http:// origins, and SameSite=None is
    // rejected outright unless the cookie is also Secure — both break sign-in silently.
    expect(policy.secure).toBe(false);
    expect(policy.sameSite).toBe('lax');
    expect(policy.configured).toBe(false);
  });

  it('uses SameSite=None; Secure behind an HTTPS proxy so embedded clients receive it', async () => {
    const policy = await policyFor({ host: 'preview.example.test', 'x-forwarded-proto': 'https' });
    expect(policy.secure).toBe(true);
    expect(policy.sameSite).toBe('none');
  });

  it('detects HTTPS from the page origin when the proxy forwards no scheme header', async () => {
    // This is the embedded-preview case: the gateway adds no X-Forwarded-Proto, so the
    // only signal is the scheme of the page that issued the request. Missing it produced a
    // Lax cookie that a cross-site iframe never sends, i.e. "login works, then nothing".
    const policy = await policyFor({
      host: '5173-abc.e2b.app',
      origin: 'https://5173-abc.e2b.app',
    });
    expect(policy.secure).toBe(true);
    expect(policy.sameSite).toBe('none');
  });

  it('treats a plain-HTTP page as insecure even when a proxy claims otherwise', async () => {
    const policy = await policyFor({ host: 'localhost:5173', origin: 'http://localhost:5173' });
    expect(policy.secure).toBe(false);
    expect(policy.sameSite).toBe('lax');
  });
});
