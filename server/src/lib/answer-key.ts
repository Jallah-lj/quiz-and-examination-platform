/**
 * Deterministic, dependency-free answer-key helpers shared by the manual grading
 * UI, the auto-grader and the reports. No probabilistic behaviour anywhere.
 */

export type QuestionType = 'MCQ' | 'TRUE_FALSE' | 'SHORT_ANSWER' | 'ESSAY' | 'FILL_BLANK';

export const OBJECTIVE_TYPES: QuestionType[] = ['MCQ', 'TRUE_FALSE', 'FILL_BLANK'];

export function isObjectiveType(type: QuestionType): boolean {
  return OBJECTIVE_TYPES.includes(type);
}

export interface AnswerKey {
  /** Option labels that must be selected, e.g. ["B"] or ["A","C"] for multi-select. */
  correctOptions?: string[];
  /** Accepted free-text answers for FILL_BLANK / SHORT_ANSWER. */
  acceptedAnswers?: string[];
  caseSensitive?: boolean;
  allowPartial?: boolean;
  numericTolerance?: number;
}

export interface QuestionAnswerConfig {
  caseSensitive?: boolean;
  allowPartial?: boolean;
  numericTolerance?: number;
  acceptedAnswers?: string[];
}

export function parseAnswerConfig(raw: unknown): QuestionAnswerConfig {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as QuestionAnswerConfig;
  try {
    const parsed = JSON.parse(String(raw));
    return typeof parsed === 'object' && parsed !== null ? (parsed as QuestionAnswerConfig) : {};
  } catch {
    return {};
  }
}

export function normalizeFreeText(value: string, caseSensitive = false): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return caseSensitive ? collapsed : collapsed.toLowerCase();
}

function numericValue(value: string): number | null {
  const cleaned = value.replace(/[,\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Free-text matching used for FILL_BLANK and (optionally) SHORT_ANSWER.
 * Rules are fully configured by the examiner — no heuristics.
 */
export function matchFreeText(
  submitted: string,
  key: AnswerKey,
): { correct: boolean; partial: boolean } {
  const accepted = (key.acceptedAnswers ?? []).map((a) => String(a));
  if (accepted.length === 0) return { correct: false, partial: false };
  const caseSensitive = Boolean(key.caseSensitive);
  const submittedRaw = submitted ?? '';

  const submittedNorm = normalizeFreeText(submittedRaw, caseSensitive);
  if (submittedNorm.length === 0) return { correct: false, partial: false };

  for (const candidate of accepted) {
    const candidateNorm = normalizeFreeText(candidate, caseSensitive);
    if (candidateNorm === submittedNorm) return { correct: true, partial: false };

    // Numeric answers may be compared with a configured absolute tolerance.
    if (key.numericTolerance && key.numericTolerance > 0) {
      const a = numericValue(submittedRaw);
      const b = numericValue(candidate);
      if (a !== null && b !== null && Math.abs(a - b) <= key.numericTolerance) {
        return { correct: true, partial: false };
      }
    }
  }

  // Optional deterministic alternative: a keyword fraction rule. Only applied when the
  // examiner explicitly stored alternative syntax "a|b|c" as a single accepted answer.
  for (const candidate of accepted) {
    if (candidate.includes('|')) {
      const parts = candidate
        .split('|')
        .map((p) => normalizeFreeText(p, caseSensitive))
        .filter(Boolean);
      if (parts.length && parts.includes(submittedNorm)) return { correct: true, partial: false };
    }
  }

  return { correct: false, partial: false };
}

export function setsEqual(a: string[], b: string[]): boolean {
  const sa = [...new Set(a.map((x) => x.trim().toUpperCase()))].sort();
  const sb = [...new Set(b.map((x) => x.trim().toUpperCase()))].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

/**
 * Grades a single objective answer deterministically.
 * `negativeMarks` is only applied when the question carries a penalty and the
 * answer is wrong (an unanswered question never scores below zero for objective items).
 */
export function gradeObjective(
  type: QuestionType,
  submitted: { selectedOptions: string[]; answerText: string | null },
  key: AnswerKey,
  marks: number,
  negativeMarks: number,
): { isCorrect: boolean; awarded: number; partial: boolean } {
  const penalty = Math.max(0, negativeMarks);

  if (type === 'MCQ' || type === 'TRUE_FALSE') {
    const correct = key.correctOptions ?? [];
    const selected = submitted.selectedOptions ?? [];
    if (selected.length === 0) return { isCorrect: false, awarded: 0, partial: false };

    if (setsEqual(selected, correct)) return { isCorrect: true, awarded: marks, partial: false };

    // Partial credit for multi-select questions when explicitly enabled.
    if (key.allowPartial && correct.length > 1) {
      const correctSet = new Set(correct.map((c) => c.toUpperCase()));
      const selectedSet = new Set(selected.map((s) => s.toUpperCase()));
      const hits = [...selectedSet].filter((s) => correctSet.has(s)).length;
      const wrong = [...selectedSet].filter((s) => !correctSet.has(s)).length;
      if (hits > 0 && wrong === 0) {
        const awarded = round2((marks * hits) / correct.length);
        return { isCorrect: false, awarded, partial: true };
      }
    }
    return { isCorrect: false, awarded: penalty > 0 ? -penalty : 0, partial: false };
  }

  if (type === 'FILL_BLANK') {
    const text = submitted.answerText ?? '';
    if (normalizeFreeText(text, key.caseSensitive) === '') {
      return { isCorrect: false, awarded: 0, partial: false };
    }
    const result = matchFreeText(text, key);
    if (result.correct) return { isCorrect: true, awarded: marks, partial: false };
    return { isCorrect: false, awarded: penalty > 0 ? -penalty : 0, partial: false };
  }

  // Subjective types are graded manually; nothing is auto-awarded.
  return { isCorrect: false, awarded: 0, partial: false };
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function percentage(obtained: number, total: number): number {
  if (!total) return 0;
  return round2((obtained / total) * 100);
}

export function clampMarks(value: number, max: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(Math.max(value, 0), max);
}
