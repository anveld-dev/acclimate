import { useId, useState } from 'react';
import { ArrowRight, CheckCircle2, KeyRound } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ConsoleLink } from './console-link';
import { WorkspaceAdopt } from './workspace-adopt';
import { workspaceHref } from '../navigation';
import { runAccessCommand } from '../server/access-actions';
import type { AccessState } from '../server/access-core';

function workspaceId(name: string) {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
}

export function WorkspaceCreate({
  access,
  onCreated,
  showHeading = true,
  onPendingChange,
}: {
  access: AccessState;
  onCreated?: (workspaceId: string) => void;
  showHeading?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const fieldId = useId();
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [created, setCreated] = useState<string>();
  if (!access.ok) return <p role="alert">{access.message}</p>;
  if (!access.canCreateWorkspace) {
    if (access.projects.length) return null;
    return (
      <section className={showHeading ? 'workspace-panel space-y-5 p-6 sm:p-8' : undefined}>
        {showHeading && (
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <KeyRound aria-hidden="true" className="size-5" />
          </div>
        )}
        {showHeading && (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">You don't have a workspace yet</h2>
            <p className="text-sm text-muted-foreground">
              Ask a workspace administrator to invite your sign-in email.
            </p>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          Open the invitation email and choose Join workspace after verifying your email.
        </p>
      </section>
    );
  }
  async function create() {
    if (pending || created) return;
    if (id === '.' || id === '..') {
      setMessage('Choose a workspace ID with letters or numbers.');
      return;
    }
    setPending(true);
    onPendingChange?.(true);
    setMessage('');
    try {
      const result = await runAccessCommand({ data: { kind: 'createProject', id, name } });
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      if (result.project) {
        setCreated(result.project.id);
        onCreated?.(result.project.id);
      }
    } catch {
      setMessage(
        'Could not confirm creation. Check the workspace list before trying again; it updates automatically.',
      );
    } finally {
      setPending(false);
      onPendingChange?.(false);
    }
  }
  return (
    <div className="space-y-5">
      <section className={showHeading ? 'workspace-panel space-y-6 p-6 sm:p-8' : 'space-y-6'}>
        {showHeading && (
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Create a workspace</h2>
            <p className="text-sm text-muted-foreground">
              A shared home for your bundles and team. You'll be its administrator.
            </p>
          </div>
        )}
        {created ? (
          <div className="space-y-4" role="status">
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 aria-hidden="true" className="size-5 text-primary" />
              Workspace created.
            </p>
            <Button asChild>
              <ConsoleLink href={workspaceHref(created, 'bundles')}>
                Open workspace <ArrowRight aria-hidden="true" />
              </ConsoleLink>
            </Button>
          </div>
        ) : (
          <form
            className="workspace-create-form grid gap-5"
            aria-busy={pending}
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-name`}>Workspace name</Label>
              <Input
                id={`${fieldId}-name`}
                value={name}
                placeholder="e.g. Design team"
                maxLength={200}
                required
                onChange={(event) => {
                  setName(event.target.value);
                  if (!idEdited) setId(workspaceId(event.target.value));
                }}
                disabled={pending}
                autoComplete="organization"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-id`}>Workspace ID</Label>
              <Input
                id={`${fieldId}-id`}
                value={id}
                onChange={(event) => {
                  setIdEdited(true);
                  setId(event.target.value);
                }}
                placeholder="design-team"
                className="font-mono text-sm"
                aria-describedby={`${fieldId}-id-help`}
                required
                maxLength={128}
                pattern={String.raw`[a-zA-Z0-9_.\-]+`}
                title="Use letters, numbers, dots, hyphens or underscores."
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={pending}
              />
              <p id={`${fieldId}-id-help`} className="text-xs text-muted-foreground">
                This ID appears in workspace links. You can edit it before creating the workspace.
                Use letters, numbers, dots, hyphens or underscores. A single or double dot is reserved.
              </p>
            </div>
            {message && (
              <p role="alert" className="text-sm text-destructive">
                {message}
              </p>
            )}
            <Button type="submit" disabled={pending} className="w-full sm:w-fit">
              {pending ? 'Creating…' : 'Create workspace'}
              {!pending && <ArrowRight aria-hidden="true" />}
            </Button>
          </form>
        )}
      </section>
      <WorkspaceAdopt
        key={access.identity.userId}
        access={access}
        onPendingChange={onPendingChange}
      />
    </div>
  );
}
