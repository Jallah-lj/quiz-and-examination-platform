/**
 * Shared domain error types. Route handlers throw these; the central error
 * middleware converts them into consistent JSON error payloads and makes sure
 * that internal details (SQL messages, stack traces) never leak to clients.
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly publicMessage: string;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.publicMessage = message;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export const badRequest = (message = 'The request could not be processed.', details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const validationError = (message = 'The submitted data is invalid.', details?: unknown) =>
  new AppError(422, 'VALIDATION_ERROR', message, details);

export const unauthenticated = (message = 'Authentication required.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have permission to perform this action.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'The requested resource was not found.') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message = 'The request conflicts with the current state of the resource.') =>
  new AppError(409, 'CONFLICT', message);

export const unprocessable = (message = 'The request cannot be completed.', details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE', message, details);

export const rateLimited = (message = 'Too many requests. Please try again later.') =>
  new AppError(429, 'RATE_LIMITED', message);

export const internal = (message = 'An unexpected server error occurred.') =>
  new AppError(500, 'INTERNAL', message);
