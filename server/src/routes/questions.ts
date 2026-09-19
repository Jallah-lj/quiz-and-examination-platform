import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, created, ok, okList } from '../lib/http';
import { conflict, notFound, validationError } from '../lib/errors';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import {
  archiveQuestion,
  createQuestion,
  deleteQuestion,
  duplicateQuestion,
  getQuestion,
  updateQuestion,
} from '../services/questions';
import { nowIso } from '../lib/time';
import { recordAudit } from '../services/audit';

const router = Router();
router.use(requireAuth);

function scope(req: AuthedRequest): number | null {
  return req.user!.roleCode === 'super_admin' ? null : req.user!.institutionId;
}

function auditMeta(req: AuthedRequest) {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

const optionSchema = z.object({
  label: z.string().trim().min(1).max(4),
  text: z.string().trim().min(1).max(2000),
  isCorrect: z.boolean().optional(),
  position: z.coerce.number().int().min(0).optional(),
});

const questionBodySchema = z.object({
  questionBankId: z.coerce.number().int().positive(),
  subjectId: z.coerce.number().int().positive(),
  type: z.enum(['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER', 'ESSAY', 'FILL_BLANK']),
  text: z.string().trim().min(3).max(10000),
  explanation: z.string().trim().max(5000).optional().nullable(),
  marks: z.coerce.number().min(0.25).max(1000),
  negativeMarks: z.coerce.number().min(0).max(1000).optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  topic: z.string().trim().max(160).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  options: z.array(optionSchema).max(10).optional(),
  answerConfig: z
    .object({
      caseSensitive: z.boolean().optional(),
      allowPartial: z.boolean().optional(),
      numericTolerance: z.coerce.number().min(0).max(1000).optional(),
      acceptedAnswers: z.array(z.string().trim().max(500)).max(20).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Question banks
// ---------------------------------------------------------------------------
export const questionBanksRouter = Router();
questionBanksRouter.use(requireAuth);

questionBanksRouter.get(
  '/',
  requirePermission('questionbank.view', 'questionbank.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope(req) !== null) {
      where.push('b.institution_id = ?');
      params.push(scope(req));
    }
    if (req.query.subjectId) {
      where.push('b.subject_id = ?');
      params.push(Number(req.query.subjectId));
    }
    if (req.query.status) {
      where.push('b.status = ?');
      params.push(String(req.query.status));
    }
    if (query.q) {
      where.push('(b.name LIKE ? OR b.description LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM question_banks b ${whereSql}`).get(...params) as { c: number }).c;
    const items = db
      .prepare(
        `SELECT b.*, s.name AS subject_name, s.code AS subject_code, u.full_name AS created_by_name,
                (SELECT COUNT(*) FROM questions q WHERE q.question_bank_id = b.id AND q.status = 'ACTIVE') AS active_questions,
                (SELECT COUNT(*) FROM questions q WHERE q.question_bank_id = b.id) AS total_questions
           FROM question_banks b
           JOIN subjects s ON s.id = b.subject_id
           LEFT JOIN users u ON u.id = b.created_by
           ${whereSql}
          ORDER BY b.name ASC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize);
    return okList(res, paginate(items, { page: query.page, pageSize: query.pageSize, total }));
  }),
);

questionBanksRouter.post(
  '/',
  requirePermission('questionbank.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        name: z.string().trim().min(2).max(160),
        subjectId: z.coerce.number().int().positive(),
        description: z.string().trim().max(600).optional().nullable(),
        institutionId: z.coerce.number().int().positive().optional(),
      }),
      req.body,
    );
    const db = getDb();
    const institutionId = req.user!.roleCode === 'super_admin' ? body.institutionId ?? -1 : scope(req)!;
    const subject = db
      .prepare('SELECT id FROM subjects WHERE id = ? AND institution_id = ?')
      .get(body.subjectId, institutionId);
    if (!subject) throw validationError('The selected subject does not belong to this institution.');

    const info = db
      .prepare(
        `INSERT INTO question_banks (institution_id, subject_id, name, description, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(institutionId, body.subjectId, body.name.trim(), body.description ?? null, req.user!.id, nowIso(), nowIso());

    recordAudit(db, {
      institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'question_bank.created',
      category: 'question',
      resourceType: 'question_bank',
      resourceId: Number(info.lastInsertRowid),
      description: `Created question bank "${body.name}"`,
      ...auditMeta(req),
    });
    return created(res, db.prepare('SELECT * FROM question_banks WHERE id = ?').get(Number(info.lastInsertRowid)));
  }),
);

questionBanksRouter.patch(
  '/:id',
  requirePermission('questionbank.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const body = parseWith(
      z
        .object({
          name: z.string().trim().min(2).max(160).optional(),
          description: z.string().trim().max(600).optional().nullable(),
          status: z.enum(['active', 'archived']).optional(),
        })
        .strict(),
      req.body,
    );
    const existing = db.prepare('SELECT * FROM question_banks WHERE id = ?').get(id) as any;
    if (!existing) throw notFound('Question bank not found.');
    if (scope(req) !== null && existing.institution_id !== scope(req)) throw notFound('Question bank not found.');

    db.prepare('UPDATE question_banks SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?').run(
      body.name ?? existing.name,
      body.description === undefined ? existing.description : body.description,
      body.status ?? existing.status,
      nowIso(),
      id,
    );
    return ok(res, db.prepare('SELECT * FROM question_banks WHERE id = ?').get(id));
  }),
);

questionBanksRouter.delete(
  '/:id',
  requirePermission('questionbank.manage'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM question_banks WHERE id = ?').get(id) as any;
    if (!existing) throw notFound('Question bank not found.');
    if (scope(req) !== null && existing.institution_id !== scope(req)) throw notFound('Question bank not found.');
    const questions = (db.prepare('SELECT COUNT(*) AS c FROM questions WHERE question_bank_id = ?').get(id) as { c: number }).c;
    if (questions > 0) {
      throw conflict('Archive the bank instead — it still contains questions.');
    }
    db.prepare('DELETE FROM question_banks WHERE id = ?').run(id);
    recordAudit(db, {
      institutionId: existing.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'question_bank.deleted',
      category: 'question',
      resourceType: 'question_bank',
      resourceId: id,
      description: `Deleted empty question bank "${existing.name}"`,
      ...auditMeta(req),
    });
    return ok(res, { message: 'Question bank deleted.' });
  }),
);

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------
router.get(
  '/',
  requirePermission('question.view', 'question.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];

    if (scope(req) !== null) {
      where.push('q.institution_id = ?');
      params.push(scope(req));
    }
    const filters = req.query as Record<string, string | undefined>;
    if (filters.subjectId) {
      where.push('q.subject_id = ?');
      params.push(Number(filters.subjectId));
    }
    if (filters.questionBankId) {
      where.push('q.question_bank_id = ?');
      params.push(Number(filters.questionBankId));
    }
    if (filters.type) {
      where.push('q.type = ?');
      params.push(filters.type);
    }
    if (filters.difficulty) {
      where.push('q.difficulty = ?');
      params.push(filters.difficulty);
    }
    if (filters.status) {
      where.push('q.status = ?');
      params.push(filters.status);
    }
    if (filters.topic) {
      where.push('q.topic = ?');
      params.push(filters.topic);
    }
    if (filters.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(q.tags) WHERE value = ?)');
      params.push(filters.tag);
    }
    if (filters.mine === 'true' || filters.mine === '1') {
      where.push('q.created_by = ?');
      params.push(req.user!.id);
    }
    // Used by the examiner dashboard's data-quality check: questions stored without
    // the explanation candidates see after release.
    if (filters.missingExplanation === 'true') {
      where.push("COALESCE(TRIM(q.explanation), '') = ''");
    }
    if (query.q) {
      where.push('(q.text LIKE ? OR q.topic LIKE ? OR q.explanation LIKE ?)');
      params.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = (db.prepare(`SELECT COUNT(*) AS c FROM questions q ${whereSql}`).get(...params) as { c: number }).c;
    const sortMap: Record<string, string> = {
      created: 'q.created_at',
      updated: 'q.updated_at',
      marks: 'q.marks',
      difficulty: 'q.difficulty',
      type: 'q.type',
      topic: 'q.topic',
    };
    const orderColumn = sortMap[query.sort ?? ''] ?? 'q.updated_at';

    const items = db
      .prepare(
        `SELECT q.id, q.type, q.text, q.topic, q.marks, q.negative_marks, q.difficulty, q.status, q.tags,
                q.created_at, q.updated_at, q.subject_id, q.question_bank_id,
                s.name AS subject_name, b.name AS bank_name, u.full_name AS created_by_name,
                (SELECT COUNT(*) FROM question_options o WHERE o.question_id = q.id) AS option_count,
                (SELECT COUNT(*) FROM exam_questions eq WHERE eq.question_id = q.id) AS used_in_exams,
                (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.question_id = q.id) AS used_in_quizzes
           FROM questions q
           JOIN subjects s ON s.id = q.subject_id
           JOIN question_banks b ON b.id = q.question_bank_id
           LEFT JOIN users u ON u.id = q.created_by
           ${whereSql}
          ORDER BY ${orderColumn} ${query.order === 'asc' ? 'ASC' : 'DESC'}
          LIMIT ? OFFSET ?`,
      )
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as any[];

    return okList(
      res,
      paginate(
        items.map((item) => ({ ...item, tags: JSON.parse(item.tags ?? '[]') })),
        { page: query.page, pageSize: query.pageSize, total },
      ),
    );
  }),
);

router.get(
  '/facets',
  requirePermission('question.view', 'question.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const institutionId = scope(req);
    const params: unknown[] = institutionId !== null ? [institutionId] : [];
    const institutionFilter = institutionId !== null ? 'AND q.institution_id = ?' : '';

    const topics = db
      .prepare(
        `SELECT DISTINCT q.topic AS topic FROM questions q
          WHERE q.topic IS NOT NULL AND q.topic <> '' ${institutionFilter}
          ORDER BY q.topic`,
      )
      .all(...params) as { topic: string }[];
    const tags = db
      .prepare(
        `SELECT DISTINCT je.value AS tag FROM questions q, json_each(q.tags) je
          WHERE 1 = 1 ${institutionFilter}
          ORDER BY je.value`,
      )
      .all(...params) as { tag: string }[];
    const counts = db
      .prepare(
        `SELECT q.type, q.difficulty, COUNT(*) AS count FROM questions q
          WHERE 1 = 1 ${institutionFilter}
          GROUP BY q.type, q.difficulty`,
      )
      .all(...params);
    return ok(res, { topics: topics.map((t) => t.topic), tags: tags.map((t) => t.tag), counts });
  }),
);

router.post(
  '/',
  requirePermission('question.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(questionBodySchema, req.body);
    const db = getDb();
    const question = createQuestion(db, req.user!, body, auditMeta(req));
    return created(res, question);
  }),
);

router.get(
  '/:id',
  requirePermission('question.view', 'question.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const question = getQuestion(db, Number(req.params.id));
    if (!question) throw notFound('Question not found.');
    if (scope(req) !== null && question.institution_id !== scope(req)) throw notFound('Question not found.');
    return ok(res, question);
  }),
);

