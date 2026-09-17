/** Formatting helpers shared by every screen. */

export function formatDate(value?: string | null, options: Intl.DateTimeFormatOptions = {}): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric', ...options });
}

export function formatDateTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "in 2 hours", "3 days ago" — used for scheduling hints, never for marks. */
export function formatRelative(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value).getTime();
  if (Number.isNaN(date)) return '—';
  const diffSeconds = Math.round((date - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 45) return diffSeconds >= 0 ? 'in a moment' : 'just now';

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.345],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];
  let value_ = diffSeconds;
  for (const [unit, divisor] of units) {
    if (Math.abs(value_) < divisor || unit === 'year') {
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(value_), unit);
    }
    value_ /= divisor;
  }
  return '';
}

export function formatNumber(value?: number | null, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatMark(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

export function formatPercentage(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(2).replace(/\.00$/, '')}%`;
}

/** mm:ss / h:mm:ss countdown used by the examination timer. */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

export function formatDuration(minutes?: number | null): string {
  if (!minutes && minutes !== 0) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function initials(name?: string | null): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function titleCase(value?: string | null): string {
  if (!value) return '—';
  return value
    .toLowerCase()
    .split(/[\s_-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Converts an ISO timestamp into the value expected by <input type="datetime-local">. */
export function toDateTimeLocal(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export function fromDateTimeLocal(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}
