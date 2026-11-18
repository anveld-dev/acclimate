import { createFileRoute, Navigate, useRouter } from '@tanstack/react-router';
import { WorkspaceCreate } from '../components/workspace-create';
import { useNavigation } from '../components/use-navigation';
import { consoleDestination } from '../components/console-link';
import { workspaceHref } from '../navigation';
import { PageTitle } from '../components/shared';

export const Route = createFileRoute('/')({
  component: Landing,
});
function Landing() {
  const nav = useNavigation();
  const router = useRouter();
  const access = nav?.access;
  const project = nav?.projectId ?? (access?.ok ? access.projects[0]?.id : undefined);
  if (project) return <Navigate {...consoleDestination(workspaceHref(project))} replace />;
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
    <div className="workspace-onboarding w-full max-w-xl space-y-5 rounded-xl border bg-card p-5 sm:p-8">
      <PageTitle
        title={access.canCreateWorkspace ? 'Create a workspace' : 'No workspace access yet'}
        description={
          access.canCreateWorkspace
            ? 'Choose a name for the workspace where your team will manage bundles.'
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
