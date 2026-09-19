import { describe, expect, it } from 'vitest';
import {
  clampMarks,
  gradeObjective,
  matchFreeText,
  normalizeFreeText,
  percentage,
  round2,
  setsEqual,
} from './answer-key';
import { computeFinalScore, gradeForPercentage, validateBands, DEFAULT_BANDS } from './grading';

describe('objective grading', () => {
  it('awards full marks for a correct single-choice answer', () => {
    const result = gradeObjective(
      'MCQ',
      { selectedOptions: ['B'], answerText: null },
      { correctOptions: ['B'] },
      5,
      1,
    );
    expect(result).toEqual({ isCorrect: true, awarded: 5, partial: false });
  });

  it('applies the configured negative mark for a wrong answer', () => {
    const result = gradeObjective(
      'MCQ',
      { selectedOptions: ['A'], answerText: null },
      { correctOptions: ['B'] },
      5,
      1.5,
    );
    expect(result.isCorrect).toBe(false);
    expect(result.awarded).toBe(-1.5);
  });

  it('never penalises an unanswered question', () => {
    const result = gradeObjective('MCQ', { selectedOptions: [], answerText: null }, { correctOptions: ['B'] }, 5, 2);
    expect(result.awarded).toBe(0);
  });

  it('ignores option order when the key has several correct options', () => {
    const key = { correctOptions: ['A', 'C'], allowPartial: false };
    const forwards = gradeObjective('MCQ', { selectedOptions: ['A', 'C'], answerText: null }, key, 4, 0);
    const backwards = gradeObjective('MCQ', { selectedOptions: ['C', 'A'], answerText: null }, key, 4, 0);
    expect(forwards.isCorrect).toBe(true);
    expect(backwards.isCorrect).toBe(true);
    expect(forwards.awarded).toBe(4);
  });

  it('awards partial credit for a partial multi-select answer when enabled', () => {
    const result = gradeObjective(
      'MCQ',
      { selectedOptions: ['A'], answerText: null },
      { correctOptions: ['A', 'B', 'C'], allowPartial: true },
      6,
      0,
    );
    expect(result.partial).toBe(true);
    expect(result.awarded).toBe(2);
    expect(result.isCorrect).toBe(false);
  });

  it('gives no partial credit when the selection includes an incorrect option', () => {
    const result = gradeObjective(
      'MCQ',
      { selectedOptions: ['A', 'D'], answerText: null },
      { correctOptions: ['A', 'B'], allowPartial: true },
      6,
      0,
    );
    expect(result.awarded).toBe(0);
    expect(result.partial).toBe(false);
  });

  it('grades true/false answers', () => {
    const correct = gradeObjective('TRUE_FALSE', { selectedOptions: ['A'], answerText: null }, { correctOptions: ['A'] }, 2, 0);
    const wrong = gradeObjective('TRUE_FALSE', { selectedOptions: ['B'], answerText: null }, { correctOptions: ['A'] }, 2, 0.5);
    expect(correct.awarded).toBe(2);
    expect(wrong.awarded).toBe(-0.5);
  });
});

describe('fill-in-the-blank matching', () => {
  it('matches case-insensitively and ignores surrounding whitespace by default', () => {
    expect(matchFreeText('  paris ', { acceptedAnswers: ['Paris'] }).correct).toBe(true);
  });

  it('respects case sensitivity when configured', () => {
    expect(matchFreeText('paris', { acceptedAnswers: ['Paris'], caseSensitive: true }).correct).toBe(false);
    expect(matchFreeText('Paris', { acceptedAnswers: ['Paris'], caseSensitive: true }).correct).toBe(true);
  });

  it('accepts any alternative listed by the examiner', () => {
    const result = gradeObjective(
      'FILL_BLANK',
      { selectedOptions: [], answerText: '2NF' },
      { acceptedAnswers: ['2', 'Second normal form', '2NF'] },
      3,
      0,
    );
    expect(result.isCorrect).toBe(true);
    expect(result.awarded).toBe(3);
  });

  it('applies a numeric tolerance when configured', () => {
    const within = matchFreeText('3.14', { acceptedAnswers: ['3.14159'], numericTolerance: 0.01 });
    const outside = matchFreeText('3.2', { acceptedAnswers: ['3.14159'], numericTolerance: 0.01 });
    expect(within.correct).toBe(true);
    expect(outside.correct).toBe(false);
  });

  it('penalises an incorrect blank when negative marking is enabled', () => {
    const result = gradeObjective('FILL_BLANK', { selectedOptions: [], answerText: 'Lyon' }, { acceptedAnswers: ['Paris'] }, 4, 1);
    expect(result.awarded).toBe(-1);
  });

  it('normalises whitespace before comparison', () => {
    expect(normalizeFreeText('  Data   Structures ')).toBe('data structures');
  });
});

