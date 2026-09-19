/** Shared request-scoped types used across middleware and routes. */
import type { Request } from 'express';

export type RoleCode = 'super_admin' | 'institution_admin' | 'teacher' | 'student';

export interface AuthUser {
  id: number;
  institutionId: number | null;
  roleId: number;
  roleCode: RoleCode;
  roleName: string;
  fullName: string;
  email: string;
  status: string;
  permissions: string[];
  /** Profile ids resolved per role (null when not applicable). */
  studentId: number | null;
  teacherId: number | null;
  classId: number | null;
  departmentId: number | null;
  sessionId: number;
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
  authToken?: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function paginate<T>(
  items: T[],
  meta: { page: number; pageSize: number; total: number },
): Paginated<T> {
  return {
    items,
    page: meta.page,
    pageSize: meta.pageSize,
    total: meta.total,
    totalPages: Math.max(1, Math.ceil(meta.total / meta.pageSize)),
  };
}
