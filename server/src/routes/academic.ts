import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, created, ok, okList } from '../lib/http';
import { conflict, forbidden, notFound, validationError } from '../lib/errors';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import { recordAudit } from '../services/audit';
import { nowIso } from '../lib/time';

function scope(req: AuthedRequest): number {
  if (req.user!.roleCode === 'super_admin') return -1;
  if (!req.user!.institutionId) throw forbidden('You are not attached to an institution.');
  return req.user!.institutionId;
}

function auditMeta(req: AuthedRequest) {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------
export const departmentsRouter = Router();
departmentsRouter.use(requireAuth);

departmentsRouter.get(
  '/',
  requirePermission('class.view', 'department.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope(req) !== -1) {
      where.push('d.institution_id = ?');
      params.push(scope(req));
    }
    if (query.q) {
      where.push('(d.name LIKE ? OR d.code LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    if (req.query.status) {
      where.push('d.status = ?');
      params.push(String(req.query.status));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM departments d ${whereSql}`).get(...params) as { c: number }).c;
    const items = db
      .prepare(
        `SELECT d.*, i.name AS institution_name, u.full_name AS head_name,
                (SELECT COUNT(*) FROM classes c WHERE c.department_id = d.id) AS class_count,
                (SELECT COUNT(*) FROM subjects s WHERE s.department_id = d.id) AS subject_count,
                (SELECT COUNT(*) FROM teachers t WHERE t.department_id = d.id) AS teacher_count
           FROM departments d
           JOIN institutions i ON i.id = d.institution_id
           LEFT JOIN users u ON u.id = d.head_user_id
           ${whereSql}
          ORDER BY d.name ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);
    return okList(res, paginate(items, { page: query.page, pageSize: query.pageSize, total }));
  }),
);

