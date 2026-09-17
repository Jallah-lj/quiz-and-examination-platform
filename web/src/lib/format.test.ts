import { describe, expect, it } from 'vitest';
import {
  formatCountdown,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMark,
  formatPercentage,
  formatRelative,
  fromDateTimeLocal,
  initials,
  pluralise,
  titleCase,
  toDateTimeLocal,
} from './format';

describe('format helpers', () => {
  it('renders marks with up to two decimals and never shows -0', () => {
    expect(formatMark(12)).toBe('12');
    expect(formatMark(12.5)).toBe('12.5');
    expect(formatMark(12.456)).toBe('12.46');
    expect(formatMark(-0)).toBe('0');
    expect(formatMark(null)).toBe('—');
  });

  it('formats percentages to two decimals', () => {
    expect(formatPercentage(0)).toBe('0%');
    expect(formatPercentage(66.666)).toBe('66.67%');
    expect(formatPercentage(undefined)).toBe('—');
  });

  it('formats the examination countdown as mm:ss and h:mm:ss', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(59)).toBe('00:59');
    expect(formatCountdown(125)).toBe('02:05');
    expect(formatCountdown(3661)).toBe('1:01:01');
    expect(formatCountdown(-5)).toBe('00:00');
  });

  it('formats durations in minutes and hours', () => {
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(60)).toBe('1 h');
    expect(formatDuration(150)).toBe('2 h 30 min');
    expect(formatDuration(null)).toBe('—');
  });

  it('round-trips datetime-local values without shifting the wall clock time', () => {
    const local = toDateTimeLocal('2026-09-24T16:28:00.000Z');
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const parsed = fromDateTimeLocal(local);
    expect(parsed).toBeTruthy();
    expect(new Date(parsed as string).getTime()).toBe(new Date('2026-09-24T16:28:00.000Z').getTime());
  });

  it('formats dates defensively', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
    expect(formatRelative(null)).toBe('—');
    expect(formatDateTime('2026-09-17T10:15:00.000Z')).toMatch(/2026/);
  });

  it('derives initials and title case labels', () => {
    expect(initials('Sofia Mensah')).toBe('SM');
    expect(initials('sofia')).toBe('S');
    expect(initials(null)).toBe('?');
    expect(titleCase('institution_admin')).toBe('Institution Admin');
    expect(titleCase(null)).toBe('—');
  });

  it('pluralises counts for empty and populated states', () => {
    expect(pluralise(0, 'question')).toBe('0 questions');
    expect(pluralise(1, 'question')).toBe('1 question');
    expect(pluralise(2, 'question')).toBe('2 questions');
    expect(pluralise(3, 'entry', 'entries')).toBe('3 entries');
  });
});
