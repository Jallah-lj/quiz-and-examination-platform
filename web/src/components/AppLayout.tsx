import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';

import { api } from '../lib/api';
import { formatRelative, initials } from '../lib/format';
import { useScrollLock } from '../lib/hooks';
import type { NotificationRow, RoleCode } from '../types';
import { Button, Loading, useToast } from './ui';
import { ThemeOptions, ThemeToggleButton } from './ThemeToggle';
import {
  IconAudit,
  IconBank,
  IconBell,
  IconBuilding,
  IconDashboard,
  IconExam,
  IconGrade,
  IconLayers,
  IconLogout,
  IconMenu,
  IconQuestions,
  IconQuiz,
  IconReport,
  IconResults,
  IconSettings,
  IconShield,
  IconStudents,
  IconTeacher,
  IconUser,
} from './Icons';

interface NavItem {
  to: string;
  label: string;
  icon: (props: { size?: number }) => JSX.Element;
  permissions?: string[];
  roles?: RoleCode[];
  exact?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const NAVIGATION: NavSection[] = [
  {
    label: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: IconDashboard, exact: true },
      { to: '/platform', label: 'Platform overview', icon: IconShield, roles: ['super_admin'] },
      { to: '/institutions', label: 'Institutions', icon: IconBuilding, permissions: ['institution.view_all'] },
    ],
  },
  {
    label: 'Assessment',
    items: [
      { to: '/examinations', label: 'Examinations', icon: IconExam, permissions: ['exam.view', 'exam.create'] },
      { to: '/quizzes', label: 'Quizzes', icon: IconQuiz, permissions: ['quiz.view', 'quiz.manage', 'attempt.take'] },
      { to: '/question-banks', label: 'Question banks', icon: IconBank, permissions: ['questionbank.view', 'questionbank.manage'] },
      { to: '/questions', label: 'Questions', icon: IconQuestions, permissions: ['question.view', 'question.create'] },
      { to: '/my-attempts', label: 'My attempts', icon: IconLayers, permissions: ['attempt.view.own'] },
    ],
  },
  {
    label: 'Grading & results',
    items: [
      { to: '/grading', label: 'Grading queue', icon: IconGrade, permissions: ['grading.grade'] },
      { to: '/results', label: 'Results', icon: IconResults, permissions: ['result.view.any', 'result.view.own'] },
      { to: '/reports', label: 'Reports', icon: IconReport, permissions: ['report.view', 'report.export'] },
    ],
  },
  {
    label: 'People',
    items: [
      { to: '/students', label: 'Students', icon: IconStudents, permissions: ['student.view', 'student.manage'] },
      { to: '/teachers', label: 'Examiners', icon: IconTeacher, permissions: ['teacher.view', 'teacher.manage'] },
      { to: '/users', label: 'User accounts', icon: IconUser, permissions: ['user.view'] },
    ],
  },
  {
    label: 'Academic structure',
    items: [
      { to: '/academic', label: 'Structure', icon: IconSettings, permissions: ['department.manage', 'class.view', 'subject.view'] },
    ],
  },
  {
    label: 'Administration',
    items: [
      { to: '/grading-schemes', label: 'Grading schemes', icon: IconGrade, permissions: ['grading_scheme.manage', 'grading_scheme.view'] },
      { to: '/audit-logs', label: 'Audit logs', icon: IconAudit, permissions: ['audit.view'] },
      { to: '/system', label: 'System status', icon: IconShield, permissions: ['settings.manage', 'platform.manage'] },
    ],
  },
];

function visibleSections(hasPermission: (...permissions: string[]) => boolean, role: RoleCode): NavSection[] {
  return NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => {
      if (item.roles && !item.roles.includes(role)) return false;
      if (!item.permissions) return true;
      return hasPermission(...item.permissions);
    }),
  })).filter((section) => section.items.length > 0);
}

