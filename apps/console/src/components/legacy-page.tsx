import { Navigate } from '@tanstack/react-router';
import { consoleDestination } from './console-link';
import { readLanding } from '../server/navigation-state';
export type LegacyLanding = Awaited<ReturnType<typeof readLanding>>;
export function LegacyPage({ landing }: { landing: LegacyLanding }) {
  return landing.href === '/' ? (
    <Navigate to="/" replace />
  ) : (
    <Navigate {...consoleDestination(landing.href)} replace />
  );
}
