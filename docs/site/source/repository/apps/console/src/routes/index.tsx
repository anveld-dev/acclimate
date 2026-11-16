import { createFileRoute, useRouter } from '@tanstack/react-router';
import { readLanding } from '../server/navigation-state';
import { LegacyPage } from '../components/legacy-page';
import { WorkspaceCreate } from '../components/workspace-create';
import { useNavigation } from '../components/use-navigation';
import { consoleDestination } from '../components/console-link';
import { workspaceHref } from '../navigation';
import { PageTitle } from '../components/shared';

export const Route = createFileRoute('/')({
  loader: () => readLanding({ data: {} }),
  component: Landing,
});
function Landing() {
  const landing = Route.useLoaderData();
  const nav = useNavigation();
  const router = useRouter();
  if (landing.href !== '/') return <LegacyPage landing={landing} />;
  const access = nav?.access;
  if (!access?.ok)
    return (
      <div className="space-y-4">
        <PageTitle
          title="Couldn’t load your workspaces"
          description="Your workspace access is currently unavailable."
        />
        <p role="alert">{access?.message || 'The connection will retry automatically.'}</p>
      </div>
    );
  return (
    <div className="workspace-onboarding space-y-5">
      <PageTitle
        title={access.canCreateWorkspace ? 'Create a workspace' : 'No workspace access yet'}
        description={
          access.canCreateWorkspace
            ? 'Choose a name to get started.'
            : 'Ask a workspace administrator to add your account.'
        }
      />
      <div className="max-w-lg">
        <WorkspaceCreate
          access={access}
          showHeading={false}
          onCreated={(id) => void router.navigate(consoleDestination(workspaceHref(id)))}
        />
      </div>
    </div>
  );
}