router.patch(
  '/:id',
  requirePermission('question.edit'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(questionBodySchema.partial(), req.body);
    const db = getDb();
    const question = updateQuestion(db, req.user!, Number(req.params.id), body, auditMeta(req));
    return ok(res, question);
  }),
);

router.post(
  '/:id/duplicate',
  requirePermission('question.create'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const question = duplicateQuestion(db, req.user!, Number(req.params.id), auditMeta(req));
    return created(res, question);
  }),
);

router.post(
  '/:id/archive',
  requirePermission('question.archive'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(z.object({ archived: z.boolean() }), req.body ?? { archived: true });
    const db = getDb();
    const question = archiveQuestion(db, req.user!, Number(req.params.id), body.archived, auditMeta(req));
    return ok(res, question);
  }),
);

router.post(
  '/bulk-archive',
  requirePermission('question.archive'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(500) }), req.body);
    const db = getDb();
    let updated = 0;
    for (const id of body.ids) {
      const question = db.prepare('SELECT institution_id FROM questions WHERE id = ?').get(id) as any;
      if (!question) continue;
      if (scope(req) !== null && question.institution_id !== scope(req)) continue;
      archiveQuestion(db, req.user!, id, true, auditMeta(req));
      updated += 1;
    }
    return ok(res, { archived: updated });
  }),
);

