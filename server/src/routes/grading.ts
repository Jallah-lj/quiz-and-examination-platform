import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, ok, okList } from '../lib/http';
import { listQuery, parseWith } from '../lib/validation';
import { paginate } from '../types';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import { finalizeGrading, getGradingDetail, listGradingQueue, saveGrade } from '../services/grading';

const router = Router();
router.use(requireAuth);

function auditMeta(req: AuthedRequest) {
  return { ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null };
}

router.get(
  '/queue',
  requirePermission('grading.grade'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const query = listQuery(req);
    const filters = parseWith(
      z.object({
        examId: z.coerce.number().int().positive().optional(),
        quizId: z.coerce.number().int().positive().optional(),
        classId: z.coerce.number().int().positive().optional(),
        status: z.enum(['pending', 'graded', 'all']).optional(),
      }),
      req.query,
    );
    const db = getDb();
    const result = listGradingQueue(
      db,
      req.user!,
      { ...filters, search: query.q },
      { page: query.page, pageSize: query.pageSize },
    );
    return okList(res, paginate(result.items, { page: query.page, pageSize: query.pageSize, total: result.total }));
  }),
);

router.get(
  '/attempts/:id',
  requirePermission('grading.grade'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const detail = getGradingDetail(db, req.user!, Number(req.params.id));
    return ok(res, detail);
  }),
);

router.post(
  '/attempts/:id/answers/:answerId',
  requirePermission('grading.grade'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const body = parseWith(
      z.object({
        awardedMarks: z.coerce.number().min(0).max(10000),
        comment: z.string().trim().max(3000).nullable().optional(),
      }),
      req.body,
    );
    const db = getDb();
    const result = saveGrade(
      db,
      req.user!,
      Number(req.params.id),
      Number(req.params.answerId),
      { awardedMarks: body.awardedMarks, comment: body.comment ?? null },
      auditMeta(req),
    );
    return ok(res, result);
  }),
);

router.post(
  '/attempts/:id/finalize',
  requirePermission('grading.finalize'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const result = finalizeGrading(db, req.user!, Number(req.params.id), auditMeta(req));
    return ok(res, result);
  }),
);

router.get(
  '/attempts/:id/history',
  requirePermission('grading.grade'),
  asyncHandler(async (req: AuthedRequest, res) => {
    const db = getDb();
    const detail = getGradingDetail(db, req.user!, Number(req.params.id));
    return ok(res, detail.history);
  }),
);

export default router;
