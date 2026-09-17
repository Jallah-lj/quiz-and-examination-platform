import type { Db } from '../db';
import { percentage, round2 } from './answer-key';

export interface GradingBandInput {
  grade: string;
  min_percentage: number;
  max_percentage: number;
  points?: number | null;
  remark?: string | null;
}

export const DEFAULT_BANDS: GradingBandInput[] = [
  { grade: 'A+', min_percentage: 90, max_percentage: 100, points: 4, remark: 'Outstanding' },
  { grade: 'A', min_percentage: 80, max_percentage: 89.99, points: 4, remark: 'Excellent' },
  { grade: 'B', min_percentage: 70, max_percentage: 79.99, points: 3, remark: 'Very good' },
  { grade: 'C', min_percentage: 60, max_percentage: 69.99, points: 2, remark: 'Good' },
  { grade: 'D', min_percentage: 50, max_percentage: 59.99, points: 1, remark: 'Satisfactory' },
  { grade: 'F', min_percentage: 0, max_percentage: 49.99, points: 0, remark: 'Fail' },
];

export interface ResolvedScheme {
  schemeId: number | null;
  schemeName: string;
  passPercentage: number;
  bands: GradingBandInput[];
}

/**
 * Resolves the grading scheme for an exam: the exam's explicit scheme, otherwise the
 * institution default, otherwise the platform default bands (never hard-coded inline).
 */
export function resolveScheme(db: Db, institutionId: number, examSchemeId?: number | null): ResolvedScheme {
  let scheme: any = null;

  if (examSchemeId) {
    scheme = db
      .prepare('SELECT * FROM grading_schemes WHERE id = ? AND institution_id = ?')
      .get(examSchemeId, institutionId);
  }
  if (!scheme) {
    scheme = db
      .prepare(
        'SELECT * FROM grading_schemes WHERE institution_id = ? ORDER BY is_default DESC, id ASC LIMIT 1',
      )
      .get(institutionId);
  }
  if (!scheme) {
    return {
      schemeId: null,
      schemeName: 'Standard grading scale',
      passPercentage: 50,
      bands: DEFAULT_BANDS,
    };
  }
  const bands = db
    .prepare('SELECT * FROM grading_bands WHERE scheme_id = ? ORDER BY min_percentage DESC')
    .all(scheme.id) as GradingBandInput[];
  return {
    schemeId: scheme.id,
    schemeName: scheme.name,
    passPercentage: Number(scheme.pass_percentage),
    bands: bands.length ? bands : DEFAULT_BANDS,
  };
}

/** Maps a percentage onto the configured grading scale. */
export function gradeForPercentage(pct: number, bands: GradingBandInput[]): GradingBandInput | null {
  const rounded = round2(pct);
  const match = bands.find(
    (b) => rounded >= Number(b.min_percentage) && rounded <= Number(b.max_percentage),
  );
  if (match) return match;
  // Boundary fall-back (e.g. 89.995 rounding edges) deterministically picks the nearest band.
  let best: GradingBandInput | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const band of bands) {
    const distance = Math.min(
      Math.abs(rounded - Number(band.min_percentage)),
      Math.abs(rounded - Number(band.max_percentage)),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = band;
    }
  }
  return best;
}

export interface FinalScore {
  totalMarks: number;
  obtainedMarks: number;
  percentage: number;
  grade: string | null;
  points: number | null;
  outcome: 'PASSED' | 'FAILED';
  passMark: number;
}

/**
 * Single source of truth for turning raw marks into a final result.
 * `passMark` is an absolute mark threshold (exam.pass_marks).
 */
export function computeFinalScore(params: {
  totalMarks: number;
  obtainedMarks: number;
  passMark: number;
  bands: GradingBandInput[];
}): FinalScore {
  const { totalMarks, passMark, bands } = params;
  const obtained = round2(Math.max(0, params.obtainedMarks));
  const pct = percentage(obtained, totalMarks);
  const band = gradeForPercentage(pct, bands);
  return {
    totalMarks: round2(totalMarks),
    obtainedMarks: obtained,
    percentage: pct,
    grade: band?.grade ?? null,
    points: band?.points ?? null,
    outcome: obtained >= passMark && obtained > 0 ? 'PASSED' : 'FAILED',
    passMark: round2(passMark),
  };
}

/** Validates that a set of bands covers 0–100 without overlaps or gaps. */
export function validateBands(bands: GradingBandInput[]): string[] {
  const problems: string[] = [];
  if (!bands.length) return ['At least one grading band is required.'];
  const sorted = [...bands].sort((a, b) => a.min_percentage - b.min_percentage);
  const seen = new Set<string>();
  for (const band of sorted) {
    if (!band.grade?.trim()) problems.push('Every band requires a grade label.');
    if (seen.has(band.grade.trim().toUpperCase())) problems.push(`Duplicate grade label ${band.grade}.`);
    seen.add(band.grade.trim().toUpperCase());
    if (band.max_percentage < band.min_percentage) {
      problems.push(`Band ${band.grade}: maximum cannot be lower than minimum.`);
    }
  }
  if (sorted[0].min_percentage !== 0) problems.push('The lowest band must start at 0%.');
  const top = sorted[sorted.length - 1];
  if (top.max_percentage < 100) problems.push('The highest band must reach 100%.');
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (curr.min_percentage <= prev.max_percentage) {
      problems.push(`Bands ${prev.grade} and ${curr.grade} overlap.`);
    }
    const gap = curr.min_percentage - prev.max_percentage;
    if (gap > 0.02) {
      problems.push(`There is a gap between bands ${prev.grade} and ${curr.grade}.`);
    }
  }
  return problems;
}
