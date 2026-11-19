import type { ReactNode } from 'react';

export function ListToolbar({ children, count }: { children: ReactNode; count?: ReactNode }) {
  return (
    <div className="list-toolbar">
      {children}
      {count !== undefined && <span role="status">{count}</span>}
    </div>
  );
}