export function AppLayout() {
  const { user, logout, hasPermission } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);

  useScrollLock(menuOpen);

  useEffect(() => {
    setMenuOpen(false);
    setNotificationsOpen(false);
    setAccountOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) setAccountOpen(false);
      if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) setNotificationsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const sections = useMemo(
    () => (user ? visibleSections(hasPermission, user.role) : []),
    [user, hasPermission],
  );

  if (!user) return <Loading />;

  const roleLabel = user.roleName;
  const scopeLabel = user.institution?.name ?? 'Platform administration';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <aside className={`sidebar ${menuOpen ? 'sidebar--open' : ''}`} aria-label="Main navigation">
        <div className="sidebar__brand">
          <span className="brand-mark" aria-hidden="true">
            ES
          </span>
          <span>
            <strong>ExamSys</strong>
            <small>Examination management</small>
          </span>
        </div>

        <div className="sidebar__context">
          <span className="sidebar__context-label">Signed in as</span>
          <span className="sidebar__context-role">{roleLabel}</span>
          <span className="sidebar__context-scope">{scopeLabel}</span>
        </div>

        <nav className="sidebar__nav">
          {sections.map((section) => (
            <div key={section.label} className="sidebar__section">
              <span className="sidebar__section-label">{section.label}</span>
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.exact}
                    className={({ isActive }) => `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`}
                  >
                    <Icon size={17} />
                    <span>{item.label}</span>
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar__footer">
          <button
            type="button"
            className="sidebar__link sidebar__link--button"
            onClick={() => {
              void logout().then(() => navigate('/login'));
            }}
          >
            <IconLogout size={17} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {menuOpen ? (
        <button type="button" className="scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />
      ) : null}

      <div className="app-main">
        <header className="topbar">
          <button
            type="button"
            className="icon-button topbar__menu"
            aria-label="Open navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <IconMenu />
          </button>

          <div className="topbar__spacer" />

          <ThemeToggleButton />

          <div className="topbar__item" ref={notificationRef}>
            <button
              type="button"
              className="icon-button"
              aria-label="Notifications"
              aria-expanded={notificationsOpen}
              onClick={() => setNotificationsOpen((open) => !open)}
            >
              <IconBell />
              <NotificationDot />
            </button>
            {notificationsOpen ? <NotificationsPanel onClose={() => setNotificationsOpen(false)} /> : null}
          </div>

          <div className="topbar__item" ref={accountRef}>
            <button
              type="button"
              className="account-button"
              aria-expanded={accountOpen}
              // The name is visible on wide screens and inside the menu on phones, so the
              // button always carries its own label.
              aria-label={`Account menu for ${user.fullName}`}
              onClick={() => setAccountOpen((open) => !open)}
            >
              <span className="avatar" aria-hidden="true">
                {initials(user.fullName)}
              </span>
              <span className="account-button__text">
                <strong>{user.fullName}</strong>
                <small>{roleLabel}</small>
              </span>
            </button>
            {accountOpen ? (
              <div className="menu-popover" role="menu">
                <div className="menu-popover__header">
                  <strong>{user.fullName}</strong>
                  <span>{user.email}</span>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false);
                    navigate('/profile');
                  }}
                >
                  Profile &amp; password
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false);
                    navigate('/notifications');
                  }}
                >
                  Notifications
                </button>
                <ThemeOptions />
              </div>
            ) : null}
          </div>
        </header>

        <main id="main-content" className="app-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function NotificationDot() {
  const { unreadNotifications } = useAuth();
  if (!unreadNotifications) return null;
  return (
    <span className="notification-dot" aria-hidden="true">
      {unreadNotifications > 9 ? '9+' : unreadNotifications}
    </span>
  );
}

function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['notifications', 'recent'],
    queryFn: () => api.list<NotificationRow>('/notifications', { pageSize: 8 }),
  });

  const markRead = useMutation({
    mutationFn: (id: number) => api.post(`/notifications/${id}/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
      void refresh();
    },
  });

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: async () => {
      toast.notify('All notifications marked as read.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
      await refresh();
    },
  });

  const items = data?.data ?? [];

  return (
    <div className="menu-popover menu-popover--wide" role="dialog" aria-label="Notifications">
      <div className="menu-popover__header menu-popover__header--row">
        <strong>Notifications</strong>
        <Button size="sm" variant="ghost" onClick={() => markAll.mutate()} loading={markAll.isPending}>
          Mark all read
        </Button>
      </div>
      {isLoading ? (
        <Loading label="Loading notifications…" />
      ) : items.length === 0 ? (
        <p className="menu-popover__empty">You have no notifications yet.</p>
      ) : (
        <ul className="notification-list">
          {items.map((item) => (
            <li key={item.id} className={item.read_at ? '' : 'notification-list__unread'}>
              <button
                type="button"
                onClick={() => {
                  if (!item.read_at) markRead.mutate(item.id);
                  if (item.link) navigate(item.link);
                  onClose();
                }}
              >
                <strong>{item.title}</strong>
                {item.body ? <span>{item.body}</span> : null}
                <small>{formatRelative(item.created_at)}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="menu-popover__footer"
        onClick={() => {
          navigate('/notifications');
          onClose();
        }}
      >
        View all notifications
      </button>
    </div>
  );
}

/** Standard two-column page wrapper used by most screens. */
export function PageShell({ children }: { children: ReactNode }) {
  return <div className="page">{children}</div>;
}
