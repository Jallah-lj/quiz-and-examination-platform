/** Shared UI primitives. Kept dependency-free so behaviour stays predictable. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { IconClose, IconInbox, IconInfo, IconWarning } from './Icons';

/* ------------------------------------------------------------------------ button */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'success' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
};

export function Button({ variant = 'default', size = 'md', loading, children, className = '', ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'default' ? `btn--${variant}` : '', size !== 'md' ? `btn--${size}` : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={classes} disabled={rest.disabled || loading} {...rest}>
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------------- fields */
interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, hint, error, required, children, className = '' }: FieldProps) {
  return (
    <div className={`field ${required ? 'field--required' : ''} ${className}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error ? <span className="field__hint">{hint}</span> : null}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  wrapperClassName?: string;
}

export function TextInput({ label, hint, error, wrapperClassName, id, ...rest }: TextInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const input = (
    <input
      id={inputId}
      className="input"
      aria-invalid={error ? 'true' : undefined}
      aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
      {...rest}
    />
  );
  if (!label) return input;
  return (
    <Field
      label={label}
      htmlFor={inputId}
      hint={hint}
      error={error}
      required={rest.required}
      className={wrapperClassName ?? ''}
    >
      {input}
    </Field>
  );
}

interface SelectInputProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  options: { value: string | number; label: string }[];
  placeholder?: string;
  wrapperClassName?: string;
}

export function SelectInput({
  label,
  hint,
  error,
  options,
  placeholder,
  wrapperClassName,
  id,
  ...rest
}: SelectInputProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const select = (
    <select id={selectId} className="select" aria-invalid={error ? 'true' : undefined} {...rest}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
  if (!label) return select;
  return (
    <Field
      label={label}
      htmlFor={selectId}
      hint={hint}
      error={error}
      required={rest.required}
      className={wrapperClassName ?? ''}
    >
      {select}
    </Field>
  );
}

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
  wrapperClassName?: string;
}

export function TextArea({ label, hint, error, wrapperClassName, id, ...rest }: TextAreaProps) {
  const generatedId = useId();
  const areaId = id ?? generatedId;
  const area = (
    <textarea id={areaId} className="textarea" aria-invalid={error ? 'true' : undefined} {...rest} />
  );
  if (!label) return area;
  return (
    <Field label={label} htmlFor={areaId} hint={hint} error={error} className={wrapperClassName ?? ''}>
      {area}
    </Field>
  );
}

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  hint?: string;
}

export function Checkbox({ label, hint, id, ...rest }: CheckboxProps) {
  const generatedId = useId();
  const boxId = id ?? generatedId;
  return (
    <div className="checkbox-row">
      <input type="checkbox" id={boxId} {...rest} />
      <label htmlFor={boxId}>
        {label}
        {hint ? <span className="field__hint">{hint}</span> : null}
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------------ layout */
export function Card({
  title,
  description,
  actions,
  children,
  footer,
  flush,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card__header">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="inline">{actions}</div> : null}
        </header>
      )}
      <div className={`card__body ${flush ? 'card__body--flush' : ''}`}>{children}</div>
      {footer ? <footer className="card__footer">{footer}</footer> : null}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: { label: string; to?: string }[];
}) {
  return (
    <div className="page-header">
      <div className="page-header__text">
        {breadcrumbs?.length ? (
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`}>
                {crumb.to ? <a href={crumb.to}>{crumb.label}</a> : crumb.label}
                {index < breadcrumbs.length - 1 ? <span aria-hidden="true"> / </span> : null}
              </span>
            ))}
          </nav>
        ) : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </div>
  );
}

