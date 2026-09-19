/**
 * Examination lifecycle. Transitions are validated centrally so that no route can
 * move an examination into an invalid state.
 */
export type ExamStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'UNDER_REVIEW' | 'PUBLISHED' | 'ARCHIVED';

export type AttemptStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'UNDER_REVIEW' | 'GRADED' | 'EXPIRED' | 'VOID';

export const EXAM_STATUS_LABELS: Record<ExamStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  UNDER_REVIEW: 'Under review',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

/** Allowed lifecycle transitions. Keys are the current state. */
export const EXAM_TRANSITIONS: Record<ExamStatus, ExamStatus[]> = {
  DRAFT: ['SCHEDULED', 'ACTIVE', 'ARCHIVED'],
  SCHEDULED: ['ACTIVE', 'DRAFT', 'ARCHIVED'],
  ACTIVE: ['UNDER_REVIEW', 'SCHEDULED', 'ARCHIVED'],
  UNDER_REVIEW: ['PUBLISHED', 'ACTIVE', 'ARCHIVED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function canTransitionExam(from: ExamStatus, to: ExamStatus): boolean {
  if (from === to) return false;
  return (EXAM_TRANSITIONS[from] ?? []).includes(to);
}

export function assertExamTransition(from: ExamStatus, to: ExamStatus): string | null {
  if (from === to) return `The examination is already ${EXAM_STATUS_LABELS[to].toLowerCase()}.`;
  if (!canTransitionExam(from, to)) {
    return `An examination cannot move from ${EXAM_STATUS_LABELS[from]} to ${EXAM_STATUS_LABELS[to]}.`;
  }
  return null;
}

/** Editing is only permitted while the examination is not yet locked down. */
export function canEditExam(status: ExamStatus): boolean {
  return status === 'DRAFT' || status === 'SCHEDULED';
}

export function canReceiveAttempts(status: ExamStatus): boolean {
  return status === 'SCHEDULED' || status === 'ACTIVE';
}

export function isTerminalAttemptStatus(status: AttemptStatus): boolean {
  return status !== 'IN_PROGRESS';
}

export const ATTEMPT_STATUS_LABELS: Record<AttemptStatus, string> = {
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Awaiting grading',
  GRADED: 'Graded',
  EXPIRED: 'Expired',
  VOID: 'Voided',
};
