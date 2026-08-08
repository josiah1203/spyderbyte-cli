import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ReactElement,
  RefObject,
} from 'react';
import { cloneElement, forwardRef, isValidElement, useEffect, useId, useRef } from 'react';
import Icon, { type IconName } from './icons';

export type SemanticTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type ComponentSize = 'sm' | 'md' | 'lg';
export type LoadingState = 'idle' | 'loading' | 'success' | 'error' | 'unavailable';
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'ghost'
  | 'destructive'
  | 'success'
  | 'outline-danger';

const toneFromLegacyColor: Record<'gray' | 'blue' | 'amber' | 'red' | 'green', SemanticTone> = {
  gray: 'neutral',
  blue: 'info',
  amber: 'warning',
  red: 'danger',
  green: 'success',
};

export function WireBlock({
  w,
  h,
  className = '',
}: {
  w?: string;
  h?: string;
  className?: string;
}) {
  return (
    <div
      className={`ds-skeleton ${className}`}
      style={{ width: w, height: h }}
      aria-hidden="true"
    />
  );
}

export function WireLabel({
  children,
  mono = false,
  size = 'xs',
  muted = false,
}: {
  children: ReactNode;
  mono?: boolean;
  size?: 'xxs' | 'xs' | 'sm' | 'base';
  muted?: boolean;
}) {
  const sizeMap = { xxs: '10px', xs: '11px', sm: '12px', base: '13px' };
  return (
    <span
      style={{
        color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: sizeMap[size],
        letterSpacing: mono ? '0.01em' : undefined,
      }}
    >
      {children}
    </span>
  );
}

export function SectionLabel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`section-label ${className}`}>{children}</div>;
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  variant?: ButtonVariant;
  tone?: SemanticTone;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'tertiary', tone, className = '', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      {...props}
      className={`ds-icon-button ${className}`}
      data-variant={variant}
      data-tone={tone}
      aria-label={label}
      type={props.type ?? 'button'}
    >
      <Icon name={icon} tone={tone === 'neutral' ? 'primary' : tone} aria-hidden="true" />
    </button>
  );
});

