import { Suspense, lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { Loading } from './components/ui';
import { ForbiddenPage, NotFoundPage } from './components/StatusPages';
import { useAuth } from './context/AuthContext';

const AuthPages = lazy(() => import('./pages/auth/AuthPages'));
const ProfilePage = lazy(() => import('./pages/auth/ProfilePage'));
const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'));
const InstitutionDashboardPage = lazy(() => import('./pages/dashboard/InstitutionDashboardPage'));
const InstitutionsPage = lazy(() => import('./pages/admin/InstitutionsPage'));
const StudentsPage = lazy(() => import('./pages/admin/StudentsPage'));
const TeachersPage = lazy(() => import('./pages/admin/TeachersPage'));
const UsersPage = lazy(() => import('./pages/admin/UsersPage'));
const AcademicPage = lazy(() => import('./pages/admin/AcademicPage'));
const GradingSchemesPage = lazy(() => import('./pages/admin/GradingSchemesPage'));
const SystemPage = lazy(() => import('./pages/admin/SystemPage'));
const QuestionBanksPage = lazy(() => import('./pages/questions/QuestionBanksPage'));
const QuestionsPage = lazy(() => import('./pages/questions/QuestionsPage'));
const QuestionFormPage = lazy(() => import('./pages/questions/QuestionFormPage'));
const QuizzesPage = lazy(() => import('./pages/quizzes/QuizzesPage'));
const QuizFormPage = lazy(() => import('./pages/quizzes/QuizFormPage'));
const QuizDetailPage = lazy(() => import('./pages/quizzes/QuizDetailPage'));
const ExamsPage = lazy(() => import('./pages/exams/ExamsPage'));
const ExamFormPage = lazy(() => import('./pages/exams/ExamFormPage'));
const ExamDetailPage = lazy(() => import('./pages/exams/ExamDetailPage'));
const ExamMonitorPage = lazy(() => import('./pages/exams/ExamMonitorPage'));
const AttemptsPage = lazy(() => import('./pages/attempts/AttemptsPage'));
const TakeAttemptPage = lazy(() => import('./pages/attempts/TakeAttemptPage'));
const AttemptReviewPage = lazy(() => import('./pages/attempts/AttemptReviewPage'));
const GradingQueuePage = lazy(() => import('./pages/grading/GradingQueuePage'));
const GradingAttemptPage = lazy(() => import('./pages/grading/GradingAttemptPage'));
const ResultsPage = lazy(() => import('./pages/results/ResultsPage'));
const ResultDetailPage = lazy(() => import('./pages/results/ResultDetailPage'));
const ReportsPage = lazy(() => import('./pages/reports/ReportsPage'));
const AuditLogsPage = lazy(() => import('./pages/audit/AuditLogsPage'));
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'));

function RequireAuth({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Loading label="Checking your session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function RequirePermission({ permissions, children }: { permissions: string[]; children: ReactNode }) {
  const { hasPermission } = useAuth();
  if (!hasPermission(...permissions)) return <ForbiddenPage />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Suspense fallback={<Loading label="Loading…" />}>
      <Routes>
        <Route path="/login" element={<AuthPages initialView="login" />} />
        <Route path="/register" element={<AuthPages initialView="register" />} />
        <Route path="/forgot-password" element={<AuthPages initialView="forgot" />} />
        <Route path="/reset-password" element={<AuthPages initialView="reset" />} />
        <Route path="/verify-email" element={<AuthPages initialView="verify" />} />

        <Route
          path="/attempts/:attemptId/take"
          element={
            <RequireAuth>
              <TakeAttemptPage />
            </RequireAuth>
          }
        />

        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/notifications" element={<NotificationsPage />} />

          {/* The platform dashboard is the platform administrator's dashboard, so the old
              address — and any bookmark of it — resolves to the dashboard itself. */}
          <Route path="/platform" element={<Navigate to="/dashboard" replace />} />
          <Route
            path="/institutions/:institutionId/dashboard"
            element={
              <RequirePermission permissions={['institution.view_all']}>
                <InstitutionDashboardPage />
              </RequirePermission>
            }
          />
          <Route
            path="/institutions"
            element={
              <RequirePermission permissions={['institution.view_all']}>
                <InstitutionsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/students"
            element={
              <RequirePermission permissions={['student.view', 'student.manage']}>
                <StudentsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/teachers"
            element={
              <RequirePermission permissions={['teacher.view', 'teacher.manage']}>
                <TeachersPage />
              </RequirePermission>
            }
          />
          <Route
            path="/users"
            element={
              <RequirePermission permissions={['user.view']}>
                <UsersPage />
              </RequirePermission>
            }
          />
          <Route
            path="/academic"
            element={
              <RequirePermission permissions={['department.manage', 'class.view', 'subject.view']}>
                <AcademicPage />
              </RequirePermission>
            }
          />
          <Route
            path="/grading-schemes"
            element={
              <RequirePermission permissions={['grading_scheme.manage', 'grading_scheme.view']}>
                <GradingSchemesPage />
              </RequirePermission>
            }
          />
          <Route
            path="/system"
            element={
              <RequirePermission permissions={['settings.manage', 'platform.manage']}>
                <SystemPage />
              </RequirePermission>
            }
          />

          <Route
            path="/question-banks"
            element={
              <RequirePermission permissions={['questionbank.view', 'questionbank.manage']}>
                <QuestionBanksPage />
              </RequirePermission>
            }
          />
          <Route
            path="/questions"
            element={
              <RequirePermission permissions={['question.view', 'question.create']}>
                <QuestionsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/questions/new"
            element={
              <RequirePermission permissions={['question.create']}>
                <QuestionFormPage mode="create" />
              </RequirePermission>
            }
          />
          <Route
            path="/questions/:questionId/edit"
            element={
              <RequirePermission permissions={['question.edit']}>
                <QuestionFormPage mode="edit" />
              </RequirePermission>
            }
          />

          <Route
            path="/quizzes"
            element={
              <RequirePermission permissions={['quiz.view', 'quiz.manage', 'attempt.take']}>
                <QuizzesPage />
              </RequirePermission>
            }
          />
          <Route
            path="/quizzes/new"
            element={
              <RequirePermission permissions={['quiz.manage']}>
                <QuizFormPage mode="create" />
              </RequirePermission>
            }
          />
          <Route
            path="/quizzes/:quizId/edit"
            element={
              <RequirePermission permissions={['quiz.manage']}>
                <QuizFormPage mode="edit" />
              </RequirePermission>
            }
          />
          <Route
            path="/quizzes/:quizId"
            element={
              <RequirePermission permissions={['quiz.view', 'quiz.manage']}>
                <QuizDetailPage />
              </RequirePermission>
            }
          />

          <Route
            path="/examinations"
            element={
              // Candidates hold attempt.take rather than exam.view; the page renders their
              // own available, upcoming and completed papers for that role.
              <RequirePermission permissions={['exam.view', 'exam.create', 'attempt.take']}>
                <ExamsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/examinations/new"
            element={
              <RequirePermission permissions={['exam.create']}>
                <ExamFormPage mode="create" />
              </RequirePermission>
            }
          />
          <Route
            path="/examinations/:examId/edit"
            element={
              <RequirePermission permissions={['exam.edit']}>
                <ExamFormPage mode="edit" />
              </RequirePermission>
            }
          />
          <Route
            path="/examinations/:examId/monitor"
            element={
              <RequirePermission permissions={['exam.monitor']}>
                <ExamMonitorPage />
              </RequirePermission>
            }
          />
          <Route
            path="/examinations/:examId"
            element={
              <RequirePermission permissions={['exam.view', 'exam.create']}>
                <ExamDetailPage />
              </RequirePermission>
            }
          />

          <Route
            path="/my-attempts"
            element={
              <RequirePermission permissions={['attempt.view.own', 'attempt.view.any']}>
                <AttemptsPage />
              </RequirePermission>
            }
          />
          <Route path="/attempts/:attemptId/review" element={<AttemptReviewPage />} />

          <Route
            path="/grading"
            element={
              <RequirePermission permissions={['grading.grade']}>
                <GradingQueuePage />
              </RequirePermission>
            }
          />
          <Route
            path="/grading/attempts/:attemptId"
            element={
              <RequirePermission permissions={['grading.grade']}>
                <GradingAttemptPage />
              </RequirePermission>
            }
          />

          <Route
            path="/results"
            element={
              <RequirePermission permissions={['result.view.any', 'result.view.own']}>
                <ResultsPage />
              </RequirePermission>
            }
          />
          <Route path="/results/:resultId" element={<ResultDetailPage />} />

          <Route
            path="/reports"
            element={
              <RequirePermission permissions={['report.view', 'report.export']}>
                <ReportsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/audit-logs"
            element={
              <RequirePermission permissions={['audit.view']}>
                <AuditLogsPage />
              </RequirePermission>
            }
          />

          <Route path="*" element={<NotFoundPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