departmentsRouter.post(
  '/',
  requirePermission('department.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        name: z.string().trim().min(2).max(160),
        code: z.string().trim().min(1).max(20),
        description: z.string().trim().max(500).optional().nullable(),
        headUserId: z.coerce.number().int().positive().optional().nullable(),
        institutionId: z.coerce.number().int().positive().optional(),
      }),
      req.body,
    );
    const db = getDb();
    const institutionId = req.user!.roleCode === 'super_admin' ? body.institutionId ?? -1 : scope(req);
    if (institutionId === -1) throw validationError('Specify the institution for this department.');
    const existing = db
      .prepare('SELECT id FROM departments WHERE institution_id = ? AND UPPER(code) = ?')
      .get(institutionId, body.code.toUpperCase());
    if (existing) throw conflict('A department with this code already exists.');

    const info = db
      .prepare(
        `INSERT INTO departments (institution_id, name, code, description, head_user_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(institutionId, body.name.trim(), body.code.toUpperCase(), body.description ?? null, body.headUserId ?? null, nowIso(), nowIso());

    recordAudit(db, {
      institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'department.created',
      category: 'academic',
      resourceType: 'department',
      resourceId: Number(info.lastInsertRowid),
      description: `Created department ${body.name}`,
      ...auditMeta(req),
    });
    return created(res, db.prepare('SELECT * FROM departments WHERE id = ?').get(Number(info.lastInsertRowid)));
  }),
);

departmentsRouter.patch(
  '/:id',
  requirePermission('department.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const body = parseWith(
      z
        .object({
          name: z.string().trim().min(2).max(160).optional(),
          description: z.string().trim().max(500).optional().nullable(),
          headUserId: z.coerce.number().int().positive().nullable().optional(),
          status: z.enum(['active', 'archived']).optional(),
        })
        .strict(),
      req.body,
    );
    const existing = db.prepare('SELECT * FROM departments WHERE id = ?').get(id) as any;
    if (!existing) throw notFound('Department not found.');
    if (scope(req) !== -1 && existing.institution_id !== scope(req)) throw notFound('Department not found.');

    db.prepare(
      `UPDATE departments SET name = ?, description = ?, head_user_id = ?, status = ?, updated_at = ? WHERE id = ?`,
    ).run(
      body.name ?? existing.name,
      body.description === undefined ? existing.description : body.description,
      body.headUserId === undefined ? existing.head_user_id : body.headUserId,
      body.status ?? existing.status,
      nowIso(),
      id,
    );
    recordAudit(db, {
      institutionId: existing.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'department.updated',
      category: 'academic',
      resourceType: 'department',
      resourceId: id,
      description: `Updated department ${body.name ?? existing.name}`,
      ...auditMeta(req),
    });
    return ok(res, db.prepare('SELECT * FROM departments WHERE id = ?').get(id));
  }),
);

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------
export const classesRouter = Router();
classesRouter.use(requireAuth);

classesRouter.get(
  '/',
  requirePermission('class.view', 'class.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope(req) !== -1) {
      where.push('c.institution_id = ?');
      params.push(scope(req));
    }
    if (req.query.departmentId) {
      where.push('c.department_id = ?');
      params.push(Number(req.query.departmentId));
    }
    if (req.query.academicYear) {
      where.push('c.academic_year = ?');
      params.push(String(req.query.academicYear));
    }
    if (req.query.status) {
      where.push('c.status = ?');
      params.push(String(req.query.status));
    }
    if (query.q) {
      where.push('(c.name LIKE ? OR c.code LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM classes c ${whereSql}`).get(...params) as { c: number }).c;
    const items = db
      .prepare(
        `SELECT c.*, d.name AS department_name, u.full_name AS class_teacher_name,
                (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.status = 'active') AS student_count,
                (SELECT COUNT(*) FROM exams e WHERE e.class_id = c.id) AS exam_count
           FROM classes c
           LEFT JOIN departments d ON d.id = c.department_id
           LEFT JOIN users u ON u.id = c.class_teacher_id
           ${whereSql}
          ORDER BY c.academic_year DESC, c.name ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);
    return okList(res, paginate(items, { page: query.page, pageSize: query.pageSize, total }));
  }),
);

classesRouter.post(
  '/',
  requirePermission('class.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        name: z.string().trim().min(1).max(120),
        code: z.string().trim().min(1).max(30),
        level: z.string().trim().max(60).optional().nullable(),
        academicYear: z.string().trim().min(4).max(20),
        departmentId: z.coerce.number().int().positive().optional().nullable(),
        classTeacherId: z.coerce.number().int().positive().optional().nullable(),
        capacity: z.coerce.number().int().positive().max(1000).optional().nullable(),
        room: z.string().trim().max(60).optional().nullable(),
        institutionId: z.coerce.number().int().positive().optional(),
      }),
      req.body,
    );
    const db = getDb();
    const institutionId = req.user!.roleCode === 'super_admin' ? body.institutionId ?? -1 : scope(req);
    if (institutionId === -1) throw validationError('Specify the institution for this class.');
    if (body.departmentId) {
      const dept = db
        .prepare('SELECT id FROM departments WHERE id = ? AND institution_id = ?')
        .get(body.departmentId, institutionId);
      if (!dept) throw validationError('The selected department does not belong to this institution.');
    }
    const duplicate = db
      .prepare('SELECT id FROM classes WHERE institution_id = ? AND UPPER(code) = ? AND academic_year = ?')
      .get(institutionId, body.code.toUpperCase(), body.academicYear);
    if (duplicate) throw conflict('A class with this code already exists for the selected academic year.');

    const info = db
      .prepare(
        `INSERT INTO classes (institution_id, department_id, name, code, level, academic_year, class_teacher_id,
                              capacity, room, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        institutionId,
        body.departmentId ?? null,
        body.name.trim(),
        body.code.toUpperCase(),
        body.level ?? null,
        body.academicYear,
        body.classTeacherId ?? null,
        body.capacity ?? null,
        body.room ?? null,
        nowIso(),
        nowIso(),
      );
    recordAudit(db, {
      institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'class.created',
      category: 'academic',
      resourceType: 'class',
      resourceId: Number(info.lastInsertRowid),
      description: `Created class ${body.name} (${body.academicYear})`,
      ...auditMeta(req),
    });
    return created(res, db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(info.lastInsertRowid)));
  }),
);