export function Button({
  children,
  variant = 'primary',
  loading = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      className={`ds-button ${className}`}
      data-variant={variant}
      data-loading={loading}
      disabled={Boolean(props.disabled || loading)}
      type={props.type ?? 'button'}
    >
      {loading && <span className="ds-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  required = false,
  tone,
  children,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  tone?: SemanticTone;
  children: ReactNode;
  htmlFor?: string;
}) {
  const generatedId = useId();
  const childId = isValidElement(children) ? (children.props as { id?: string }).id : undefined;
  const controlId = htmlFor ?? childId ?? generatedId;
  const hintId = `${controlId}-hint`;
  const existingDescription = isValidElement(children)
    ? (children.props as { ['aria-describedby']?: string })['aria-describedby']
    : undefined;
  const describedBy = [existingDescription, hint === undefined ? undefined : hintId]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(' ');
  const child =
    label !== undefined && isValidElement(children)
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          id: childId ?? controlId,
          ...(describedBy.length === 0 ? {} : { 'aria-describedby': describedBy }),
        })
      : children;
  return (
    <div className="ds-field" data-required={required} data-tone={tone}>
      {label !== undefined && (
        <label className="ds-field-label" htmlFor={controlId}>
          {label}
        </label>
      )}
      {child}
      {hint !== undefined && (
        <span id={hintId} className="ds-field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`ds-input ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`ds-select ${props.className ?? ''}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`ds-textarea ${props.className ?? ''}`} />;
}

export const SearchInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & {
    icon?: IconName;
    shortcut?: string;
  }
>(function SearchInput({ icon = 'search', shortcut, className = '', ...props }, ref) {
  return (
    <div className={`ds-input-shell ${className}`}>
      <Icon name={icon} size={16} tone="tertiary" aria-hidden="true" />
      <input
        {...props}
        ref={ref}
        aria-label={props['aria-label'] ?? 'Search'}
        className="ds-input"
      />
      {shortcut && <span className="ds-kbd">{shortcut}</span>}
    </div>
  );
});

export function Checkbox({
  checked = false,
  label,
  onCheckedChange,
  disabled = false,
}: {
  checked?: boolean;
  label?: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="ds-control-row">
      <button
        type="button"
        className="ds-control ds-checkbox"
        role="checkbox"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
      >
        {checked && <Icon name="check" size={16} aria-hidden="true" />}
      </button>
      {label !== undefined && <span className="ds-control-label">{label}</span>}
    </label>
  );
}

export function Radio({
  checked = false,
  label,
  onCheckedChange,
  disabled = false,
}: {
  checked?: boolean;
  label?: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="ds-control-row">
      <button
        type="button"
        className="ds-control ds-radio"
        role="radio"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
      >
        {checked && <span className="ds-radio-dot" aria-hidden="true" />}
      </button>
      {label !== undefined && <span className="ds-control-label">{label}</span>}
    </label>
  );
}

export function Switch({
  checked = false,
  label,
  onCheckedChange,
  disabled = false,
}: {
  checked?: boolean;
  label?: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="ds-control-row">
      <button
        type="button"
        className="ds-switch"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
      >
        <span aria-hidden="true" />
      </button>
      {label !== undefined && <span className="ds-control-label">{label}</span>}
    </label>
  );
}

export function Card({
  children,
  className = '',
  raised = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { raised?: boolean }) {
  return (
    <div {...props} className={`ds-card ${raised ? 'surface-raised' : ''} ${className}`}>
      {children}
    </div>
  );
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useOverlayFocus(open: boolean, onClose: (() => void) | undefined) {
  const ref = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const focusable = root
      ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      : [];
    (focusable[0] ?? root)?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [open]);
  return { ref, titleId, descriptionId };
}

export function StatusDot({
  color = 'gray',
  label,
}: {
  color: 'green' | 'amber' | 'red' | 'gray' | 'blue';
  label?: string;
}) {
  const tone = toneFromLegacyColor[color];
  return (
    <span
      className="ds-status-dot"
      data-tone={tone}
      aria-label={label}
      role={label ? 'img' : undefined}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function StatusChip({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: SemanticTone;
}) {
  return (
    <span className="ds-chip" data-tone={tone}>
      {children}
    </span>
  );
}

export function Badge({
  children,
  color = 'gray',
  tone,
  variant = 'subtle',
}: {
  children: ReactNode;
  color?: 'gray' | 'blue' | 'amber' | 'red' | 'green';
  tone?: SemanticTone;
  variant?: 'filled' | 'outlined' | 'subtle';
}) {
  return (
    <span
      className="ds-badge"
      data-tone={tone ?? toneFromLegacyColor[color]}
      data-variant={variant}
    >
      {children}
    </span>
  );
}

export function Divider({ vertical = false }: { vertical?: boolean }) {
  return <div className="ds-divider" data-vertical={vertical} role="separator" />;
}

export function Progress({
  value,
  max = 100,
  tone = 'neutral',
  className = '',
}: {
  value: number;
  max?: number;
  tone?: SemanticTone;
  className?: string;
}) {
  const pct = Math.min(100, Math.max(0, Math.round((value / max) * 100)));
  return (
    <div
      className={`ds-progress ${className}`}
      data-tone={tone}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      style={{ '--progress': `${pct}%` } as CSSProperties}
    >
      <span />
    </div>
  );
}

export function ProgressBar({
  value,
  max = 100,
  h = 8,
  color,
  tone = 'neutral',
}: {
  value: number;
  max?: number;
  h?: number;
  color?: string;
  tone?: SemanticTone;
}) {
  const pct = Math.min(100, Math.max(0, Math.round((value / max) * 100)));
  return (
    <div
      className="ds-progress"
      data-tone={tone}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      style={
        {
          '--progress': `${pct}%`,
          '--progress-height': `${h}px`,
          '--progress-color': color,
        } as CSSProperties
      }
    >
      <span />
    </div>
  );
}

export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <div className={`ds-skeleton ${className}`} style={style} aria-hidden="true" />;
}

export function EmptyState({
  icon = 'box',
  title,
  description,
  action,
  secondaryAction,
}: {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
}) {
  return (
    <div className="ds-empty-state">
      <div className="ds-empty-icon">
        <Icon name={icon} tone="secondary" />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}{' '}
      {(action || secondaryAction) && (
        <div className="ds-empty-actions">
          {action}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  render?: (row: T, index: number) => ReactNode;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  selectedKey,
  loading = false,
  empty,
  unavailable,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  selectedKey?: string;
  loading?: boolean;
  empty?: ReactNode;
  unavailable?: ReactNode;
}) {
  return (
    <div className="ds-table-scroll">
      <table className="ds-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.className}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length}>
                <div className="ds-table-state">
                  <Skeleton className="ds-skeleton-line" />
                  <Skeleton className="ds-skeleton-line" />
                  <Skeleton className="ds-skeleton-line" />
                </div>
              </td>
            </tr>
          ) : unavailable ? (
            <tr>
              <td colSpan={columns.length}>
                <div className="ds-table-state">{unavailable}</div>
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>
                <div className="ds-table-state">{empty ?? 'No results.'}</div>
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const key = getRowKey(row, index);
              const clickable = Boolean(onRowClick);
              return (
                <tr
                  key={key}
                  data-selected={selectedKey === key}
                  data-clickable={clickable || undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={() => onRowClick?.(row)}
                  onKeyDown={(event) => {
                    if (clickable && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault();
                      onRowClick?.(row);
                    }
                  }}
                >
                  {columns.map((column) => (
                    <td key={column.key} className={column.className}>
                      {column.render
                        ? column.render(row, index)
                        : String((row as Record<string, unknown>)[column.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({
  items,
  value,
  onChange,
  label = 'Tabs',
}: {
  items: Array<{ value: string; label: ReactNode; disabled?: boolean }>;
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return (
    <div className="ds-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          className="ds-tab"
          data-active={item.value === value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          disabled={item.disabled}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function SegmentedControl({
  items,
  value,
  onChange,
  label,
}: {
  items: Array<{ value: string; label: ReactNode }>;
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="ds-segmented" role="group" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          className="ds-segment"
          data-active={item.value === value}
          type="button"
          aria-pressed={item.value === value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Breadcrumbs({ items }: { items: Array<{ label: ReactNode; href?: string }> }) {
  return (
    <nav className="ds-breadcrumbs" aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={`${index}-${String(item.label)}`} className="ds-breadcrumb-item">
          {item.href ? (
            <a href={item.href}>{item.label}</a>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
          {index < items.length - 1 && <span aria-hidden="true">/</span>}
        </span>
      ))}
    </nav>
  );
}

export function Pagination({
  current,
  total,
  onChange,
}: {
  current: number;
  total: number;
  onChange: (page: number) => void;
}) {
  return (
    <nav className="ds-pagination" aria-label="Pagination">
      <IconButton
        icon="chevron-left"
        label="Previous page"
        variant="tertiary"
        disabled={current <= 1}
        onClick={() => onChange(current - 1)}
      />
      {Array.from({ length: total }, (_, index) => index + 1).map((page) => (
        <button
          key={page}
          className="ds-page-button"
          data-current={page === current}
          type="button"
          aria-current={page === current ? 'page' : undefined}
          onClick={() => onChange(page)}
        >
          {page}
        </button>
      ))}
      <IconButton
        icon="chevron-right"
        label="Next page"
        variant="tertiary"
        disabled={current >= total}
        onClick={() => onChange(current + 1)}
      />
    </nav>
  );
}

export function Tooltip({ children, content }: { children: ReactNode; content: ReactNode }) {
  return (
    <span className="ds-tooltip-wrap">
      {children}
      <span className="ds-tooltip" role="tooltip">
        {content}
      </span>
    </span>
  );
}

export function Notice({
  children,
  tone = 'info',
  icon,
}: {
  children: ReactNode;
  tone?: SemanticTone;
  icon?: IconName;
}) {
  const resolvedIcon =
    icon ??
    (tone === 'success'
      ? 'success'
      : tone === 'warning'
        ? 'warning'
        : tone === 'danger'
          ? 'danger'
          : 'info');
  return (
    <div className="ds-notice" data-tone={tone}>
      <span className="ds-notice-icon">
        <Icon name={resolvedIcon} size={14} tone={tone} aria-hidden="true" />
      </span>
      <div>{children}</div>
    </div>
  );
}

export function Toast({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className="ds-toast" role="status">
      <div>{children}</div>
      {onDismiss && (
        <IconButton
          icon="close"
          label="Dismiss notification"
          variant="tertiary"
          onClick={onDismiss}
        />
      )}
    </div>
  );
}

export function Menu({ children, className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`ds-menu ${className}`} role={props.role ?? 'menu'}>
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  shortcut,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { shortcut?: ReactNode }) {
  return (
    <button
      {...props}
      className={`ds-menu-item ${props.className ?? ''}`}
      role="menuitem"
      type={props.type ?? 'button'}
    >
      {children}
      <>{shortcut && <span className="ds-kbd">{shortcut}</span>}</>
    </button>
  );
}

export function Popover({
  open = true,
  children,
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement> & { open?: boolean }) {
  if (!open) return null;
  return (
    <div {...props} className={`ds-popover ${className}`}>
      {children}
    </div>
  );
}

export function Dialog({
  open,
  title,
  children,
  actions,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
}) {
  const overlay = useOverlayFocus(open, onClose);
  if (!open) return null;
  return (
    <div
      className="ds-dialog-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={overlay.ref as RefObject<HTMLDivElement>}
        className="ds-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={overlay.titleId}
        aria-describedby={children ? overlay.descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="ds-dialog-header">
          <h2 id={overlay.titleId}>{title}</h2>
          {onClose && (
            <IconButton icon="close" label="Close dialog" variant="tertiary" onClick={onClose} />
          )}
        </div>
        {children && (
          <div id={overlay.descriptionId} className="ds-dialog-body">
            {children}
          </div>
        )}
        {actions && <div className="ds-dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  onClose?: () => void;
}) {
  const overlay = useOverlayFocus(open, onClose);
  if (!open) return null;
  return (
    <div
      className="ds-dialog-scrim"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <aside
        ref={overlay.ref as RefObject<HTMLElement>}
        className="ds-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={overlay.titleId}
        aria-describedby={children ? overlay.descriptionId : undefined}
        tabIndex={-1}
      >
        <div className="ds-dialog-header">
          <h2 id={overlay.titleId}>{title}</h2>
          {onClose && (
            <IconButton icon="close" label="Close panel" variant="tertiary" onClick={onClose} />
          )}
        </div>
        <div id={overlay.descriptionId}>{children}</div>
      </aside>
    </div>
  );
}

export function Accordion({ children }: { children: ReactNode }) {
  return <div className="ds-accordion">{children}</div>;
}

export function AccordionItem({
  title,
  children,
  open = false,
}: {
  title: ReactNode;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details className="ds-accordion-item" open={open}>
      <summary>{title}</summary>
      <p>{children}</p>
    </details>
  );
}