export function StatCard({
  label,
  value,
  meta,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}) {
  return (
    <div className={`stat-card ${tone !== 'neutral' ? `stat-card--${tone}` : ''}`}>
      <span className="stat-card__label">{label}</span>
      <span className="stat-card__value">{value}</span>
      {meta ? <span className="stat-card__meta">{meta}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- badge */
export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'outline';

export function Badge({ children, tone = 'neutral', size }: { children: ReactNode; tone?: BadgeTone; size?: 'lg' }) {
  return <span className={`badge badge--${tone} ${size === 'lg' ? 'badge--lg' : ''}`}>{children}</span>;
}

const EXAM_STATUS_TONES: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  SCHEDULED: 'info',
  ACTIVE: 'success',
  UNDER_REVIEW: 'warning',
  PUBLISHED: 'info',
  ARCHIVED: 'outline',
  CLOSED: 'outline',
  SUBMITTED: 'info',
  IN_PROGRESS: 'warning',
  GRADED: 'success',
  EXPIRED: 'danger',
  VOID: 'danger',
  PASSED: 'success',
  FAILED: 'danger',
  PENDING: 'warning',
  ACTIVEQ: 'success',
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  ACTIVE: 'Active',
  UNDER_REVIEW: 'Under review',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
  CLOSED: 'Closed',
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  GRADED: 'Graded',
  EXPIRED: 'Expired',
  VOID: 'Voided',
  PASSED: 'Passed',
  FAILED: 'Failed',
  PENDING: 'Pending',
  ACTIVE_STATUS: 'Active',
  EASY: 'Easy',
  MEDIUM: 'Medium',
  HARD: 'Hard',
};

export function statusLabel(status?: string | null): string {
  if (!status) return '—';
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export function StatusBadge({ status, size }: { status?: string | null; size?: 'lg' }) {
  if (!status) return <span className="text-muted">—</span>;
  const tone = EXAM_STATUS_TONES[status] ?? 'neutral';
  return (
    <Badge tone={tone} size={size}>
      {statusLabel(status)}
    </Badge>
  );
}

/* -------------------------------------------------------------------- data table */
export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
  /** Label used when rows are rendered as stacked cards on small screens. */
  mobileLabel?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  responsive = true,
  loading,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  empty?: ReactNode;
  responsive?: boolean;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="loading-block">
        <span className="spinner" aria-hidden="true" /> Loading records…
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="empty-state">
        <div className="empty-state__icon">
          <IconInbox size={20} />
        </div>
        {empty ?? <p>No records to display.</p>}
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className={`data-table ${responsive ? 'responsive' : ''}`}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.align === 'right' ? 'num' : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row, index)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  data-label={column.mobileLabel ?? column.header}
                  className={[column.align === 'right' ? 'num' : '', column.className ?? ''].filter(Boolean).join(' ')}
                >
                  {column.render ? column.render(row) : (((row as Record<string, unknown>)[column.key] as ReactNode) ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------- pagination */
export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const pages = useMemo(() => {
    const windowSize = 5;
    const start = Math.max(1, Math.min(page - Math.floor(windowSize / 2), Math.max(1, totalPages - windowSize + 1)));
    return Array.from({ length: Math.min(windowSize, totalPages) }, (_, index) => start + index);
  }, [page, totalPages]);

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="pagination">
      <span className="text-sm text-muted">
        {from}–{to} of {total}
      </span>
      <div className="pagination__pages">
        <button
          type="button"
          className="pagination__page"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          ‹
        </button>
        {pages.map((value) => (
          <button
            key={value}
            type="button"
            className="pagination__page"
            aria-current={value === page ? 'page' : undefined}
            onClick={() => onPageChange(value)}
          >
            {value}
          </button>
        ))}
        <button
          type="button"
          className="pagination__page"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          aria-label="Next page"
        >
          ›
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ modal */
export function Modal({
  open,
  title,
  children,
  onClose,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
      >
        <header className="modal__header">
          <h2>{title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog">
            <IconClose size={18} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  tone = 'danger',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div>{message}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------------ tabs */
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: string; count?: number }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          className="tab"
          aria-selected={active === tab.key}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="pill-count" style={{ marginLeft: 6 }}>{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------------- alerts */
export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const Icon = tone === 'warning' || tone === 'danger' ? IconWarning : IconInfo;
  return (
    <div className={`alert alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={17} />
      <div style={{ flex: 1 }}>
        {title ? <strong>{title}</strong> : null}
        {children}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">
        <IconInbox size={20} />
      </div>
      <h3>{title}</h3>
      {message ? <p>{message}</p> : null}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function ProgressBar({ value, tone = 'default' }: { value: number; tone?: 'default' | 'success' | 'warning' | 'danger' }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(clamped)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress__bar ${tone !== 'default' ? `progress__bar--${tone}` : ''}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function DefinitionList({ items }: { items: { term: string; description: ReactNode }[] }) {
  return (
    <dl className="definition-list">
      {items.map((item) => (
        <div key={item.term} style={{ display: 'contents' }}>
          <dt>{item.term}</dt>
          <dd>{item.description ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ----------------------------------------------------------------------- toasts */
interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error' | 'warning';
}

interface ToastContextValue {
  notify: (message: string, tone?: Toast['tone']) => void;
}

const ToastContext = createContext<ToastContextValue>({ notify: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const notify = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    counter.current += 1;
    const id = counter.current;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 6000);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            <span style={{ flex: 1 }}>{toast.message}</span>
            <button
              type="button"
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
