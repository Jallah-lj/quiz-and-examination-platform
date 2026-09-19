import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Paginated } from '../types';

/** Wraps async handlers so rejected promises reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function ok<T>(res: Response, data: T, status = 200, meta?: unknown): Response {
  const payload: Record<string, unknown> = { data };
  if (meta) payload.meta = meta;
  return res.status(status).json(payload);
}

export function okList<T>(res: Response, result: Paginated<T>): Response {
  return res.json({
    data: result.items,
    meta: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
}

export function created<T>(res: Response, data: T, meta?: unknown): Response {
  return ok(res, data, 201, meta);
}

export function noContent(res: Response): Response {
  return res.status(204).end();
}

/** Builds the ORDER BY fragment from an allow-list to prevent SQL injection. */
export function orderByClause(
  sort: string | undefined,
  order: 'asc' | 'desc',
  allowList: Record<string, string>,
  fallback: string,
): string {
  if (sort && allowList[sort]) {
    return `ORDER BY ${allowList[sort]} ${order === 'asc' ? 'ASC' : 'DESC'}`;
  }
  return `ORDER BY ${fallback}`;
}

export function likeTerm(term: string): string {
  return `%${term.replace(/[%_]/g, (m) => `\\${m}`)}%`;
}

export function sqliteUpdate(patch: Record<string, unknown>): { clause: string; values: unknown[] } {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  const clause = keys.map((k) => `${k} = ?`).join(', ');
  return { clause, values: keys.map((k) => patch[k] as unknown) };
}
