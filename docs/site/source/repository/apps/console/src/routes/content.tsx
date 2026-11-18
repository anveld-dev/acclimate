import { createFileRoute } from '@tanstack/react-router';
import { readLanding } from '../server/navigation-state';
import { LegacyPage } from '../components/legacy-page';
export const Route = createFileRoute('/content')({
  validateSearch: (search: Record<string, unknown>) => search,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps }) => readLanding({ data: { legacy: 'content', search: deps.search } }),
  component: function LegacyContentPage() {
    return <LegacyPage landing={Route.useLoaderData()} />;
  },
});
