import { createFileRoute, useRouter, useRouterState } from '@tanstack/react-router';
import { ArrowRight, BookOpen } from 'lucide-react';
import { readLanding } from '../server/navigation-state';
import { LegacyPage } from '../components/legacy-page';
import { WorkspaceCreate } from '../components/workspace-create';
import { useNavigation } from '../components/use-navigation';
import { consoleDestination } from '../components/console-link';
import { Button } from '../components/ui/button';
import { workspaceHref } from '../navigation';
import { signInHref } from '../lib/return-destination';

export const Route = createFileRoute('/')({
  loader: () => readLanding({ data: {} }),
  component: Landing,
});
function Landing() {
  const landing = Route.useLoaderData();
  const nav = useNavigation();
  const router = useRouter();
  const returnTo = useRouterState({ select: (state) => state.location.href });
  if (landing.href !== '/') return <LegacyPage landing={landing} />;
  const access = nav?.access;
  return (
    <div className="workspace-onboarding mx-auto max-w-2xl space-y-8 py-5 sm:py-10">
      <div className="workspace-onboarding-intro space-y-4">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <BookOpen aria-hidden="true" className="size-6" />
        </div>
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Agent context, together
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Welcome to Acclimate
          </h1>
          <p className="max-w-lg text-base leading-relaxed text-muted-foreground">
            {access?.ok && access.canCreateWorkspace
              ? "Start with a workspace for your team's instructions, skills and memory."
              : 'Keep the instructions, skills and memory your agents rely on in one shared workspace.'}
          </p>
        </div>
      </div>
      {!access?.ok ? (
        <section className="workspace-panel space-y-5 p-6 sm:p-8">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Sign in to your workspace</h2>
            <p role="alert" className="text-sm text-muted-foreground">
              {access?.message || 'Could not load workspace access.'}
            </p>
          </div>
          <Button asChild>
            <a href={signInHref(returnTo)}>
              Sign in <ArrowRight aria-hidden="true" />
            </a>
          </Button>
        </section>
      ) : (
        <WorkspaceCreate
          access={access}
          onCreated={(id) => void router.navigate(consoleDestination(workspaceHref(id)))}
        />
      )}
    </div>
  );
}
