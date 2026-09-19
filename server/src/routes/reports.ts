import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db';
import { asyncHandler, ok } from '../lib/http';
import { parseWith } from '../lib/validation';
import { notFound } from '../lib/errors';
import type { AuthedRequest } from '../types';
import { requireAuth, requirePermission } from '../middleware/auth';
import {
  classPerformanceReport,
  examStatisticsReport,
  passFailReport,
  questionPerformanceReport,
  studentResultReport,
  subjectPerformanceReport,
  teacherActivityReport,
  REPORT_DEFINITIONS,
  type ReportActor,
} from '../services/reports';
import { exportFileName, toCsv, toPdf, toXlsx, type ReportTable } from '../lib/exporters';
import { recordAudit } from '../services/audit';

const router = Router();
router.use(requireAuth, requirePermission('report.view'));

const paramSchema = z.object({
  studentId: z.coerce.number().int().positive().optional(),
  classId: z.coerce.number().int().positive().optional(),
  examId: z.coerce.number().int().positive().optional(),
  subjectId: z.coerce.number().int().positive().optional(),
  questionBankId: z.coerce.number().int().positive().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
});

async function buildReport(
  key: string,
  db: ReturnType<typeof getDb>,
  actor: ReportActor,
  params: z.infer<typeof paramSchema>,
): Promise<ReportTable> {
  switch (key) {
    case 'student-results': {
      if (!params.studentId) throw notFound('A candidate must be selected for this report.');
      return studentResultReport(db, actor, { studentId: params.studentId, from: params.from, to: params.to });
    }
    case 'class-performance': {
      if (!params.classId) throw notFound('A class must be selected for this report.');
      return classPerformanceReport(db, actor, { classId: params.classId, examId: params.examId });
    }
    case 'subject-performance':
      return subjectPerformanceReport(db, actor, { subjectId: params.subjectId, from: params.from, to: params.to });
    case 'exam-statistics': {
      if (!params.examId) throw notFound('An examination must be selected for this report.');
      return examStatisticsReport(db, actor, { examId: params.examId });
    }
    case 'question-performance':
      return questionPerformanceReport(db, actor, {
        examId: params.examId,
        subjectId: params.subjectId,
        questionBankId: params.questionBankId,
      });
    case 'pass-fail':
      return passFailReport(db, actor, {
        examId: params.examId,
        classId: params.classId,
        from: params.from,
        to: params.to,
      });
    case 'examiner-activity':
      return teacherActivityReport(db, actor);
    default:
      throw notFound('Unknown report.');
  }
}

router.get('/catalog', (_req, res) => ok(res, REPORT_DEFINITIONS));

router.get(
  '/:key',
  asyncHandler(async (req: AuthedRequest, res) => {
    const params = parseWith(paramSchema, req.query);
    const db = getDb();
    const table = await buildReport(String(req.params.key), db, req.user!, params);

    if (params.format === 'json') {
      return ok(res, table);
    }

    if (params.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(table.title, 'csv')}"`);
      recordAudit(db, {
        institutionId: req.user!.institutionId,
        userId: req.user!.id,
        actorName: req.user!.fullName,
        actorRole: req.user!.roleCode,
        action: 'report.exported',
        category: 'result',
        resourceType: 'report',
        resourceId: String(req.params.key),
        description: `Exported "${table.title}" as CSV`,
        ip: req.ip ?? null,
      });
      return res.send(toCsv(table));
    }

    if (params.format === 'xlsx') {
      const buffer = await toXlsx(table);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(table.title, 'xlsx')}"`);
      recordAudit(db, {
        institutionId: req.user!.institutionId,
        userId: req.user!.id,
        actorName: req.user!.fullName,
        actorRole: req.user!.roleCode,
        action: 'report.exported',
        category: 'result',
        resourceType: 'report',
        resourceId: String(req.params.key),
        description: `Exported "${table.title}" as Excel`,
        ip: req.ip ?? null,
      });
      return res.send(buffer);
    }

    const buffer = await toPdf(table);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(table.title, 'pdf')}"`);
    recordAudit(db, {
      institutionId: req.user!.institutionId,
      userId: req.user!.id,
      actorName: req.user!.fullName,
      actorRole: req.user!.roleCode,
      action: 'report.exported',
      category: 'result',
      resourceType: 'report',
      resourceId: String(req.params.key),
      description: `Exported "${table.title}" as PDF`,
      ip: req.ip ?? null,
    });
    return res.send(buffer);
  }),
);

export default router;
