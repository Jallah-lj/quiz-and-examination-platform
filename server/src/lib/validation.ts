import { z } from 'zod';
import { validationError } from './errors';

/** Parses with a Zod schema and converts failures into a 422 AppError with field details. */
export function parseWith<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    throw validationError('The submitted data is invalid.', details);
  }
  return result.data;
}

export const idParam = z.coerce.number().int().positive();

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  q: z.string().trim().max(200).optional(),
  sort: z.string().trim().max(60).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export function listQuery(req: { query: Record<string, unknown> }): ListQuery {
  return parseWith(listQuerySchema, req.query);
}

const isoDateTime = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !Number.isNaN(new Date(v).getTime()), 'Must be a valid date/time');

export const dateTime = isoDateTime;
export const optionalDateTime = isoDateTime.optional().nullable();

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(190);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters long.')
  .max(200, 'Password is too long.')
  .refine((v) => /[A-Za-z]/.test(v), 'Password must contain at least one letter.')
  .refine((v) => /[0-9]/.test(v), 'Password must contain at least one number.');

export const nameSchema = z.string().trim().min(2, 'Name is too short.').max(160);

/** Escapes user text for safe inclusion in CSV and PDF exports. */
export function sanitizeCsvValue(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  let out = str.replace(/\r?\n/g, ' ').replace(/"/g, '""');
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t]/.test(out)) out = `'${out}`;
  return `"${out}"`;
}
