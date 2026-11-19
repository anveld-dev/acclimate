import type { ComponentProps } from 'react';
import { Badge } from './ui/badge';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export function StatusBadge({
  tone = 'neutral',
  ...props
}: ComponentProps<typeof Badge> & { tone?: StatusTone }) {
  return <Badge variant="outline" data-tone={tone} {...props} />;
}
