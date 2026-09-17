import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { env } from '../config/env';

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'The requested endpoint does not exist.' },
  });
}

/** Central error translator. Internal details are only logged, never returned. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    const payload: Record<string, unknown> = { code: err.code, message: err.publicMessage };
    if (err.details) payload.details = err.details;
    res.status(err.status).json({ error: payload });
    return;
  }

  // better-sqlite3 constraint failures are translated into safe, actionable messages.
  const message = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed/i.test(message)) {
    res.status(409).json({
      error: { code: 'CONFLICT', message: 'A record with those details already exists.' },
    });
    return;
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'This record is referenced by other data and cannot be changed as requested.',
      },
    });
    return;
  }
  if (/CHECK constraint failed/i.test(message)) {
    res.status(422).json({
      error: { code: 'UNPROCESSABLE', message: 'The submitted values are outside the allowed range.' },
    });
    return;
  }
  if (/SQLITE_BUSY|database is locked/i.test(message)) {
    res.status(503).json({
      error: { code: 'INTERNAL', message: 'The database is busy. Please retry in a moment.' },
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'An unexpected server error occurred. The incident has been logged.',
      ...(env.isProd ? {} : { detail: message }),
    },
  });
}