describe('percentage and grade derivation', () => {
  it('computes rounded percentages', () => {
    expect(percentage(78, 100)).toBe(78);
    expect(percentage(1, 3)).toBe(33.33);
    expect(percentage(10, 0)).toBe(0);
  });

  it('maps percentages onto the configured grading scale', () => {
    expect(gradeForPercentage(95, DEFAULT_BANDS)?.grade).toBe('A+');
    expect(gradeForPercentage(85, DEFAULT_BANDS)?.grade).toBe('A');
    expect(gradeForPercentage(72.5, DEFAULT_BANDS)?.grade).toBe('B');
    expect(gradeForPercentage(49.99, DEFAULT_BANDS)?.grade).toBe('F');
  });

  it('handles exact band boundaries deterministically', () => {
    expect(gradeForPercentage(90, DEFAULT_BANDS)?.grade).toBe('A+');
    expect(gradeForPercentage(89.99, DEFAULT_BANDS)?.grade).toBe('A');
    expect(gradeForPercentage(0, DEFAULT_BANDS)?.grade).toBe('F');
    expect(gradeForPercentage(100, DEFAULT_BANDS)?.grade).toBe('A+');
  });

  it('produces a pass/fail outcome against the pass mark', () => {
    const passed = computeFinalScore({ totalMarks: 100, obtainedMarks: 78, passMark: 50, bands: DEFAULT_BANDS });
    expect(passed).toMatchObject({ percentage: 78, grade: 'B', outcome: 'PASSED', passMark: 50 });

    const failed = computeFinalScore({ totalMarks: 100, obtainedMarks: 49, passMark: 50, bands: DEFAULT_BANDS });
    expect(failed.outcome).toBe('FAILED');

    const boundary = computeFinalScore({ totalMarks: 100, obtainedMarks: 50, passMark: 50, bands: DEFAULT_BANDS });
    expect(boundary.outcome).toBe('PASSED');
  });

  it('clamps negative totals to zero', () => {
    const result = computeFinalScore({ totalMarks: 50, obtainedMarks: -4, passMark: 25, bands: DEFAULT_BANDS });
    expect(result.obtainedMarks).toBe(0);
    expect(result.outcome).toBe('FAILED');
  });
});

describe('grading scheme validation', () => {
  it('accepts a complete, non-overlapping scale', () => {
    expect(validateBands(DEFAULT_BANDS)).toEqual([]);
  });

  it('rejects overlapping bands', () => {
    const problems = validateBands([
      { grade: 'A', min_percentage: 70, max_percentage: 100 },
      { grade: 'B', min_percentage: 0, max_percentage: 80 },
    ]);
    expect(problems.join(' ')).toMatch(/overlap/i);
  });

  it('rejects a scale that does not cover the full range', () => {
    const problems = validateBands([{ grade: 'A', min_percentage: 40, max_percentage: 90 }]);
    expect(problems.join(' ')).toMatch(/start at 0|reach 100/i);
  });

  it('rejects duplicate grade labels', () => {
    const problems = validateBands([
      { grade: 'A', min_percentage: 50, max_percentage: 100 },
      { grade: 'A', min_percentage: 0, max_percentage: 49.99 },
    ]);
    expect(problems.join(' ')).toMatch(/duplicate/i);
  });
});

describe('small numeric helpers', () => {
  it('rounds to two decimals without floating point drift', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(10)).toBe(10);
  });

  it('clamps awarded marks inside the permitted range', () => {
    expect(clampMarks(12, 10)).toBe(10);
    expect(clampMarks(-3, 10)).toBe(0);
    expect(clampMarks(Number.NaN, 10)).toBe(0);
  });

  it('compares option sets irrespective of order and duplicates', () => {
    expect(setsEqual(['a', 'B'], ['B', 'A'])).toBe(true);
    expect(setsEqual(['A', 'A'], ['A'])).toBe(true);
    expect(setsEqual(['A'], ['A', 'B'])).toBe(false);
  });
});
