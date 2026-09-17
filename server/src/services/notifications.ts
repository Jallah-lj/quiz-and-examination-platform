import type { Db } from '../db';
import { nowIso } from '../lib/time';

export interface NotificationInput {
  institutionId?: number | null;
  userId: number;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  severity?: 'info' | 'success' | 'warning' | 'critical';
  /** When supplied, repeated notifications with the same key collapse into one row. */
  dedupeKey?: string | null;
}

/** Rule-based notifications only — every message is generated from a system event. */
export function createNotification(db: Db, input: NotificationInput): void {
  try {
    if (input.dedupeKey) {
      const existing = db
        .prepare('SELECT id FROM notifications WHERE user_id = ? AND dedupe_key = ?')
        .get(input.userId, input.dedupeKey) as { id: number } | undefined;
      if (existing) {
        db.prepare('UPDATE notifications SET title = ?, body = ?, severity = ?, read_at = NULL, created_at = ? WHERE id = ?').run(
          input.title,
          input.body ?? null,
          input.severity ?? 'info',
          nowIso(),
          existing.id,
        );
        return;
      }
    }
    db.prepare(
      `INSERT INTO notifications (institution_id, user_id, type, title, body, link, severity, dedupe_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      input.institutionId ?? null,
      input.userId,
      input.type,
      input.title,
      input.body ?? null,
      input.link ?? null,
      input.severity ?? 'info',
      input.dedupeKey ?? null,
      nowIso(),
    );
  } catch (error) {
    // A notification must never break the underlying business transaction.
    // eslint-disable-next-line no-console
    console.error('[notifications] failed to create', input.type, error);
  }
}

export function notifyMany(db: Db, userIds: number[], build: (userId: number) => NotificationInput): void {
  for (const userId of userIds) {
    createNotification(db, build(userId));
  }
}

export function userIdsForClass(db: Db, classId: number): number[] {
  const rows = db
    .prepare(
      `SELECT u.id FROM students s
         JOIN users u ON u.id = s.user_id
        WHERE s.class_id = ? AND s.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL`,
    )
    .all(classId) as { id: number }[];
  return rows.map((r) => r.id);
}

export function userIdsForGroup(db: Db, groupId: number): number[] {
  const rows = db
    .prepare(
      `SELECT u.id FROM group_members gm
         JOIN students s ON s.id = gm.student_id
         JOIN users u ON u.id = s.user_id
        WHERE gm.group_id = ? AND s.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL`,
    )
    .all(groupId) as { id: number }[];
  return rows.map((r) => r.id);
}

export function userIdForStudent(db: Db, studentId: number): number | null {
  const row = db.prepare('SELECT user_id FROM students WHERE id = ?').get(studentId) as
    | { user_id: number }
    | undefined;
  return row?.user_id ?? null;
}
