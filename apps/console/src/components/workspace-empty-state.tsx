import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** A first-run explanation for a workspace page: what appears here and how to get it. */
export function WorkspaceEmptyState({
  icon: Icon,
  title,
  description,
  steps,
  actions,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  steps?: ReactNode[];
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="workspace-empty-state" aria-label={title}>
      <span className="workspace-empty-state-icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="workspace-empty-state-body">
        <h2>{title}</h2>
        <p>{description}</p>
        {steps && steps.length > 0 && (
          <ol>
            {steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        )}
        {actions && <div className="workspace-empty-state-actions">{actions}</div>}
        {children}
      </div>
    </section>
  );
}
