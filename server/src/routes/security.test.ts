/**
 * Security-focused tests: tenant isolation, token handling, privilege escalation,
 * injection attempts, rate limiting and response hygiene.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Db } from '../db';
import { buildHarness, type Fixture, type Harness } from '../test-utils/harness';
import { createRateLimiter } from '../middleware/security';
import { errorHandler } from '../middleware/errors';
import { addMinutes, nowIso } from '../lib/time';

let harness: Harness;
let db: Db;
let fixture: Fixture;

beforeEach(() => {
  harness = buildHarness();
  db = harness.db;
  fixture = harness.fixture;
});

afterEach(() => {
  db.close();
});

describe('tenant isolation', () => {
  it('never returns another institution candidates through search', async () => {
    const admin = await harness.login('admin@alpha.test');
    const response = await admin.get('/api/students?pageSize=100');
    expect(response.status).toBe(200);
    const codes = response.body.data.map((student: any) => student.student_code);
    expect(codes).toContain('S-001');
    expect(codes).not.toContain('B-001');
  });

  it('refuses cross-institution reads by direct identifier', async () => {
    const betaStudent = await harness.login('student@beta.test');
    const attempt = await betaStudent.post('/api/attempts').send({ examId: fixture.examId });
    expect(attempt.status).toBe(403);

    const result = await betaStudent.get(`/api/results/1`);
    expect([403, 404]).toContain(result.status);
  });

  it('stops an institution administrator from editing another institution', async () => {
    const admin = await harness.login('admin@alpha.test');
    const response = await admin
      .patch(`/api/institutions/${fixture.otherInstitutionId}`)
      .send({ name: 'Hijacked Institute' });
    expect(response.status).toBe(403);
  });

  it('scopes a teacher dashboard to their own institution', async () => {
    const teacher = await harness.login('teacher@alpha.test');
    const dashboard = await teacher.get('/api/dashboard/teacher');
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data.scope.institutionId).toBe(fixture.institutionId);

    const betaExams = await teacher.get(`/api/examinations/${fixture.examId}`);
    expect(betaExams.status).toBe(200); // own institution
  });

  it('prevents a candidate listing another candidate attempts', async () => {
    const sam = await harness.login('student@alpha.test');
    await sam.post('/api/attempts').send({ examId: fixture.examId });

    const sara = await harness.login('student2@alpha.test');
    const list = await sara.get('/api/attempts');
    expect(list.body.data).toHaveLength(0);
    expect(list.body.meta.total).toBe(0);
  });
});

describe('session and token handling', () => {
  it('rejects a forged session cookie', async () => {
    const response = await request(harness.app)
      .get('/api/auth/me')
      .set('Cookie', 'examsys_session=forged-token-value');
    expect(response.status).toBe(200);
    expect(response.body.data.authenticated).toBe(false);
  });

  it('rejects an invalid bearer token', async () => {
    const response = await request(harness.app)
      .get('/api/students')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(response.status).toBe(401);
  });

  it('issues a bearer session token alongside the cookie when the transport is enabled', async () => {
    const login = await request(harness.app)
      .post('/api/auth/login')
      .send({ email: 'admin@alpha.test', password: 'Test-Password1' });
    expect(login.status).toBe(200);

    // The cookie stays the primary transport...
    expect(login.headers['set-cookie']?.join(';')).toMatch(/examsys_session=/);
    // ...and the token is offered as well (enabled outside production).
    expect(login.body.data.tokenTransport).toBe('bearer');
    expect(typeof login.body.data.sessionToken).toBe('string');
    expect(login.body.data.sessionToken.length).toBeGreaterThan(20);

    // The raw token is never stored: only its hash reaches the database.
    const stored = db.prepare('SELECT token_hash FROM sessions ORDER BY id DESC LIMIT 1').get() as {
      token_hash: string;
    };
    expect(stored.token_hash).not.toBe(login.body.data.sessionToken);
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);

    // No other endpoint hands out session tokens.
    const agent = await harness.login('admin@alpha.test');
    const me = await agent.get('/api/auth/me');
    expect(me.body.data.sessionToken).toBeUndefined();
  });

  it('authenticates cookie-less clients through the bearer transport and still enforces CSRF', async () => {
    const login = await request(harness.app)
      .post('/api/auth/login')
      .set('X-Session-Transport', 'bearer')
      .send({ email: 'admin@alpha.test', password: 'Test-Password1' });
    const token = login.body.data.sessionToken as string;
    const csrf = login.body.data.csrfToken as string;

    // No cookie jar at all: the session must still resolve.
    const me = await request(harness.app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.data.authenticated).toBe(true);
    expect(me.body.data.user.email).toBe('admin@alpha.test');

    const dashboard = await request(harness.app)
      .get('/api/dashboard/admin')
      .set('Authorization', `Bearer ${token}`);
    expect(dashboard.status).toBe(200);

    // State-changing requests over the token transport still need the CSRF token.
    const withoutCsrf = await request(harness.app)
      .post('/api/subjects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Token Transport', code: 'TT-1' });
    expect(withoutCsrf.status).toBe(403);

    const withCsrf = await request(harness.app)
      .post('/api/subjects')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrf)
      .send({ name: 'Token Transport', code: 'TT-1' });
    expect(withCsrf.status).toBe(201);
  });

  it('accepts the session token from the fallback header when Authorization is stripped', async () => {
    // Some proxies (sandbox/preview gateways) drop `Authorization` but forward custom
    // headers, so the same credential must be accepted from either position.
    const login = await request(harness.app)
      .post('/api/auth/login')
      .send({ email: 'admin@alpha.test', password: 'Test-Password1' });
    const token = login.body.data.sessionToken as string;

    const me = await request(harness.app).get('/api/auth/me').set('X-Session-Token', token);
    expect(me.body.data.authenticated).toBe(true);
    expect(me.body.data.user.email).toBe('admin@alpha.test');

    const confused = await request(harness.app).get('/api/auth/me').set('X-Session-Token', 'not-a-session');
    expect(confused.body.data.authenticated).toBe(false);

    // The fallback header is a session transport, not a CSRF bypass.
    const withoutCsrf = await request(harness.app)
      .post('/api/subjects')
      .set('X-Session-Token', token)
      .send({ name: 'Fallback Transport', code: 'FT-1' });
    expect(withoutCsrf.status).toBe(403);
  });

  it('reports whether a client presented no session or a rejected one', async () => {
    const anonymous = await request(harness.app).get('/api/auth/me');
    expect(anonymous.body.data).toMatchObject({ authenticated: false, sessionStatus: 'none' });

    const stale = await request(harness.app).get('/api/auth/me').set('X-Session-Token', 'stale-token-value');
    expect(stale.body.data).toMatchObject({ authenticated: false, sessionStatus: 'unresolved' });

    const agent = await harness.login('student@alpha.test');
    const valid = await agent.get('/api/auth/me');
    expect(valid.body.data).toMatchObject({ authenticated: true, sessionStatus: 'valid' });
  });

  it('prefers a valid bearer token when the cookie is stale', async () => {
    const login = await request(harness.app)
      .post('/api/auth/login')
      .set('X-Session-Transport', 'bearer')
      .send({ email: 'admin@alpha.test', password: 'Test-Password1' });
    const token = login.body.data.sessionToken as string;

    const response = await request(harness.app)
      .get('/api/auth/me')
      .set('Cookie', 'examsys_session=stale-cookie-value')
      .set('Authorization', `Bearer ${token}`);
    expect(response.body.data.authenticated).toBe(true);
  });

  it('invalidates the session when the account is suspended', async () => {
    const student = await harness.login('student@alpha.test');
    expect((await student.get('/api/auth/me')).body.data.authenticated).toBe(true);

    const admin = await harness.login('admin@alpha.test');
    const suspended = await admin
      .post(`/api/users/${fixture.studentUserId}/status`)
      .send({ status: 'suspended' });
    expect(suspended.status).toBe(200);

    const afterSuspension = await student.get('/api/auth/me');
    expect(afterSuspension.body.data.authenticated).toBe(false);
  });

  it('rejects an expired session', async () => {
    const student = await harness.login('student@alpha.test');
    db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(addMinutes(nowIso(), -1), fixture.studentUserId);
    const response = await student.get('/api/auth/me');
    expect(response.body.data.authenticated).toBe(false);
  });

  it('lets a user revoke one of their own sessions', async () => {
    const agent = await harness.login('student@alpha.test');
    // A second sign-in creates a second session.
    await request(harness.app)
      .post('/api/auth/login')
      .send({ email: 'student@alpha.test', password: 'Test-Password1' });

    const sessions = await agent.get('/api/auth/sessions');
    expect(sessions.status).toBe(200);
    expect(sessions.body.data.length).toBeGreaterThanOrEqual(2);

    const other = sessions.body.data.find((session: any) => !session.current);
    const revoke = await agent.delete(`/api/auth/sessions/${other.id}`);
    expect(revoke.status).toBe(200);

    const current = sessions.body.data.find((session: any) => session.current);
    const revokeCurrent = await agent.delete(`/api/auth/sessions/${current.id}`);
    expect(revokeCurrent.status).toBe(403);
  });

  it('does not reveal whether an email address exists on password reset', async () => {
    const known = await harness.agent().post('/api/auth/forgot-password').send({ email: 'student@alpha.test' });
    const unknown = await harness.agent().post('/api/auth/forgot-password').send({ email: 'ghost@alpha.test' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body.data.message).toBe(known.body.data.message);
    expect(unknown.body.data.resetToken).toBeUndefined();
  });

  it('refuses to reset a password with an expired token', async () => {
    const request1 = await harness.agent().post('/api/auth/forgot-password').send({ email: 'student@alpha.test' });
    const token = request1.body.data.resetToken as string;
    db.prepare('UPDATE password_resets SET expires_at = ? WHERE user_id = ?').run(
      addMinutes(nowIso(), -1),
      fixture.studentUserId,
    );
    const response = await harness
      .agent()
      .post('/api/auth/reset-password')
      .send({ token, password: 'Whatever-Pass1' });
    expect(response.status).toBe(422);
  });

  it('prevents an administrator from deactivating their own account', async () => {
    const admin = await harness.login('admin@alpha.test');
    const response = await admin.post(`/api/users/${fixture.adminUserId}/status`).send({ status: 'disabled' });
    expect(response.status).toBe(422);
  });
});

describe('privilege escalation attempts', () => {
  it('ignores a role supplied by the client when creating an account', async () => {
    const admin = await harness.login('admin@alpha.test');
    const response = await admin.post('/api/users').send({
      fullName: 'Sneaky Admin',
      email: 'sneaky@alpha.test',
      role: 'super_admin',
    });
    expect(response.status).toBe(403);
    const created = db.prepare("SELECT COUNT(*) AS c FROM users WHERE email = 'sneaky@alpha.test'").get() as {
      c: number;
    };
    expect(created.c).toBe(0);
  });

  it('refuses to modify system role permissions', async () => {
    const admin = await harness.login('platform@examsys.test');
    const roleId = (db.prepare("SELECT id FROM roles WHERE code = 'student'").get() as { id: number }).id;
    const response = await admin.put(`/api/users/roles/${roleId}/permissions`).send({
      permissions: ['user.create', 'exam.create', 'platform.manage'],
    });
    expect(response.status).toBe(403);

    const granted = db
      .prepare(
        `SELECT COUNT(*) AS c FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = ? AND p.code = 'platform.manage'`,
      )
      .get(roleId) as { c: number };
    expect(granted.c).toBe(0);
  });

  it('rejects unknown permission codes', async () => {
    const admin = await harness.login('platform@examsys.test');
    const roleId = Number(
      db
        .prepare(
          `INSERT INTO roles (code, name, description, scope, is_system, created_at)
           VALUES ('custom_marker', 'Custom Marker', 'Custom role', 'institution', 0, ?)`,
        )
        .run(nowIso()).lastInsertRowid,
    );
    const response = await admin.put(`/api/users/roles/${roleId}/permissions`).send({
      permissions: ['grading.grade', 'not.a.permission'],
    });
    expect(response.status).toBe(422);
  });

  it('rejects a supervisor attempting to grade a paper they do not own', async () => {
    const otherTeacher = db.prepare("SELECT id FROM users WHERE email = 'teacher2@alpha.test'").get() as {
      id: number;
    };
    db.prepare('UPDATE exams SET created_by = ? WHERE id = ?').run(otherTeacher.id, fixture.examId);

    const student = await harness.login('student@alpha.test');
    const start = await student.post('/api/attempts').send({ examId: fixture.examId });
    const attemptId = start.body.data.attemptId as number;
    await student.post(`/api/attempts/${attemptId}/submit`).send({});

    const teacher = await harness.login('teacher@alpha.test');
    const response = await teacher.get(`/api/grading/attempts/${attemptId}`);
    expect(response.status).toBe(403);

    const admin = await harness.login('admin@alpha.test');
    const allowed = await admin.get(`/api/grading/attempts/${attemptId}`);
    expect(allowed.status).toBe(200);
  });
});

describe('input handling', () => {
  it('treats SQL metacharacters as literal search text', async () => {
    const admin = await harness.login('admin@alpha.test');
    const response = await admin.get("/api/students?q=' OR 1=1 --");
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
    // The table still exists and returns data for a legitimate search.
    const legit = await admin.get('/api/students?q=Sam');
    expect(legit.body.data.length).toBeGreaterThan(0);
  });

  it('escapes script content instead of executing it', async () => {
    const teacher = await harness.login('teacher@alpha.test');
    const created = await teacher.post('/api/questions').send({
      questionBankId: fixture.bankId,
      subjectId: fixture.subjectId,
      type: 'MCQ',
      text: '<script>alert("xss")</script> What is 2 + 2?',
      marks: 2,
      options: [
        { label: 'A', text: '4', isCorrect: true },
        { label: 'B', text: '5', isCorrect: false },
      ],
    });
    expect(created.status).toBe(201);
    // Content is stored verbatim and rendered as text by the client (React escapes by default).
    expect(created.body.data.text).toContain('<script>');
  });

  it('rejects an oversized payload', async () => {
    const admin = await harness.login('admin@alpha.test');
    const response = await admin.post('/api/questions').send({
      questionBankId: fixture.bankId,
      subjectId: fixture.subjectId,
      type: 'ESSAY',
      text: 'x'.repeat(20000),
      marks: 2,
    });
    expect(response.status).toBe(422);
  });

  it('validates numeric and date fields', async () => {
    const teacher = await harness.login('teacher@alpha.test');
    const response = await teacher.post('/api/examinations').send({
      subjectId: fixture.subjectId,
      name: 'Bad numeric exam',
      code: 'BAD-NUM',
      academicYear: '2025/2026',
      examType: 'FINAL',
      durationMinutes: -5,
      startAt: 'not-a-date',
      endAt: 'also-not-a-date',
      passMarks: 10,
      maxAttempts: 0,
      questions: [],
    });
    expect(response.status).toBe(422);
  });
});

describe('rate limiting', () => {
  it('blocks requests beyond the configured ceiling', async () => {
    const app = express();
    app.use(
      createRateLimiter({
        windowMs: 60_000,
        max: 3,
        keyPrefix: 'test',
        respectTestMode: false,
        message: 'Too many requests.',
      }),
    );
    app.get('/limited', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    for (let i = 0; i < 3; i += 1) {
      const allowed = await request(app).get('/limited');
      expect(allowed.status).toBe(200);
    }
    const blocked = await request(app).get('/limited');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});

describe('response hygiene', () => {
  it('sets hardening headers', async () => {
    const response = await request(harness.app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('never lets an API response be cached or revalidated', async () => {
    const response = await request(harness.app).get('/api/health');
    expect(response.headers['cache-control']).toContain('no-store');

    // A signed-in client must never receive a replayed body from an unauthenticated call.
    const first = await request(harness.app).get('/api/auth/me');
    expect(first.headers['cache-control']).toContain('no-store');
    expect(first.headers.etag).toBeUndefined();

    const agent = await harness.login('student@alpha.test');
    const second = await agent.get('/api/auth/me').set('If-None-Match', 'W/"stale-etag"');
    expect(second.status).toBe(200);
    expect(second.body.data.authenticated).toBe(true);
  });

  it('never returns password hashes or tokens', async () => {
    const admin = await harness.login('admin@alpha.test');
    const list = await admin.get('/api/users');
    const serialized = JSON.stringify(list.body);
    expect(serialized).not.toMatch(/password_hash/);
    expect(serialized).not.toMatch(/token_hash/);
    expect(serialized).not.toMatch(/\$2[aby]\$/);

    const me = await admin.get('/api/auth/me');
    expect(JSON.stringify(me.body)).not.toMatch(/password_hash|\$2[aby]\$/);
  });

  it('returns a consistent error envelope', async () => {
    const response = await request(harness.app).get('/api/unknown-route');
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'The requested endpoint does not exist.' },
    });
  });
});