classesRouter.get(
  '/:id',
  requirePermission('class.view', 'class.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const klass = db.prepare('SELECT * FROM classes WHERE id = ?').get(id) as any;
    if (!klass) throw notFound('Class not found.');
    if (scope(req) !== -1 && klass.institution_id !== scope(req)) throw notFound('Class not found.');

    const students = db
      .prepare(
        `SELECT s.id, s.student_code, s.status, u.full_name, u.email
           FROM students s JOIN users u ON u.id = s.user_id
          WHERE s.class_id = ? ORDER BY u.full_name`,
      )
      .all(id);
    const subjects = db
      .prepare(
        `SELECT cs.subject_id, sub.name, sub.code, cs.teacher_id, u.full_name AS teacher_name
           FROM class_subjects cs
           JOIN subjects sub ON sub.id = cs.subject_id
           LEFT JOIN teachers t ON t.id = cs.teacher_id
           LEFT JOIN users u ON u.id = t.user_id
          WHERE cs.class_id = ? ORDER BY sub.name`,
      )
      .all(id);
    const exams = db
      .prepare(
        `SELECT id, name, code, status, start_at, total_marks FROM exams WHERE class_id = ? ORDER BY start_at DESC LIMIT 20`,
      )
      .all(id);
    return ok(res, { class: klass, students, subjects, exams });
  }),
);

classesRouter.patch(
  '/:id',
  requirePermission('class.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const body = parseWith(
      z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          level: z.string().trim().max(60).optional().nullable(),
          departmentId: z.coerce.number().int().positive().nullable().optional(),
          classTeacherId: z.coerce.number().int().positive().nullable().optional(),
          capacity: z.coerce.number().int().positive().max(1000).nullable().optional(),
          room: z.string().trim().max(60).optional().nullable(),
          status: z.enum(['active', 'archived']).optional(),
        })
        .strict(),
      req.body,
    );
    const existing = db.prepare('SELECT * FROM classes WHERE id = ?').get(id) as any;
    if (!existing) throw notFound('Class not found.');
    if (scope(req) !== -1 && existing.institution_id !== scope(req)) throw notFound('Class not found.');

    db.prepare(
      `UPDATE classes SET name = ?, level = ?, department_id = ?, class_teacher_id = ?, capacity = ?, room = ?,
              status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      body.name ?? existing.name,
      body.level === undefined ? existing.level : body.level,
      body.departmentId === undefined ? existing.department_id : body.departmentId,
      body.classTeacherId === undefined ? existing.class_teacher_id : body.classTeacherId,
      body.capacity === undefined ? existing.capacity : body.capacity,
      body.room === undefined ? existing.room : body.room,
      body.status ?? existing.status,
      nowIso(),
      id,
    );
    recordAudit(db, {
      institutionId: existing.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'class.updated',
      category: 'academic',
      resourceType: 'class',
      resourceId: id,
      description: `Updated class ${existing.name}`,
      ...auditMeta(req),
    });
    return ok(res, db.prepare('SELECT * FROM classes WHERE id = ?').get(id));
  }),
);

classesRouter.post(
  '/:id/students',
  requirePermission('class.manage', 'student.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(z.object({ studentIds: z.array(z.coerce.number().int().positive()).min(1).max(500) }), req.body);
    const db = getDb();
    const id = Number(req.params.id);
    const klass = db.prepare('SELECT * FROM classes WHERE id = ?').get(id) as any;
    if (!klass) throw notFound('Class not found.');
    if (scope(req) !== -1 && klass.institution_id !== scope(req)) throw notFound('Class not found.');

    const update = db.prepare('UPDATE students SET class_id = ?, updated_at = ? WHERE id = ? AND institution_id = ?');
    let moved = 0;
    db.transaction(() => {
      for (const studentId of body.studentIds) {
        const result = update.run(id, nowIso(), studentId, klass.institution_id);
        moved += result.changes;
      }
    })();
    recordAudit(db, {
      institutionId: klass.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'class.students_enrolled',
      category: 'academic',
      resourceType: 'class',
      resourceId: id,
      description: `Enrolled ${moved} candidate(s) into ${klass.name}`,
      metadata: { studentIds: body.studentIds },
      ...auditMeta(req),
    });
    return ok(res, { enrolled: moved });
  }),
);

classesRouter.delete(
  '/:id/students/:studentId',
  requirePermission('class.manage', 'student.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const studentId = Number(req.params.studentId);
    const klass = db.prepare('SELECT * FROM classes WHERE id = ?').get(id) as any;
    if (!klass) throw notFound('Class not found.');
    if (scope(req) !== -1 && klass.institution_id !== scope(req)) throw notFound('Class not found.');
    db.prepare("UPDATE students SET class_id = NULL, updated_at = ? WHERE id = ? AND class_id = ?").run(
      nowIso(),
      studentId,
      id,
    );
    recordAudit(db, {
      institutionId: klass.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'class.student_removed',
      category: 'academic',
      resourceType: 'class',
      resourceId: id,
      description: `Removed candidate #${studentId} from ${klass.name}`,
      ...auditMeta(req),
    });
    return ok(res, { message: 'Candidate removed from class.' });
  }),
);

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------
export const subjectsRouter = Router();
subjectsRouter.use(requireAuth);

