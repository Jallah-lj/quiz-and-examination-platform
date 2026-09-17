/**
 * Dashboard building blocks shared by the candidate, examiner and administrator views.
 *
 * Everything rendered here is driven by figures the API aggregated from live records;
 * nothing is estimated, and an empty value is shown as "not recorded yet" rather than
 * being replaced by a placeholder number.
 */
import { Link } from 'react-router-dom';
import { Badge, type BadgeTone } from './ui';
import { formatDateTime } from '../lib/format';
import { IconClock, IconInfo, IconWarning } from './Icons';

export interface AttentionItem {
  key: string;
  severity: 'info' | 'warning' | 'danger';
  title: string;
  detail: string;
  link: string;
}

const SEVERITY_TONES: Record<AttentionItem['severity'], BadgeTone> = {
  info: 'info',
  warning: 'warning',
  danger: 'danger',
};

const SEVERITY_LABELS: Record<AttentionItem['severity'], string> = {
  info: 'For information',
  warning: 'Action recommended',
  danger: 'Action required',
};

/**
 * The work queue for the signed-in role. Every entry links to the screen that already
 * shows the affected records, so nothing here is decorative.
 */
export function AttentionPanel({ items, title = 'Needs attention' }: { items: AttentionItem[]; title?: string }) {
  if (items.length === 0) {
    return (
      <section className="card" aria-labelledby="attention-heading">
        <header className="card__header">
          <div>
            <h2 id="attention-heading">{title}</h2>
            <p>Exceptions raised by the platform for the role you are signed in as.</p>
          </div>
          <div className="inline">
            <Badge tone="success">All clear</Badge>
          </div>
        </header>
        <div className="card__body">
          <p className="text-muted">
            Nothing requires your attention right now. This list fills automatically when work is waiting on you.
          </p>
        </div>
      </section>
    );
  }

  const ordered = [...items].sort((a, b) => {
    const rank = { danger: 0, warning: 1, info: 2 } as const;
    return rank[a.severity] - rank[b.severity];
  });

  return (
    <section className="card" aria-labelledby="attention-heading">
      <header className="card__header">
        <div>
          <h2 id="attention-heading">{title}</h2>
          <p>Each entry links to the screen where the underlying records can be actioned.</p>
        </div>
        <div className="inline">
          <Badge tone={ordered.some((item) => item.severity !== 'info') ? 'warning' : 'neutral'}>
            {items.length} item{items.length === 1 ? '' : 's'}
          </Badge>
        </div>
      </header>
      <div className="card__body card__body--flush">
        <ul className="attention-list">
        {ordered.map((item) => {
          const Icon = item.severity === 'info' ? IconInfo : IconWarning;
          return (
            <li key={item.key} className={`attention-list__item attention-list__item--${item.severity}`}>
              <span className="attention-list__icon" aria-hidden="true">
                <Icon size={16} />
              </span>
              <div className="attention-list__body">
                <div className="attention-list__title">
                  {item.title}
                  <Badge tone={SEVERITY_TONES[item.severity]}>{SEVERITY_LABELS[item.severity]}</Badge>
                </div>
                <p>{item.detail}</p>
              </div>
              <Link className="btn btn--sm" to={item.link}>
                Resolve
              </Link>
            </li>
          );
        })}
        </ul>
      </div>
    </section>
  );
}

/**
 * Movement against the previous comparable period. Direction is rendered as text
 * ("up 12%") so it never depends on colour alone; when there is no comparable period
 * the figure is stated as unavailable instead of being invented.
 */
export function StatDelta({
  delta,
  unit = '',
  periodLabel,
}: {
  delta: { current: number; previous: number; changePercent: number | null; days: number };
  unit?: string;
  periodLabel?: string;
}) {
  const period = periodLabel ?? `last ${delta.days} days`;
  if (delta.changePercent === null) {
    return (
      <span className="stat-delta stat-delta--flat">
        {delta.current}
        {unit} in the {period} · no comparable earlier period
      </span>
    );
  }
  const rising = delta.changePercent > 0;
  const flat = delta.changePercent === 0;
  return (
    <span className={`stat-delta ${flat ? 'stat-delta--flat' : rising ? 'stat-delta--up' : 'stat-delta--down'}`}>
      {flat ? 'No change' : `${rising ? 'Up' : 'Down'} ${Math.abs(delta.changePercent)}%`} versus the previous {period}
    </span>
  );
}

