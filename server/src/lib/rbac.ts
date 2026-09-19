/**
 * Permission catalogue and role → permission mapping. The mapping is a single
 * source of truth; every API route declares the permission it requires and the
 * middleware verifies it against the database-backed session.
 */
import type { RoleCode } from '../types';

export interface PermissionDef {
  code: string;
  name: string;
  category: string;
  description?: string;
}

export const PERMISSIONS: PermissionDef[] = [
  // Platform
  { code: 'platform.manage', name: 'Manage platform settings', category: 'Platform' },
  { code: 'institution.create', name: 'Create institutions', category: 'Platform' },
  { code: 'institution.view_all', name: 'View all institutions', category: 'Platform' },
  { code: 'institution.manage', name: 'Manage institution profile', category: 'Institution' },
  { code: 'settings.manage', name: 'Manage institution settings', category: 'Institution' },
  { code: 'role.manage', name: 'Manage roles & permissions', category: 'Platform' },

  // Users & people
  { code: 'user.view', name: 'View users', category: 'Users' },
  { code: 'user.create', name: 'Create users', category: 'Users' },
  { code: 'user.update', name: 'Update users', category: 'Users' },
  { code: 'user.status', name: 'Change account status', category: 'Users' },
  { code: 'user.reset_password', name: 'Reset user passwords', category: 'Users' },
  { code: 'student.view', name: 'View students', category: 'Users' },
  { code: 'student.manage', name: 'Manage students', category: 'Users' },
  { code: 'teacher.view', name: 'View teachers', category: 'Users' },
  { code: 'teacher.manage', name: 'Manage teachers', category: 'Users' },

  // Academic structure
  { code: 'department.manage', name: 'Manage departments', category: 'Academic' },
  { code: 'class.view', name: 'View classes', category: 'Academic' },
  { code: 'class.manage', name: 'Manage classes', category: 'Academic' },
  { code: 'subject.view', name: 'View subjects', category: 'Academic' },
  { code: 'subject.manage', name: 'Manage subjects', category: 'Academic' },
  { code: 'group.manage', name: 'Manage groups', category: 'Academic' },

  // Question bank
  { code: 'questionbank.view', name: 'View question banks', category: 'Question bank' },
  { code: 'questionbank.manage', name: 'Manage question banks', category: 'Question bank' },
  { code: 'question.view', name: 'View questions', category: 'Question bank' },
  { code: 'question.create', name: 'Create questions', category: 'Question bank' },
  { code: 'question.edit', name: 'Edit questions', category: 'Question bank' },
  { code: 'question.archive', name: 'Archive questions', category: 'Question bank' },
  { code: 'question.import', name: 'Import questions', category: 'Question bank' },

  // Quizzes
  { code: 'quiz.view', name: 'View quizzes', category: 'Quizzes' },
  { code: 'quiz.manage', name: 'Create and edit quizzes', category: 'Quizzes' },
  { code: 'quiz.publish', name: 'Publish quizzes', category: 'Quizzes' },

  // Examinations
  { code: 'exam.view', name: 'View examinations', category: 'Examinations' },
  { code: 'exam.create', name: 'Create examinations', category: 'Examinations' },
  { code: 'exam.edit', name: 'Edit examinations', category: 'Examinations' },
  { code: 'exam.assign', name: 'Assign examinations', category: 'Examinations' },
  { code: 'exam.publish', name: 'Publish examinations', category: 'Examinations' },
  { code: 'exam.archive', name: 'Archive examinations', category: 'Examinations' },
  { code: 'exam.monitor', name: 'Monitor live examination sessions', category: 'Examinations' },

  // Attempts
  { code: 'attempt.take', name: 'Sit examinations and quizzes', category: 'Attempts' },
  { code: 'attempt.view.own', name: 'View own attempts', category: 'Attempts' },
  { code: 'attempt.view.any', name: 'View any attempt', category: 'Attempts' },
  { code: 'attempt.void', name: 'Void an attempt', category: 'Attempts' },

  // Grading
  { code: 'grading.grade', name: 'Grade answers', category: 'Grading' },
  { code: 'grading.finalize', name: 'Finalise grading', category: 'Grading' },

  // Results & reports
  { code: 'result.view.own', name: 'View own results', category: 'Results' },
  { code: 'result.view.any', name: 'View all results', category: 'Results' },
  { code: 'result.publish', name: 'Publish results', category: 'Results' },
  { code: 'result.unpublish', name: 'Unpublish results', category: 'Results' },
  { code: 'result.export', name: 'Export results', category: 'Results' },
  { code: 'report.view', name: 'View reports', category: 'Reports' },
  { code: 'report.export', name: 'Export reports', category: 'Reports' },

  // Governance
  { code: 'grading_scheme.manage', name: 'Manage grading schemes', category: 'Governance' },
  { code: 'audit.view', name: 'View audit logs', category: 'Governance' },
  { code: 'notification.view', name: 'View notifications', category: 'Governance' },
];

