import type { Db } from '../db';

/** Returns the subset of supplied permission codes that the database does not know about. */
export function unknownPermissionCodes(db: Db, codes: string[]): string[] {
  if (!codes.length) return [];
  const placeholders = codes.map(() => '?').join(',');
  const known = db
    .prepare(`SELECT code FROM permissions WHERE code IN (${placeholders})`)
    .all(...codes) as { code: string }[];
  const knownSet = new Set(known.map((row) => row.code));
  return codes.filter((code) => !knownSet.has(code));
}

export const serverPermissions = { unknownPermissionCodes };
