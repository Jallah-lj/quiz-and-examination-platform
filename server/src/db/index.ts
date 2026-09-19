import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config/env';

export type Db = Database.Database;

let instance: Db | null = null;

export function getDb(): Db {
  if (!instance) {
    instance = openDatabase();
  }
  return instance;
}

function openDatabase(): Db {
  const file = env.databaseFile;
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);
  return db;
}

/** Applies every migration file that has not been recorded yet, in filename order. */
export function runMigrations(db: Db): void {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`,
  );
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row: any) => row.version as string),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        file,
        new Date().toISOString(),
      );
    });
    apply();
  }
}

/** Test helper: fresh in-memory database with the schema applied. */
export function createTestDatabase(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function setDbForTesting(db: Db): void {
  instance = db;
  db.pragma('foreign_keys = ON');
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Runs `fn` inside a transaction; rolls back on any thrown error. */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}
