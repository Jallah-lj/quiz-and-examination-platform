/**
 * Seed integrity.
 *
 * Demonstration data must be producible by the application itself: a seeded submission that
 * sits in a state the API cannot create teaches the dashboards to report a fault (the
 * "submissions with no result recorded" warning) that never exists in real use. These tests
 * pin the invariants the seed now shares with the submission and grading code paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './index';
import { createTestDatabase } from './index';
import { syncRolesAndPermissions } from './bootstrap';
import { seedDatabase } from './seed';

let db: Db;

const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;

beforeEach(() => {
  db = createTestDatabase();
  syncRolesAndPermissions(db);
});

afterEach(() => {
  db.close();
});

describe('seed integrity', () => {
  it('records a result for every submission it creates', async () => {
    const seeded = await seedDatabase(db);

    expect(seeded.counts.attempts).toBeGreaterThan(0);
    expect(seeded.counts.results).toBe(seeded.counts.attempts);
    // The dashboard's integrity warning is driven by exactly this query.
    expect(
      count(
        `SELECT COUNT(*) AS c FROM attempts a LEFT JOIN results r ON r.attempt_id = a.id WHERE r.id IS NULL`,
      ),
    ).toBe(0);
  });

  it('seeds written work for the marking queue without inventing impossible states', async () => {
    const seeded = await seedDatabase(db);
    const inReview = count(`SELECT COUNT(*) AS c FROM attempts WHERE status = 'UNDER_REVIEW'`);

    expect(count(`SELECT COUNT(*) AS c FROM questions WHERE type IN ('SHORT_ANSWER','ESSAY')`)).toBeGreaterThan(0);
    expect(inReview).toBeGreaterThan(0);
    expect(seeded.counts.awaiting_marking).toBe(inReview);

    // Every submission in review is waiting on real, unmarked written answers...
    expect(
      count(
        `SELECT COUNT(*) AS c FROM attempt_questions aq
           JOIN attempts a ON a.id = aq.attempt_id
           LEFT JOIN answers an ON an.attempt_id = aq.attempt_id AND an.question_id = aq.question_id
          WHERE a.status = 'UNDER_REVIEW' AND aq.is_objective = 0
            AND (an.id IS NULL OR an.awarded_marks IS NULL)`,
      ),
    ).toBeGreaterThan(0);
    // ...and each one holds a pending, unpublished result, exactly as `submit` leaves it.
    expect(
      count(`SELECT COUNT(*) AS c FROM results WHERE outcome = 'PENDING' AND is_published = 0`),
    ).toBe(inReview);

    // A released result is final: nothing published may still have unmarked written work.
    expect(
      count(
        `SELECT COUNT(*) AS c FROM results r
          WHERE r.is_published = 1
            AND EXISTS (
              SELECT 1 FROM attempt_questions aq
                LEFT JOIN answers an ON an.attempt_id = aq.attempt_id AND an.question_id = aq.question_id
               WHERE aq.attempt_id = r.attempt_id AND aq.is_objective = 0
                 AND (an.id IS NULL OR an.awarded_marks IS NULL))`,
      ),
    ).toBe(0);

    // A paper that has not started cannot have been sat.
    expect(
      count(
        `SELECT COUNT(*) AS c FROM attempts a
           JOIN exams e ON e.id = a.exam_id
          WHERE e.status = 'SCHEDULED'`,
      ),
    ).toBe(0);
  });

  it('grades every objective answer through the application scoring path', async () => {
    await seedDatabase(db);

    // Nothing objective is left unmarked...
    expect(
      count(
        `SELECT COUNT(*) AS c FROM answers an
           JOIN attempt_questions aq ON aq.attempt_id = an.attempt_id AND aq.question_id = an.question_id
          WHERE aq.is_objective = 1 AND an.awarded_marks IS NULL`,
      ),
    ).toBe(0);
    // ...and attempts carry the mark totals `submit` writes (obtained, not paper maximum).
    expect(count('SELECT COUNT(*) AS c FROM attempts WHERE total_marks != obtained_marks')).toBe(0);
    expect(
      count(
        `SELECT COUNT(*) AS c FROM attempts
          WHERE status = 'GRADED' AND (percentage IS NULL OR grade IS NULL)`,
      ),
    ).toBe(0);
  });
});
