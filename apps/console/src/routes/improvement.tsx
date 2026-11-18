import { createFileRoute } from '@tanstack/react-router';
import { readLanding } from '../server/navigation-state';
import { LegacyPage } from '../components/legacy-page';
export const Route = createFileRoute('/improvement')({
  validateSearch: (search: Record<string, unknown>) => search,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps }) => readLanding({ data: { legacy: 'improvement', search: deps.search } }),
  component: function LegacyImprovementPage() {
    return <LegacyPage landing={Route.useLoaderData()} />;
  },
});
