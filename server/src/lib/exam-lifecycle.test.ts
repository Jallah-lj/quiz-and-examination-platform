import { describe, expect, it } from 'vitest';
import {
  assertExamTransition,
  canEditExam,
  canReceiveAttempts,
  canTransitionExam,
  EXAM_STATUS_LABELS,
  type ExamStatus,
} from './exam-lifecycle';

describe('examination lifecycle', () => {
  it('permits the documented forward path', () => {
    expect(canTransitionExam('DRAFT', 'SCHEDULED')).toBe(true);
    expect(canTransitionExam('SCHEDULED', 'ACTIVE')).toBe(true);
    expect(canTransitionExam('ACTIVE', 'UNDER_REVIEW')).toBe(true);
    expect(canTransitionExam('UNDER_REVIEW', 'PUBLISHED')).toBe(true);
    expect(canTransitionExam('PUBLISHED', 'ARCHIVED')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransitionExam('DRAFT', 'PUBLISHED')).toBe(false);
    expect(canTransitionExam('ARCHIVED', 'ACTIVE')).toBe(false);
    expect(canTransitionExam('PUBLISHED', 'DRAFT')).toBe(false);
    expect(canTransitionExam('UNDER_REVIEW', 'ACTIVE')).toBe(true);
  });

  it('never allows a state to transition to itself', () => {
    const states: ExamStatus[] = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'UNDER_REVIEW', 'PUBLISHED', 'ARCHIVED'];
    for (const state of states) {
      expect(canTransitionExam(state, state)).toBe(false);
      expect(assertExamTransition(state, state)).toMatch(/already/i);
    }
  });

  it('explains a rejected transition in plain language', () => {
    const message = assertExamTransition('DRAFT', 'PUBLISHED');
    expect(message).toContain('Draft');
    expect(message).toContain('Published');
  });

  it('labels every state', () => {
    for (const label of Object.values(EXAM_STATUS_LABELS)) {
      expect(label.length).toBeGreaterThan(2);
    }
  });

  it('locks editing once an examination is running', () => {
    expect(canEditExam('DRAFT')).toBe(true);
    expect(canEditExam('SCHEDULED')).toBe(true);
    expect(canEditExam('ACTIVE')).toBe(false);
    expect(canEditExam('PUBLISHED')).toBe(false);
    expect(canEditExam('ARCHIVED')).toBe(false);
  });

  it('only accepts attempts while the examination is open or scheduled', () => {
    expect(canReceiveAttempts('SCHEDULED')).toBe(true);
    expect(canReceiveAttempts('ACTIVE')).toBe(true);
    expect(canReceiveAttempts('DRAFT')).toBe(false);
    expect(canReceiveAttempts('ARCHIVED')).toBe(false);
    expect(canReceiveAttempts('PUBLISHED')).toBe(false);
  });
});