router.delete(
  '/:id',
  requirePermission('question.archive'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    deleteQuestion(db, req.user!, Number(req.params.id), auditMeta(req));
    return ok(res, { message: 'Question deleted.' });
  }),
);

/**
 * CSV import: a flat, deterministic format so existing question banks can be migrated.
 * Columns: type,text,topic,difficulty,marks,negativeMarks,optionA,optionB,optionC,optionD,correctAnswer,explanation,tags
 */
router.post(
  '/import',
  requirePermission('question.import'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        questionBankId: z.coerce.number().int().positive(),
        subjectId: z.coerce.number().int().positive(),
        csv: z.string().min(10).max(2_000_000),
      }),
      req.body,
    );
    const db = getDb();
    const bank = db.prepare('SELECT * FROM question_banks WHERE id = ?').get(body.questionBankId) as any;
    if (!bank) throw notFound('Question bank not found.');
    if (scope(req) !== null && bank.institution_id !== scope(req)) throw notFound('Question bank not found.');

    const lines = body.csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length < 2) throw validationError('The CSV must contain a header row and at least one question.');

    const splitCsv = (line: string): string[] => {
      const out: string[] = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (inQuotes) {
          if (char === '"' && line[i + 1] === '"') {
            current += '"';
            i += 1;
          } else if (char === '"') {
            inQuotes = false;
          } else {
            current += char;
          }
        } else if (char === '"') {
          inQuotes = true;
        } else if (char === ',') {
          out.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      out.push(current);
      return out.map((value) => value.trim());
    };

    const header = splitCsv(lines[0]).map((h) => h.toLowerCase());
    const column = (name: string) => header.indexOf(name.toLowerCase());
    if (column('type') === -1 || column('text') === -1) {
      throw validationError('The CSV header must include at least "type" and "text" columns.');
    }

    const imported: number[] = [];
    const errors: { line: number; message: string }[] = [];

    db.transaction(() => {
      for (let index = 1; index < lines.length; index += 1) {
        const cells = splitCsv(lines[index]);
        const value = (name: string) => {
          const position = column(name);
          return position === -1 ? '' : (cells[position] ?? '');
        };
        try {
          const type = value('type').toUpperCase().replace(/[\s-]/g, '_') as
            | 'MCQ'
            | 'TRUE_FALSE'
            | 'SHORT_ANSWER'
            | 'ESSAY'
            | 'FILL_BLANK';
          if (!['MCQ', 'TRUE_FALSE', 'SHORT_ANSWER', 'ESSAY', 'FILL_BLANK'].includes(type)) {
            throw new Error(`Unknown question type "${value('type')}".`);
          }
          const options: { label: string; text: string; isCorrect: boolean }[] = [];
          const correct = value('correctanswer').toUpperCase();
          if (type === 'MCQ' || type === 'TRUE_FALSE') {
            const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
            labels.forEach((label) => {
              const text = value(`option${label}`);
              if (text) options.push({ label, text, isCorrect: correct.split(/[|,;]/).includes(label) });
            });
          }
          if (type === 'TRUE_FALSE' && options.length === 0) {
            options.push(
              { label: 'A', text: 'True', isCorrect: correct === 'TRUE' || correct === 'A' },
              { label: 'B', text: 'False', isCorrect: correct === 'FALSE' || correct === 'B' },
            );
          }
          const question = createQuestion(db, req.user!, {
            questionBankId: body.questionBankId,
            subjectId: body.subjectId,
            type,
            text: value('text'),
            explanation: value('explanation') || null,
            marks: Number(value('marks') || 1),
            negativeMarks: Number(value('negativemarks') || 0),
            difficulty: (value('difficulty').toUpperCase() || 'MEDIUM') as 'EASY' | 'MEDIUM' | 'HARD',
            topic: value('topic') || null,
            tags: value('tags') ? value('tags').split(/[|,;]/).map((t) => t.trim()).filter(Boolean) : [],
            options,
            answerConfig:
              type === 'FILL_BLANK'
                ? { acceptedAnswers: value('correctanswer').split('|').map((a) => a.trim()).filter(Boolean) }
                : undefined,
          }, auditMeta(req));
          imported.push(question.id);
        } catch (error) {
          errors.push({ line: index + 1, message: error instanceof Error ? error.message : 'Import failed.' });
        }
      }
    })();

    if (!imported.length && errors.length) {
      throw validationError('No questions could be imported.', errors.slice(0, 25));
    }

    recordAudit(db, {
      institutionId: bank.institution_id,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'question.imported',
      category: 'question',
      resourceType: 'question_bank',
      resourceId: body.questionBankId,
      description: `Imported ${imported.length} question(s) into "${bank.name}"`,
      metadata: { imported: imported.length, failed: errors.length },
      ...auditMeta(req),
    });

    return ok(res, { imported: imported.length, failed: errors.length, errors: errors.slice(0, 25) });
  }),
);

export default router;
