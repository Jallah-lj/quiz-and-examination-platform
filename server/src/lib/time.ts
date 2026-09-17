/** Central time helpers. All persisted timestamps are ISO-8601 UTC strings. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: Date | string | number): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

export function addMinutes(iso: string, minutes: number): string {
  return addSeconds(iso, minutes * 60);
}

export function addHours(iso: string, hours: number): string {
  return addMinutes(iso, hours * 60);
}

export function addDays(iso: string, days: number): string {
  return addHours(iso, days * 24);
}

export function isPast(iso: string | null | undefined, reference: string = nowIso()): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() <= new Date(reference).getTime();
}

export function isFuture(iso: string | null | undefined, reference: string = nowIso()): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() > new Date(reference).getTime();
}

/** Whole seconds between two ISO timestamps (b - a). Negative when b is earlier. */
export function secondsBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);
}

/** Minimum of two ISO timestamps. */
export function minIso(a: string, b: string): string {
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

export function maxIso(a: string, b: string): string {
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/** Parses a user supplied date/time string, returning null when it is not a valid date. */
export function parseDate(input: unknown): Date | null {
  if (typeof input !== 'string' && typeof input !== 'number' && !(input instanceof Date)) return null;
  const date = new Date(input as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isValidIso(input: unknown): boolean {
  return typeof input === 'string' && parseDate(input) !== null;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
