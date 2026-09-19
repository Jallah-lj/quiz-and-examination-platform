/**
 * Boot provisioning: an environment that loses its data directory must come back with a
 * usable, correctly seeded database — and a database that already holds real records must
 * never receive demonstration data.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './index';
import { createTestDatabase } from './index';
import { bootstrapPlatform, ensureDemoData, syncRolesAndPermissions } from './bootstrap';
import { verifyPasswordSync } from '../lib/crypto';

let db: Db;

beforeEach(() => {
  db = createTestDatabase();
  syncRolesAndPermissions(db);
});

afterEach(() => {
  db.close();
});

describe('boot provisioning', () => {
  it('seeds the documented demo accounts into a database that has no institution', async () => {
    // Mirrors a freshly created container: schema applied, nothing else.
    await bootstrapPlatform(db);
    const result = await ensureDemoData(db);
    expect(result.seeded).toBe(true);

    const admin = db
      .prepare(
        `SELECT u.email, u.status, u.password_hash, r.code AS role, i.is_demo
           FROM users u
           JOIN roles r ON r.id = u.role_id
           JOIN institutions i ON i.id = u.institution_id
          WHERE u.email = 'demo.admin@northgate.edu'`,
      )
      .get() as { email: string; status: string; password_hash: string; role: string; is_demo: number } | undefined;
    expect(admin).toBeDefined();
    expect(admin!.role).toBe('institution_admin');
    expect(admin!.status).toBe('active');
    expect(admin!.is_demo).toBe(1);

    // The password is hashed and verifiable — provisioning never creates a bypass.
    expect(admin!.password_hash).toMatch(/^\$2[aby]\$/);
    expect(admin!.password_hash).not.toContain('Demo-Password1');
    expect(verifyPasswordSync(process.env.DEMO_PASSWORD ?? 'Demo-Password1', admin!.password_hash)).toBe(true);

    // A candidate account is provisioned as well, so every role is testable.
    const student = db
      .prepare(
        `SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'student'`,
      )
      .get() as { c: number };
    expect(student.c).toBeGreaterThan(0);
  });

  it('is idempotent — a second boot adds nothing', async () => {
    await bootstrapPlatform(db);
    await ensureDemoData(db);
    const before = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };

    const second = await ensureDemoData(db);
    expect(second.seeded).toBe(false);
    const after = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it('never mixes demo records into a database that has real institutions', async () => {
    const timestamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO institutions (name, code, type, country, timezone, status, is_demo, created_at, updated_at)
       VALUES ('Riverside College', 'RSC', 'university', 'Kenya', 'Africa/Nairobi', 'active', 0, ?, ?)`,
    ).run(timestamp, timestamp);

    const result = await ensureDemoData(db);
    expect(result.seeded).toBe(false);

    const demo = db.prepare('SELECT COUNT(*) AS c FROM institutions WHERE is_demo = 1').get() as { c: number };
    expect(demo.c).toBe(0);
    const demoUsers = db.prepare("SELECT COUNT(*) AS c FROM users WHERE email LIKE 'demo.%'").get() as { c: number };
    expect(demoUsers.c).toBe(0);
  });
});
