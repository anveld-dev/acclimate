import { createFileRoute } from '@tanstack/react-router';
import { readLanding } from '../server/navigation-state';
import { LegacyPage } from '../components/legacy-page';
export const Route = createFileRoute('/releases')({
  validateSearch: (search: Record<string, unknown>) => search,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps }) => readLanding({ data: { legacy: 'releases', search: deps.search } }),
  component: () => <LegacyPage landing={Route.useLoaderData()} />,
});
