import type { ReactNode } from 'react';

/** One hierarchy for workspace pages and bundle pages. Back stays above identity. */
export function PageHeader({
  title, description, actions, utility, footer, variant = 'workspace', label,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  utility?: ReactNode;
  footer?: ReactNode;
  variant?: 'workspace' | 'bundle';
  label?: string;
}) {
  const bundle = variant === 'bundle';
  return (
    <header className={`page-header ${bundle ? 'bundle-overview bundle-scope-header bundle-header-layout' : 'workspace-page-header'}`} aria-label={label}>
      {utility && <div className={`page-header-utility${bundle ? ' bundle-scope-return-row' : ''}`}>{utility}</div>}
      <div className={`page-header-primary${bundle ? ' bundle-scope-primary' : ''}`}>
        <div className={`page-header-identity${bundle ? ' bundle-scope-identity' : ''}`}>
          <h1>{title}</h1>
          {description && <p className={bundle ? 'sr-only' : undefined}>{description}</p>}
        </div>
        {actions && <div className={bundle ? 'bundle-context' : 'page-actions'}>{actions}</div>}
      </div>
      {footer && <div className={`page-header-footer${bundle ? ' bundle-scope-secondary' : ''}`}>{footer}</div>}
    </header>
  );
}
