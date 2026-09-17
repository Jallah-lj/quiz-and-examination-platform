import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { env } from '../config/env';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.bcryptRounds);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** Synchronous variants: only used inside database transactions where awaiting is not possible. */
export function hashPasswordSync(plain: string): string {
  return bcrypt.hashSync(plain, env.bcryptRounds);
}

export function verifyPasswordSync(plain: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

/** Minimum password policy enforced on every creation / reset path. */
export function validatePasswordStrength(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push('Password must be at least 10 characters long.');
  if (!/[A-Za-z]/.test(password)) problems.push('Password must contain at least one letter.');
  if (!/[0-9]/.test(password)) problems.push('Password must contain at least one number.');
  if (/^(password|123456|qwerty|letmein|admin)/i.test(password)) {
    problems.push('Password is too common.');
  }
  return problems;
}

/** Opaque, high-entropy token for sessions and single-use links. */
export function generateOpaqueToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Tokens are stored hashed so that a database leak does not yield usable credentials. */
export function hashToken(token: string, secret: string = env.sessionSecret): string {
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