export const ROLE_DEFINITIONS: Record<RoleCode, { name: string; description: string; scope: string }> = {
  super_admin: {
    name: 'Super Administrator',
    description: 'Platform owner. Manages institutions, administrators and global configuration.',
    scope: 'platform',
  },
  institution_admin: {
    name: 'Institution Administrator',
    description: 'Runs a single institution: people, academic structure, examinations and results.',
    scope: 'institution',
  },
  teacher: {
    name: 'Teacher / Examiner',
    description: 'Builds question banks, sets examinations and grades candidate work.',
    scope: 'institution',
  },
  student: {
    name: 'Student / Candidate',
    description: 'Sits assigned examinations and quizzes and views released results.',
    scope: 'self',
  },
};

const INSTITUTION_ADMIN_PERMISSIONS = [
  'institution.manage',
  'settings.manage',
  'user.view',
  'user.create',
  'user.update',
  'user.status',
  'user.reset_password',
  'student.view',
  'student.manage',
  'teacher.view',
  'teacher.manage',
  'department.manage',
  'class.view',
  'class.manage',
  'subject.view',
  'subject.manage',
  'group.manage',
  'questionbank.view',
  'questionbank.manage',
  'question.view',
  'question.create',
  'question.edit',
  'question.archive',
  'question.import',
  'quiz.view',
  'quiz.manage',
  'quiz.publish',
  'exam.view',
  'exam.create',
  'exam.edit',
  'exam.assign',
  'exam.publish',
  'exam.archive',
  'exam.monitor',
  'attempt.view.any',
  'attempt.void',
  'grading.grade',
  'grading.finalize',
  'result.view.any',
  'result.publish',
  'result.unpublish',
  'result.export',
  'report.view',
  'report.export',
  'grading_scheme.manage',
  'audit.view',
  'notification.view',
];

const TEACHER_PERMISSIONS = [
  'subject.view',
  'class.view',
  'student.view',
  'group.manage',
  'questionbank.view',
  'questionbank.manage',
  'question.view',
  'question.create',
  'question.edit',
  'question.archive',
  'question.import',
  'quiz.view',
  'quiz.manage',
  'quiz.publish',
  'exam.view',
  'exam.create',
  'exam.edit',
  'exam.assign',
  'exam.publish',
  'exam.archive',
  'exam.monitor',
  'attempt.view.any',
  'grading.grade',
  'grading.finalize',
  'result.view.any',
  'result.publish',
  'result.export',
  'report.view',
  'report.export',
  'grading_scheme.manage',
  'notification.view',
];

const STUDENT_PERMISSIONS = [
  'attempt.take',
  'attempt.view.own',
  'result.view.own',
  'notification.view',
];

export const ROLE_PERMISSIONS: Record<RoleCode, string[] | 'all'> = {
  super_admin: 'all',
  institution_admin: INSTITUTION_ADMIN_PERMISSIONS,
  teacher: TEACHER_PERMISSIONS,
  student: STUDENT_PERMISSIONS,
};

export function permissionsForRole(role: RoleCode): string[] {
  const mapping = ROLE_PERMISSIONS[role];
  if (mapping === 'all') return PERMISSIONS.map((p) => p.code);
  return mapping;
}
