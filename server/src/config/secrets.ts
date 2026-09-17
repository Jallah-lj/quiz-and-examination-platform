/**
 * Development secret storage.
 *
 * Session tokens, CSRF tokens and password-reset links are stored as HMACs keyed with
 * `SESSION_SECRET` / `JWT_SECRET`. If that key changes — even silently — every existing
 * session stops validating while the browser still holds its cookie/token, which shows
 * up as "signed in successfully, then every request is anonymous".
 *
 * Temporary locations are not safe for that key: process-level randomness changes it on
 * every restart, and scratch directories (`.cache`, `/tmp`) are wiped when a container
 * or sandbox is re-instantiated. The key is therefore kept **beside the SQLite database
 * it signs sessions for**: the two are always created, backed up and discarded together.
 *
 * Production never uses this path — `resolveSecret` requires an environment value there.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

interface SecretFile {
  [name: string]: string;
}

const FILE_NAME = 'dev-secrets.json';

function readFile(file: string): SecretFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as SecretFile;
  } catch {
    // Missing or unreadable: treated as empty and rewritten below.
  }
  return {};
}

/**
 * Returns the stored development secret for `name`, creating it on first use.
 * Repeated calls — including from a freshly started process — return the same value
 * for as long as the data directory lives.
 */
export function loadOrCreateDevSecret(name: string, dataDir: string): { secret: string; file: string; created: boolean } {
  const file = path.join(dataDir, FILE_NAME);
  fs.mkdirSync(dataDir, { recursive: true });
  const store = readFile(file);
  const existing = store[name];
  if (typeof existing === 'string' && existing.length >= 32) {
    return { secret: existing, file, created: false };
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  store[name] = secret;
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  return { secret, file, created: true };
}

/** Test helper: true when the store already holds a value for `name`. */
export function hasDevSecret(name: string, dataDir: string): boolean {
  const store = readFile(path.join(dataDir, FILE_NAME));
  return typeof store[name] === 'string' && (store[name] as string).length >= 32;
}
