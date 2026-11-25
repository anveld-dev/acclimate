import type { ReactNode } from 'react';
import { cn } from 'cn';

/**
 * One form field: the label above the control, then optional help text. The control is
 * passed as children and must carry the id named by htmlFor.
 */
export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  return (
    <div className={cn('form-field', className)}>
      <label htmlFor={htmlFor} className="form-field-label">
        {label}
      </label>
      {children}
      {hint && (
        <p id={hintId} className="form-field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Lays fields out in one column, or two from medium widths when columns is 2. */
export function FieldGrid({ columns = 1, children }: { columns?: 1 | 2; children: ReactNode }) {
  return <div className={columns === 2 ? 'form-grid form-grid-2' : 'form-grid'}>{children}</div>;
}
