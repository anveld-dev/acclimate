import { useId, type ReactNode } from 'react';
import { cn } from 'cn';

/**
 * A settings or content panel: a heading row with a title, an optional one-line
 * description and actions at the right, then a padded body and an optional footer whose
 * buttons sit at the right. Use it for every panel so headings, padding and button
 * placement match across pages.
 */
export function Panel({
  id,
  title,
  description,
  actions,
  footer,
  flush = false,
  className,
  children,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Drop the body padding, for a table or list that runs edge to edge. */
  flush?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className={cn('workspace-panel', className)}>
      <header className="panel-heading">
        <div>
          <h2 id={headingId}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      {children !== undefined && children !== null && children !== false && (
        <div className={flush ? 'panel-body panel-body-flush' : 'panel-body'}>{children}</div>
      )}
      {footer && <footer className="panel-footer">{footer}</footer>}
    </section>
  );
}