subjectsRouter.get(
  '/',
  requirePermission('subject.view', 'subject.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope(req) !== -1) {
      where.push('s.institution_id = ?');
      params.push(scope(req));
    }
    if (req.query.departmentId) {
      where.push('s.department_id = ?');
      params.push(Number(req.query.departmentId));
    }
    if (req.query.status) {
      where.push('s.status = ?');
      params.push(String(req.query.status));
    }
    if (query.q) {
      where.push('(s.name LIKE ? OR s.code LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM subjects s ${whereSql}`).get(...params) as { c: number }).c;
    const items = db
      .prepare(
        `SELECT s.*, d.name AS department_name,
                (SELECT COUNT(*) FROM questions q WHERE q.subject_id = s.id) AS question_count,
                (SELECT COUNT(*) FROM question_banks b WHERE b.subject_id = s.id) AS bank_count,
                (SELECT COUNT(*) FROM exams e WHERE e.subject_id = s.id) AS exam_count,
                (SELECT COUNT(*) FROM teacher_subjects ts WHERE ts.subject_id = s.id) AS teacher_count
           FROM subjects s
           LEFT JOIN departments d ON d.id = s.department_id
           ${whereSql}
          ORDER BY s.name ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);
    return okList(res, paginate(items, { page: query.page, pageSize: query.pageSize, total }));
  }),
);

subjectsRouter.post(
  '/',
  requirePermission('subject.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        name: z.string().trim().min(2).max(160),
        code: z.string().trim().min(1).max(20),
        description: z.string().trim().max(500).optional().nullable(),
        departmentId: z.coerce.number().int().positive().optional().nullable(),
        creditHours: z.coerce.number().min(0).max(60).optional().nullable(),
        institutionId: z.coerce.number().int().positive().optional(),
      }),
      req.body,
    );
    const db = getDb();
    const institutionId = req.user!.roleCode === 'super_admin' ? body.institutionId ?? -1 : scope(req);
    if (institutionId === -1) throw validationError('Specify the institution for this subject.');
    const duplicate = db
      .prepare('SELECT id FROM subjects WHERE institution_id = ? AND UPPER(code) = ?')
      .get(institutionId, body.code.toUpperCase());
    if (duplicate) throw conflict('A subject with this code already exists.');

    const info = db
      .prepare(
        `INSERT INTO subjects (institution_id, department_id, name, code, description, credit_hours, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        institutionId,
        body.departmentId ?? null,
        body.name.trim(),
        body.code.toUpperCase(),
        body.description ?? null,
        body.creditHours ?? null,
        nowIso(),
        nowIso(),
      );
    recordAudit(db, {
      institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'subject.created',
      category: 'academic',
      resourceType: 'subject',
      resourceId: Number(info.lastInsertRowid),
      description: `Created subject ${body.name}`,
      ...auditMeta(req),
    });
    return created(res, db.prepare('SELECT * FROM subjects WHERE id = ?').get(Number(info.lastInsertRowid)));
  }),
);

subjectsRouter.patch(
  '/:id',
  requirePermission('subject.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const body = parseWith(
      z
        .object({
          name: z.string().trim().min(2).max(160).optional(),
          description: z.string().trim().max(500).optional().nullable(),
          departmentId: z.coerce.number().int().positive().nullable().optional(),
          creditHours: z.coerce.number().min(0).max(60).nullable().optional(),
          status: z.enum(['active', 'archived']).optional(),
        })
        .strict(),
      req.body,
    );
    const existing = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id) as any;
    if (!existing) throw notFound('Subject not found.');
    if (scope(req) !== -1 && existing.institution_id !== scope(req)) throw notFound('Subject not found.');

    db.prepare(
      `UPDATE subjects SET name = ?, description = ?, department_id = ?, credit_hours = ?, status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      body.name ?? existing.name,
      body.description === undefined ? existing.description : body.description,
      body.departmentId === undefined ? existing.department_id : body.departmentId,
      body.creditHours === undefined ? existing.credit_hours : body.creditHours,
      body.status ?? existing.status,
      nowIso(),
      id,
    );
    recordAudit(db, {
      institutionId: existing.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'subject.updated',
      category: 'academic',
      resourceType: 'subject',
      resourceId: id,
      description: `Updated subject ${existing.name}`,
      ...auditMeta(req),
    });
    return ok(res, db.prepare('SELECT * FROM subjects WHERE id = ?').get(id));
  }),
);

subjectsRouter.post(
  '/:id/teachers',
  requirePermission('subject.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(z.object({ teacherIds: z.array(z.coerce.number().int().positive()).max(200) }), req.body);
    const db = getDb();
    const id = Number(req.params.id);
    const subject = db.prepare('SELECT * FROM subjects WHERE id = ?').get(id) as any;
    if (!subject) throw notFound('Subject not found.');
    if (scope(req) !== -1 && subject.institution_id !== scope(req)) throw notFound('Subject not found.');

    db.transaction(() => {
      db.prepare('DELETE FROM teacher_subjects WHERE subject_id = ?').run(id);
      const insert = db.prepare(
        `INSERT INTO teacher_subjects (teacher_id, subject_id, assigned_at)
         SELECT t.id, ?, ? FROM teachers t WHERE t.id = ? AND t.institution_id = ?`,
      );
      for (const teacherId of body.teacherIds) insert.run(id, nowIso(), teacherId, subject.institution_id);
    })();
    recordAudit(db, {
      institutionId: subject.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'subject.teachers_assigned',
      category: 'academic',
      resourceType: 'subject',
      resourceId: id,
      description: `Assigned ${body.teacherIds.length} examiner(s) to ${subject.name}`,
      ...auditMeta(req),
    });
    return ok(res, { assigned: body.teacherIds.length });
  }),
);

// ---------------------------------------------------------------------------
// Groups (cohorts that can be assigned papers independently of a class)
// ---------------------------------------------------------------------------
export const groupsRouter = Router();
groupsRouter.use(requireAuth);

groupsRouter.get(
  '/',
  requirePermission('group.manage', 'class.view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope(req) !== -1) {
      where.push('g.institution_id = ?');
      params.push(scope(req));
    }
    if (req.query.classId) {
      where.push('g.class_id = ?');
      params.push(Number(req.query.classId));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const items = db
      .prepare(
        `SELECT g.*, c.name AS class_name,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
           FROM groups g LEFT JOIN classes c ON c.id = g.class_id
           ${whereSql}
          ORDER BY g.name ASC`,
      )
      .all(...params);
    return ok(res, items);
  }),
);

groupsRouter.post(
  '/',
  requirePermission('group.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        name: z.string().trim().min(2).max(120),
        description: z.string().trim().max(400).optional().nullable(),
        classId: z.coerce.number().int().positive().optional().nullable(),
        institutionId: z.coerce.number().int().positive().optional(),
      }),
      req.body,
    );
    const db = getDb();
    const institutionId = req.user!.roleCode === 'super_admin' ? body.institutionId ?? -1 : scope(req);
    if (institutionId === -1) throw validationError('Specify the institution for this group.');
    const info = db
      .prepare(
        'INSERT INTO groups (institution_id, class_id, name, description, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(institutionId, body.classId ?? null, body.name.trim(), body.description ?? null, req.user!.id, nowIso(), nowIso());
    recordAudit(db, {
      institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'group.created',
      category: 'academic',
      resourceType: 'group',
      resourceId: Number(info.lastInsertRowid),
      description: `Created group ${body.name}`,
      ...auditMeta(req),
    });
    return created(res, db.prepare('SELECT * FROM groups WHERE id = ?').get(Number(info.lastInsertRowid)));
  }),
);

groupsRouter.post(
  '/:id/members',
  requirePermission('group.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(z.object({ studentIds: z.array(z.coerce.number().int().positive()).max(500) }), req.body);
    const db = getDb();
    const id = Number(req.params.id);
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as any;
    if (!group) throw notFound('Group not found.');
    if (scope(req) !== -1 && group.institution_id !== scope(req)) throw notFound('Group not found.');

    db.transaction(() => {
      db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO group_members (group_id, student_id, added_at)
         SELECT ?, s.id, ? FROM students s WHERE s.id = ? AND s.institution_id = ?`,
      );
      for (const studentId of body.studentIds) insert.run(id, nowIso(), studentId, group.institution_id);
    })();
    recordAudit(db, {
      institutionId: group.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'group.members_updated',
      category: 'academic',
      resourceType: 'group',
      resourceId: id,
      description: `Updated membership of group ${group.name}`,
      metadata: { count: body.studentIds.length },
      ...auditMeta(req),
    });
    return ok(res, { members: body.studentIds.length });
  }),
);

