import { createFileRoute } from '@tanstack/react-router';
import { readLanding } from '../server/navigation-state';
import { LegacyPage } from '../components/legacy-page';
export const Route = createFileRoute('/setup')({
  validateSearch: (search: Record<string, unknown>) => search,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps }) => readLanding({ data: { legacy: 'setup', search: deps.search } }),
  component: function LegacySetupPage() {
    return <LegacyPage landing={Route.useLoaderData()} />;
  },
});
