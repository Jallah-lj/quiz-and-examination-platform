import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, ok, okList } from '../lib/http';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import { getResultDetail, listResults, resultStats } from '../services/results';
import { publishAttemptResults } from '../services/exams';

const router = Router();
router.use(requireAuth);

function auditMeta(req: AuthedRequest) {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

const filterSchema = z.object({
  examId: z.coerce.number().int().positive().optional(),
  quizId: z.coerce.number().int().positive().optional(),
  subjectId: z.coerce.number().int().positive().optional(),
  classId: z.coerce.number().int().positive().optional(),
  outcome: z.enum(['PASSED', 'FAILED', 'PENDING']).optional(),
  published: z.enum(['published', 'unpublished']).optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
});

router.get(
  '/',
  requirePermission('result.view.any', 'result.view.own'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const filters = parseWith(filterSchema, req.query);
    const db = getDb();
    const result = listResults(
      db,
      req.user!,
      { ...filters, search: query.q },
      { page: query.page, pageSize: query.pageSize },
      { column: query.sort ?? 'date', order: query.order },
    );
    return okList(res, paginate(result.items, { page: query.page, pageSize: query.pageSize, total: result.total }));
  }),
);

router.get(
  '/stats',
  requirePermission('result.view.any', 'result.view.own'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const filters = parseWith(filterSchema, req.query);
    const db = getDb();
    const stats = resultStats(db, req.user!, filters);
    return ok(res, stats);
  }),
);

router.get(
  '/:id',
  requirePermission('result.view.any', 'result.view.own'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const detail = getResultDetail(db, req.user!, Number(req.params.id));
    return ok(res, detail);
  }),
);

router.post(
  '/publish',
  requirePermission('result.publish'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({ attemptIds: z.array(z.coerce.number().int().positive()).min(1).max(1000) }),
      req.body,
    );
    const db = getDb();
    const result = publishAttemptResults(db, req.user!, body.attemptIds, true, auditMeta(req));
    return ok(res, result);
  }),
);

router.post(
  '/unpublish',
  requirePermission('result.unpublish'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({ attemptIds: z.array(z.coerce.number().int().positive()).min(1).max(1000) }),
      req.body,
    );
    const db = getDb();
    const result = publishAttemptResults(db, req.user!, body.attemptIds, false, auditMeta(req));
    return ok(res, result);
  }),
);

export default router;
