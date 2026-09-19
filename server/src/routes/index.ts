import { Router } from 'express';
import authRouter from './auth';
import usersRouter from './users';
import institutionsRouter from './institutions';
import studentsRouter from './students';
import teachersRouter from './teachers';
import questionsRouter, { questionBanksRouter } from './questions';
import quizzesRouter from './quizzes';
import examsRouter from './exams';
import attemptsRouter from './attempts';
import gradingRouter from './grading';
import resultsRouter from './results';
import reportsRouter from './reports';
import dashboardsRouter from './dashboards';
import { auditLogsRouter, gradingSchemesRouter, notificationsRouter, settingsRouter, systemRouter } from './system';
import { classesRouter, departmentsRouter, groupsRouter, subjectsRouter } from './academic';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ data: { status: 'ok', service: 'examsys-api', time: new Date().toISOString() } });
});

router.use('/auth', authRouter);
router.use('/users', usersRouter);
router.use('/institutions', institutionsRouter);
router.use('/students', studentsRouter);
router.use('/teachers', teachersRouter);
router.use('/departments', departmentsRouter);
router.use('/classes', classesRouter);
router.use('/subjects', subjectsRouter);
router.use('/groups', groupsRouter);
router.use('/question-banks', questionBanksRouter);
router.use('/questions', questionsRouter);
router.use('/quizzes', quizzesRouter);
router.use('/examinations', examsRouter);
router.use('/attempts', attemptsRouter);
router.use('/grading', gradingRouter);
router.use('/results', resultsRouter);
router.use('/reports', reportsRouter);
router.use('/audit-logs', auditLogsRouter);
router.use('/notifications', notificationsRouter);
router.use('/settings', settingsRouter);
router.use('/grading-schemes', gradingSchemesRouter);
router.use('/system', systemRouter);
router.use('/dashboard', dashboardsRouter);

export default router;
