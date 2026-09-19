import { z } from 'zod';
import { validationError } from './errors';
import { nowIso } from './time';

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

/**
 * Contact number. Deliberately permissive about formatting — the same number is written
 * `+250 788 123 456`, `0788-123-456` and `(0788) 123456` by different people — but it must
 * still contain enough digits to be dialled.
 */
export const phoneSchema = z
  .string()
  .trim()
  .min(7, 'Enter a contact number.')
  .max(40, 'That number is too long.')
  .regex(/^[+()\-.\s0-9]+$/, 'Use digits, spaces and the characters + ( ) - . only.')
  .refine((value) => (value.match(/[0-9]/g) ?? []).length >= 7, 'Enter at least 7 digits.');

/**
 * Gender, as the student registry stores it. The seeded student records use this same
 * vocabulary, and `undisclosed` is a real answer rather than a missing value — a candidate
 * who declines to state it is not counted as incomplete data.
 */
export const STUDENT_GENDERS = ['female', 'male', 'other', 'undisclosed'] as const;
export type StudentGender = (typeof STUDENT_GENDERS)[number];
export const genderSchema = z.enum(STUDENT_GENDERS);

function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Date of birth on a candidate's own registration. Compared as a plain `YYYY-MM-DD` string:
 * it is a calendar date, not an instant, so no time zone may shift it by a day.
 */
export const dateOfBirthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD.')
  .refine(isRealCalendarDate, 'That date does not exist.')
  .refine((value) => value >= '1900-01-01', 'That date of birth is too far in the past.')
  .refine((value) => value <= nowIso().slice(0, 10), 'Date of birth cannot be in the future.');

/** Escapes user text for safe inclusion in CSV and PDF exports. */
export function sanitizeCsvValue(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  let out = str.replace(/\r?\n/g, ' ').replace(/"/g, '""');
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t]/.test(out)) out = `'${out}`;
  return `"${out}"`;
}