/** Countdown to the paper that closes first, computed from the server clock. */
export function DeadlineBanner({
  deadline,
  serverTime,
  onStart,
}: {
  deadline: { kind: 'EXAM' | 'QUIZ'; id: number; title: string; subject_name: string | null; due_at: string; action: 'start' | 'resume' } | null;
  serverTime: string;
  onStart?: () => void;
}) {
  if (!deadline) {
    return (
      <section className="deadline deadline--none" aria-label="Next deadline">
        <div className="deadline__icon" aria-hidden="true">
          <IconClock size={20} />
        </div>
        <div className="deadline__body">
          <strong>Nothing is due</strong>
          <p>You have no assessment inside its availability window. Scheduled papers appear here before they open.</p>
        </div>
      </section>
    );
  }

  const dueInMs = new Date(deadline.due_at).getTime() - new Date(serverTime).getTime();
  const hours = Math.floor(Math.max(0, dueInMs) / 3_600_000);
  const urgent = hours < 24;
  const remaining =
    dueInMs <= 0
      ? 'closing now'
      : hours >= 48
        ? `${Math.floor(hours / 24)} days remaining`
        : hours >= 1
          ? `${hours} hour${hours === 1 ? '' : 's'} remaining`
          : 'under an hour remaining';

  return (
    <section className={`deadline ${urgent ? 'deadline--urgent' : ''}`} aria-label="Next deadline">
      <div className="deadline__icon" aria-hidden="true">
        <IconClock size={20} />
      </div>
      <div className="deadline__body">
        <strong>
          {deadline.action === 'resume' ? 'Resume' : 'Next up'}: {deadline.title}
        </strong>
        <p>
          {deadline.subject_name ? `${deadline.subject_name} · ` : ''}
          {deadline.kind === 'EXAM' ? 'Examination' : 'Quiz'} closes{' '}
          <time dateTime={deadline.due_at}>{formatDateTime(deadline.due_at)}</time>
        </p>
        <p className="deadline__remaining">{remaining}</p>
      </div>
      <div className="deadline__actions">
        {deadline.action === 'resume' ? (
          <Link className="btn btn--primary btn--sm" to="/my-attempts">
            Resume attempt
          </Link>
        ) : onStart ? (
          <button type="button" className="btn btn--primary btn--sm" onClick={onStart}>
            Start now
          </button>
        ) : null}
        <Link className="btn btn--sm" to={deadline.kind === 'EXAM' ? `/examinations/${deadline.id}` : `/quizzes/${deadline.id}`}>
          Details
        </Link>
      </div>
    </section>
  );
}

/** Ranked bars for a small set of named values (subjects, classes, papers). */
export function MetricList({
  items,
  max,
  valueSuffix = '%',
  emptyLabel,
}: {
  items: { id: string | number; label: string; value: number; meta?: string }[];
  max?: number;
  valueSuffix?: string;
  emptyLabel: string;
}) {
  if (items.length === 0) return <p className="text-muted">{emptyLabel}</p>;
  const ceiling = max ?? Math.max(...items.map((item) => item.value), 1);

  return (
    <ul className="metric-list">
      {items.map((item) => (
        <li key={item.id}>
          <span className="metric-list__label">
            {item.label}
            {item.meta ? <em>{item.meta}</em> : null}
          </span>
          <span className="metric-list__bar" aria-hidden="true">
            <i style={{ width: `${Math.max(2, Math.min(100, (item.value / ceiling) * 100))}%` }} />
          </span>
          <span>
            {item.value}
            {valueSuffix}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The examination lifecycle as a single strip: where every paper currently sits. */
export function PipelineStrip({ stages }: { stages: { status: string; count: number; window_open?: number }[] }) {
  const order = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'UNDER_REVIEW', 'PUBLISHED', 'ARCHIVED'];
  const labels: Record<string, string> = {
    DRAFT: 'Draft',
    SCHEDULED: 'Scheduled',
    ACTIVE: 'Active',
    UNDER_REVIEW: 'Under review',
    PUBLISHED: 'Published',
    ARCHIVED: 'Archived',
  };
  const byStatus = new Map(stages.map((stage) => [stage.status, stage]));
  const total = stages.reduce((sum, stage) => sum + stage.count, 0);

  if (total === 0) return <p className="text-muted">No examinations have been created yet.</p>;

  return (
    <ol className="pipeline" aria-label="Examinations by lifecycle status">
      {order.map((status) => {
        const stage = byStatus.get(status);
        const count = stage?.count ?? 0;
        return (
          <li key={status} className={`pipeline__stage ${count === 0 ? 'pipeline__stage--empty' : ''}`}>
            <span className="pipeline__count">{count}</span>
            <span className="pipeline__label">{labels[status]}</span>
            {stage?.window_open ? <Badge tone="info">Window open now</Badge> : null}
          </li>
        );
      })}
    </ol>
  );
}