groupsRouter.patch(
  '/:id',
  requirePermission('group.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        name: z.string().trim().min(2).max(120).optional(),
        description: z.string().trim().max(400).optional().nullable(),
        classId: z.coerce.number().int().positive().optional().nullable(),
      }),
      req.body,
    );
    const db = getDb();
    const id = Number(req.params.id);
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as any;
    if (!group) throw notFound('Group not found.');
    if (scope(req) !== -1 && group.institution_id !== scope(req)) throw notFound('Group not found.');

    // A group may only be attached to a class of its own institution; otherwise a
    // class id from another tenant would leak into this institution's records.
    if (body.classId != null) {
      const klass = db.prepare('SELECT id, institution_id FROM classes WHERE id = ?').get(body.classId) as any;
      if (!klass || klass.institution_id !== group.institution_id) {
        throw validationError('Select a class from the same institution.');
      }
    }

    db.prepare('UPDATE groups SET name = ?, description = ?, class_id = ?, updated_at = ? WHERE id = ?').run(
      body.name ?? group.name,
      body.description !== undefined ? body.description : group.description,
      body.classId !== undefined ? body.classId : group.class_id,
      nowIso(),
      id,
    );
    recordAudit(db, {
      institutionId: group.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'group.updated',
      category: 'academic',
      resourceType: 'group',
      resourceId: id,
      description: `Updated group ${body.name ?? group.name}`,
      metadata: { name: body.name ?? group.name, classId: body.classId !== undefined ? body.classId : group.class_id },
      ...auditMeta(req),
    });
    return ok(res, db.prepare('SELECT * FROM groups WHERE id = ?').get(id));
  }),
);

