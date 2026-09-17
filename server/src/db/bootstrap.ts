/**
 * Boot-time provisioning: ensures the RBAC catalogue and, on an empty database, the
 * first platform administrator exist. Running this repeatedly is safe.
 */
import crypto from 'node:crypto';
import type { Db } from './index';
import { hashPassword, validatePasswordStrength } from '../lib/crypto';
import { PERMISSIONS, ROLE_DEFINITIONS, ROLE_PERMISSIONS, type PermissionDef } from '../lib/rbac';
import { nowIso } from '../lib/time';
import { env } from '../config/env';

export function syncRolesAndPermissions(db: Db): void {
  const timestamp = nowIso();
  const insertRole = db.prepare(
    `INSERT INTO roles (code, name, description, scope, is_system, created_at) VALUES (?,?,?,?,1,?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, description = excluded.description`,
  );
  for (const [code, definition] of Object.entries(ROLE_DEFINITIONS)) {
    insertRole.run(code, definition.name, definition.description, definition.scope, timestamp);
  }

  const insertPermission = db.prepare(
    `INSERT INTO permissions (code, name, category, description, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, category = excluded.category, description = excluded.description`,
  );
  for (const permission of PERMISSIONS) {
    insertPermission.run(
      permission.code,
      permission.name,
      permission.category,
      permission.description ?? null,
      timestamp,
    );
  }

  // System roles always mirror the code-defined mapping.
  const roleRows = db.prepare('SELECT id, code FROM roles').all() as { id: number; code: string }[];
  const deleteMapping = db.prepare('DELETE FROM role_permissions WHERE role_id = ?');
  const insertMapping = db.prepare(
    'INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code = ?',
  );
  const run = db.transaction(() => {
    for (const role of roleRows) {
      const mapping = ROLE_PERMISSIONS[role.code as keyof typeof ROLE_PERMISSIONS];
      if (!mapping) continue;
      deleteMapping.run(role.id);
      const codes = mapping === 'all' ? PERMISSIONS.map((p: PermissionDef) => p.code) : mapping;
      for (const code of codes) insertMapping.run(role.id, code);
    }
  });
  run();
}

/**
 * Guarantees a freshly created (or re-created) database is immediately usable.
 *
 * Containers and sandboxes are re-instantiated without warning, which can remove the
 * data directory while the running application keeps serving requests. Provisioning on
 * boot means such an environment comes back with schema, roles and — when demo seeding
 * is enabled and the database holds no institution at all — the documented demo
 * accounts, instead of appearing broken.
 *
 * A database that already contains any institution is never touched: demo data can only
 * ever be added to an empty database, never mixed into real records.
 */
export async function ensureDemoData(db: Db): Promise<{ seeded: boolean; reason: string }> {
  // `bootstrapPlatform` may already have created the "PLATFORM" office, which is part of
  // the application itself rather than customer data. Anything else means this database
  // belongs to a real deployment and must never be seeded with demonstration records.
  const realInstitutions = db
    .prepare("SELECT COUNT(*) AS c FROM institutions WHERE code != 'PLATFORM'")
    .get() as { c: number };
  if (realInstitutions.c > 0) {
    return { seeded: false, reason: 'database already contains institutions' };
  }
  const { seedDatabase } = await import('./seed');
  const result = await seedDatabase(db);
  return { seeded: true, reason: `seeded institution #${result.institutionId}` };
}

export interface BootstrapResult {
  createdPlatformAdmin: boolean;
  temporaryPassword?: string;
}

/** Creates the first platform administrator and a demo institution on an empty database. */
export async function bootstrapPlatform(db: Db): Promise<BootstrapResult> {
  syncRolesAndPermissions(db);

  const hasAdmin = db.prepare("SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'super_admin'").get() as {
    c: number;
  };
  if (hasAdmin.c > 0) return { createdPlatformAdmin: false };

  const email = process.env.PLATFORM_ADMIN_EMAIL ?? 'admin@examsys.local';
  const provided = process.env.PLATFORM_ADMIN_PASSWORD;
  const password = provided && validatePasswordStrength(provided).length === 0
    ? provided
    : `Admin-${crypto.randomBytes(6).toString('base64url')}1`;

  const role = db.prepare("SELECT id FROM roles WHERE code = 'super_admin'").get() as { id: number };
  const hash = await hashPassword(password);
  const timestamp = nowIso();

  const institutionId = db.transaction(() => {
    let institution = db.prepare('SELECT id FROM institutions ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    if (!institution) {
      const info = db
        .prepare(
          `INSERT INTO institutions (name, code, type, country, timezone, status, created_at, updated_at)
           VALUES (?,?,?,?,?, 'active', ?, ?)`,
        )
        .run('Platform Office', 'PLATFORM', 'organisation', '—', 'UTC', timestamp, timestamp);
      institution = { id: Number(info.lastInsertRowid) };
    }
    db.prepare(
      `INSERT INTO users (institution_id, role_id, full_name, email, password_hash, status, email_verified_at, must_change_password, created_at, updated_at)
       VALUES (?,?,?,?,?, 'active', ?, 1, ?, ?)`,
    ).run(institution.id, role.id, 'Platform Administrator', email, hash, timestamp, timestamp, timestamp);
    return institution.id;
  })();

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '──────────────────────────────────────────────',
      ' Initial platform administrator created',
      `   email:    ${email}`,
      provided && validatePasswordStrength(provided).length === 0
        ? '   password: (from PLATFORM_ADMIN_PASSWORD)'
        : `   password: ${password}`,
      '   Change this password after the first sign-in.',
      `   Institution #${institutionId} was created as the platform office.`,
      '──────────────────────────────────────────────',
      '',
    ].join('\n'),
  );

  return {
    createdPlatformAdmin: true,
    temporaryPassword: provided ? undefined : password,
  };
}

export { env };
