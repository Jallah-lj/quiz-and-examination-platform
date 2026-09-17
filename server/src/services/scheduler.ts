/**
 * Scheduled maintenance jobs. Keeping them in-process avoids extra infrastructure
 * for a single-node deployment; each job is idempotent so a restart is harmless.
 */
import type { Db } from '../db';
import { expireAttempts, ensureExamIsOpen, ensureQuizIsOpen } from '../services/attempts';
import { addHours, nowIso } from '../lib/time';
import { createNotification, userIdForStudent } from '../services/notifications';

export interface SchedulerHandle {
  stop: () => void;
}

export function startScheduler(db: Db, options: { intervalMs?: number; onRun?: (summary: SchedulerSummary) => void } = {}) {
  const intervalMs = options.intervalMs ?? 30_000;

  const tick = (): SchedulerSummary => {
    const now = nowIso();
    const summary: SchedulerSummary = {
      at: now,
      attemptsExpired: 0,
      examsActivated: 0,
      quizzesActivated: 0,
      remindersSent: 0,
    };

    try {
      // 1. Auto-submit attempts whose server-side time is exhausted.
      const expired = expireAttempts(db);
      summary.attemptsExpired = expired.expired;

      // 2. Open scheduled examinations whose window has started.
      const startingExams = db
        .prepare("SELECT id FROM exams WHERE status = 'SCHEDULED' AND start_at <= ? AND end_at > ?")
        .all(now, now) as { id: number }[];
      for (const exam of startingExams) {
        ensureExamIsOpen(db, exam.id, now);
      }
      summary.examsActivated = startingExams.length;

      // 3. Open / close quizzes on their availability window.
      const quizzes = db
        .prepare("SELECT id FROM quizzes WHERE status IN ('SCHEDULED','ACTIVE')")
        .all() as { id: number }[];
      for (const quiz of quizzes) {
        ensureQuizIsOpen(db, quiz.id, now);
      }
      summary.quizzesActivated = quizzes.length;

      // 4. Release results whose publication time has arrived.
      const dueResults = db
        .prepare(
          `SELECT r.id, r.student_id, r.institution_id, COALESCE(e.name, qz.title) AS paper,
                  COALESCE(e.result_release_at, qz.result_release_at) AS release_at
             FROM results r
             LEFT JOIN exams e ON e.id = r.exam_id
             LEFT JOIN quizzes qz ON qz.id = r.quiz_id
            WHERE r.is_published = 0
              AND COALESCE(e.result_release_at, qz.result_release_at) IS NOT NULL
              AND COALESCE(e.result_release_at, qz.result_release_at) <= ?
              AND r.outcome != 'PENDING'`,
        )
        .all(now) as { id: number; student_id: number; institution_id: number; paper: string }[];

      for (const result of dueResults) {
        db.prepare('UPDATE results SET is_published = 1, published_at = ?, updated_at = ? WHERE id = ?').run(
          now,
          now,
          result.id,
        );
        const userId = userIdForStudent(db, result.student_id);
        if (userId) {
          createNotification(db, {
            institutionId: result.institution_id,
            userId,
            type: 'result_published',
            title: 'Result published',
            body: `Your result for "${result.paper}" has been released.`,
            link: '/student/results',
            severity: 'success',
            dedupeKey: `result_published:result:${result.id}`,
          });
        }
      }
      summary.remindersSent = dueResults.length;

      // 5. Stamp exam reminders once a paper is within 24 hours of opening.
      const soon = db
        .prepare("SELECT id FROM exams WHERE status = 'SCHEDULED' AND start_at <= ? AND start_at > ?")
        .all(addHours(now, 24), now) as { id: number }[];
      for (const exam of soon) {
        const assignments = db
          .prepare('SELECT class_id, group_id, student_id FROM exam_assignments WHERE exam_id = ?')
          .all(exam.id) as { class_id: number | null; group_id: number | null; student_id: number | null }[];
        const examRow = db
          .prepare('SELECT name, start_at, institution_id FROM exams WHERE id = ?')
          .get(exam.id) as { name: string; start_at: string; institution_id: number };
        const recipients = new Set<number>();
        for (const assignment of assignments) {
          if (assignment.class_id) {
            const rows = db
              .prepare(
                `SELECT u.id FROM students s JOIN users u ON u.id = s.user_id
                  WHERE s.class_id = ? AND s.status = 'active'`,
              )
              .all(assignment.class_id) as { id: number }[];
            rows.forEach((row) => recipients.add(row.id));
          }
          if (assignment.group_id) {
            const rows = db
              .prepare(
                `SELECT u.id FROM group_members gm JOIN students s ON s.id = gm.student_id
                   JOIN users u ON u.id = s.user_id WHERE gm.group_id = ?`,
              )
              .all(assignment.group_id) as { id: number }[];
            rows.forEach((row) => recipients.add(row.id));
          }
          if (assignment.student_id) {
            const userId = userIdForStudent(db, assignment.student_id);
            if (userId) recipients.add(userId);
          }
        }
        for (const userId of recipients) {
          createNotification(db, {
            institutionId: examRow.institution_id,
            userId,
            type: 'exam_reminder',
            title: 'Examination starting soon',
            body: `"${examRow.name}" opens on ${new Date(examRow.start_at).toUTCString()}.`,
            link: '/student/examinations',
            severity: 'warning',
            dedupeKey: `exam_reminder:${exam.id}`,
          });
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[scheduler] tick failed', error);
    }

    options.onRun?.(summary);
    return summary;
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  // Run once shortly after boot so state is consistent even after downtime.
  setTimeout(tick, 1_000).unref?.();

  return { stop: () => clearInterval(timer) };
}

export interface SchedulerSummary {
  at: string;
  attemptsExpired: number;
  examsActivated: number;
  quizzesActivated: number;
  remindersSent: number;
}
