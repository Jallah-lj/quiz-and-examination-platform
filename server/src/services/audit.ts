import type { Db } from '../db';
import { nowIso } from '../lib/time';

export interface AuditInput {
  institutionId?: number | null;
  userId?: number | null;
  actorName?: string | null;
  actorRole?: string | null;
  action: string;
  category?: string;
  resourceType?: string | null;
  resourceId?: string | number | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Never throws: an audit failure must not break the primary operation. */
export function recordAudit(db: Db, input: AuditInput): void {
  try {
    db.prepare(
      `INSERT INTO audit_logs
        (institution_id, user_id, actor_name, actor_role, action, category, resource_type,
         resource_id, description, metadata, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.institutionId ?? null,
      input.userId ?? null,
      input.actorName ?? null,
      input.actorRole ?? null,
      input.action,
      input.category ?? input.action.split('.')[0] ?? 'general',
      input.resourceType ?? null,
      input.resourceId === null || input.resourceId === undefined ? null : String(input.resourceId),
      input.description ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.ip ?? null,
      input.userAgent ?? null,
      nowIso(),
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[audit] failed to record entry', input.action, error);
  }
}

export const AUDIT_CATEGORIES = [
  'auth',
  'exam',
  'question',
  'result',
  'grading',
  'user',
  'institution',
  'settings',
  'academic',
  'platform',
] as const;