groupsRouter.delete(
  '/:id',
  requirePermission('group.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as any;
    if (!group) throw notFound('Group not found.');
    if (scope(req) !== -1 && group.institution_id !== scope(req)) throw notFound('Group not found.');

    // Assignments are the record of who was expected to sit a paper, and the schema
    // cascades them away with the group. Refuse instead of silently rewriting history.
    const examUse = db.prepare('SELECT COUNT(*) AS c FROM exam_assignments WHERE group_id = ?').get(id) as { c: number };
    const quizUse = db.prepare('SELECT COUNT(*) AS c FROM quiz_assignments WHERE group_id = ?').get(id) as { c: number };
    const inUse = examUse.c + quizUse.c;
    if (inUse > 0) {
      throw conflict(
        `This group is still assigned to ${inUse} paper${inUse === 1 ? '' : 's'}. Remove those assignments first — otherwise the record of who was expected to sit them would be lost.`,
      );
    }

    const members = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(id) as { c: number };
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    recordAudit(db, {
      institutionId: group.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'group.deleted',
      category: 'academic',
      resourceType: 'group',
      resourceId: id,
      description: `Deleted group ${group.name}`,
      metadata: { name: group.name, memberCount: members.c },
      ...auditMeta(req),
    });
    return ok(res, { message: 'Group removed.', membersRemoved: members.c });
  }),
);

groupsRouter.get(
  '/:id',
  requirePermission('group.manage', 'class.view'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as any;
    if (!group) throw notFound('Group not found.');
    if (scope(req) !== -1 && group.institution_id !== scope(req)) throw notFound('Group not found.');
    const members = db
      .prepare(
        `SELECT s.id, s.student_code, u.full_name, u.email, c.name AS class_name
           FROM group_members gm
           JOIN students s ON s.id = gm.student_id
           JOIN users u ON u.id = s.user_id
           LEFT JOIN classes c ON c.id = s.class_id
          WHERE gm.group_id = ? ORDER BY u.full_name`,
      )
      .all(id);
    return ok(res, { group, members });
  }),
);
