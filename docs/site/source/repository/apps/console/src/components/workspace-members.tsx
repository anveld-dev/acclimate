import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';
import { Badge } from './ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import {
  readWorkspaceAccess,
  readWorkspaceMembers,
  runAccessCommand,
} from '../server/access-actions';
import type { AccessCommand, AccessState, VerifiedUser } from '../server/access-core';

export function WorkspaceMembers({
  projectId,
  initial,
}: {
  projectId: string;
  initial?: AccessState;
}) {
  const router = useRouter();
  const [access, setAccess] = useState<AccessState | undefined>(initial);
  const [userId, setUser] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor' | 'admin'>('viewer');
  const [verified, setVerified] = useState<{ projectId: string; user: VerifiedUser }>();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [managing, setManaging] = useState(false);
  const generation = useRef(0);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  useEffect(() => {
    let active = true;
    generation.current += 1;
    setAccess(initial);
    setManaging(false);
    setPending(false);
    setUser('');
    setRole('viewer');
    setVerified(undefined);
    setConfirmed(false);
    setMessage('');
    if (initial) return;
    void readWorkspaceAccess({ data: { projectId } })
      .then((value) => {
        if (active) setAccess(value);
      })
      .catch(() => {
        if (active) setMessage('Could not read workspace access. Refresh to retry.');
      });
    return () => {
      active = false;
    };
  }, [projectId, initial]);
  async function run(command: AccessCommand) {
    if (pending) return;
    const targetProject = projectId;
    const requestGeneration = generation.current;
    setPending(true);
    setMessage('');
    try {
      const result = await runAccessCommand({ data: command });
      if (requestGeneration !== generation.current || targetProject !== currentProject.current)
        return;
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      if (result.kind === 'userLookup' && result.user) {
        setVerified({ projectId, user: result.user });
        setRole((result.user.role ?? 'viewer') as typeof role);
        setConfirmed(false);
      } else {
        setConfirmed(false);
        if (command.kind === 'setMembership' || command.kind === 'removeMembership') {
          setVerified((previous) =>
            previous?.user.id === command.userId
              ? {
                  ...previous,
                  user: {
                    ...previous.user,
                    role: command.kind === 'setMembership' ? command.role : null,
                  },
                }
              : previous,
          );
        }
        setMessage('Workspace access updated. Current rights apply to the next request.');
        const refreshed = await readWorkspaceAccess({ data: { projectId: targetProject } });
        if (currentProject.current !== targetProject || requestGeneration !== generation.current)
          return;
        setAccess(refreshed);
        await router.invalidate();
      }
    } catch {
      if (currentProject.current === targetProject && requestGeneration === generation.current)
        setMessage('Could not confirm the result. Refresh access before repeating an action.');
    } finally {
      if (currentProject.current === targetProject && requestGeneration === generation.current)
        setPending(false);
    }
  }
  async function refreshAccess() {
    if (pending) return;
    const scope = projectId;
    const requestGeneration = generation.current;
    setPending(true);
    setMessage('');
    setVerified(undefined);
    setConfirmed(false);
    setUser('');
    try {
      const refreshed = await readWorkspaceAccess({ data: { projectId: scope } });
      if (scope !== currentProject.current || requestGeneration !== generation.current) return;
      setAccess(refreshed);
      const canManage =
        refreshed.ok &&
        refreshed.projects.some((project) => project.id === scope && project.role === 'admin');
      if (!canManage) {
        setManaging(false);
        setMessage(
          refreshed.ok
            ? 'Access refreshed. You can no longer manage members in this workspace.'
            : '',
        );
      } else {
        setMessage(
          'Access refreshed. Find the person again to confirm their current identity and role.',
        );
      }
    } catch {
      if (scope !== currentProject.current || requestGeneration !== generation.current) return;
      setAccess({
        ok: false,
        identity: null,
        projects: [],
        message: 'Could not refresh workspace access. Refresh to retry.',
      });
      setManaging(false);
      setMessage('');
    } finally {
      if (scope === currentProject.current && requestGeneration === generation.current)
        setPending(false);
    }
  }
  async function loadMore() {
    if (pending || !access?.ok || !access.nextMemberCursor) return;
    const scope = projectId;
    const requestGeneration = generation.current;
    setPending(true);
    try {
      const page = await readWorkspaceMembers({
        data: { projectId, cursor: access.nextMemberCursor },
      });
      if (scope !== currentProject.current || requestGeneration !== generation.current) return;
      if (!page.ok) {
        setMessage(page.message);
        return;
      }
      setAccess((old) =>
        old?.ok
          ? {
              ...old,
              members: [
                ...(old.members ?? []),
                ...page.items.filter(
                  (item) => !old.members?.some((member) => member.id === item.id),
                ),
              ],
              nextMemberCursor: page.nextCursor,
            }
          : old,
      );
    } catch {
      if (scope === currentProject.current && requestGeneration === generation.current)
        setMessage('Could not load members. Retry this page.');
    } finally {
      if (scope === currentProject.current && requestGeneration === generation.current)
        setPending(false);
    }
  }
  const person = verified?.projectId === projectId ? verified.user : undefined;
  const allowed =
    access?.ok && access.projects.some((p) => p.id === projectId && p.role === 'admin');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Members</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose who can view, edit, and manage this workspace.
          </p>
        </div>
        {allowed && (
          <Button
            disabled={pending}
            onClick={() => {
              setUser('');
              setVerified(undefined);
              setConfirmed(false);
              setRole('viewer');
              setMessage('');
              setManaging(true);
            }}
          >
            Add member
          </Button>
        )}
      </div>
      {access && !allowed ? (
        <p role="alert" className="rounded-lg border p-4">
          {!access.ok
            ? access.message
            : 'Workspace membership management requires a workspace administrator.'}
        </p>
      ) : !access ? (
        <p role="status">{message || 'Loading workspace access…'}</p>
      ) : (
        <section className="workspace-panel overflow-hidden">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Current members</h2>
          {!(access.ok && access.members?.length) && (
            <p className="p-4 text-sm text-muted-foreground">No members to show.</p>
          )}
          <div className="divide-y">
            {access.ok &&
              access.members?.map((member) => (
                <div
                  key={member.id}
                  className="flex flex-wrap items-start justify-between gap-3 p-4 text-sm"
                >
                  <div className="min-w-0 flex-1 basis-48 space-y-2">
                    <p className="break-all font-medium">{member.subject}</p>
                    <p className="break-all text-xs text-muted-foreground">{member.issuer}</p>
                    <Badge variant="secondary">
                      {member.role === 'admin'
                        ? 'Administrator'
                        : member.role === 'editor'
                          ? 'Editor'
                          : 'Viewer'}
                    </Badge>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      setUser(member.id);
                      setVerified(undefined);
                      setConfirmed(false);
                      setManaging(true);
                      void run({ kind: 'userLookup', projectId, userId: member.id });
                    }}
                  >
                    Manage member
                  </Button>
                </div>
              ))}
          </div>
          {access.ok && access.nextMemberCursor && (
            <div className="border-t p-4">
              <Button variant="outline" disabled={pending} onClick={() => void loadMore()}>
                Load more members
              </Button>
            </div>
          )}
        </section>
      )}
      {access && message && !managing && (
        <p role="status" className="rounded-md border p-3 text-sm">
          {message}
        </p>
      )}
      <Dialog
        open={managing && Boolean(allowed)}
        onOpenChange={(open) => {
          if (!pending) setManaging(open);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{person?.role ? 'Manage member' : 'Add member'}</DialogTitle>
            <DialogDescription>
              {person
                ? 'Confirm the person below before changing their access.'
                : 'Ask them to sign in, then copy their user ID from Account.'}
            </DialogDescription>
          </DialogHeader>
          <Button variant="outline" disabled={pending} onClick={() => void refreshAccess()}>
            Refresh access
          </Button>
          {!person && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (userId.trim())
                  void run({ kind: 'userLookup', projectId, userId: userId.trim() });
              }}
            >
              <Label htmlFor="verified-user">User ID</Label>
              <Input
                id="verified-user"
                value={userId}
                disabled={pending}
                autoComplete="off"
                placeholder="Paste their user ID"
                onChange={(event) => {
                  setUser(event.target.value);
                  setVerified(undefined);
                  setConfirmed(false);
                }}
              />
              <Button type="submit" disabled={pending || !userId.trim()}>
                {pending ? 'Finding user…' : 'Find user'}
              </Button>
            </form>
          )}
          {person && (
            <div className="space-y-4">
              <div className="space-y-2 rounded-md bg-muted/40 p-3 text-sm">
                <p className="break-all font-medium">{person.subject}</p>
                <p className="break-all text-muted-foreground">{person.issuer}</p>
                <p>
                  Current role:{' '}
                  {person.role === 'admin' ? 'Administrator' : (person.role ?? 'No membership')}
                </p>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    User ID
                  </summary>
                  <code className="mt-2 block break-all text-xs">{person.id}</code>
                </details>
              </div>
              <Label className="flex items-start gap-2 text-sm leading-5">
                <Checkbox
                  checked={confirmed}
                  disabled={pending}
                  onCheckedChange={(value) => setConfirmed(value === true)}
                />
                I confirm this is the person whose access I want to change.
              </Label>
              <div className="space-y-2">
                <Label htmlFor="membership-role">Workspace role</Label>
                <NativeSelect
                  id="membership-role"
                  value={role}
                  disabled={pending}
                  onChange={(event) => setRole(event.target.value as typeof role)}
                >
                  <option value="viewer">Viewer — read content</option>
                  <option value="editor">Editor — read and change content</option>
                  <option value="admin">Administrator — content and members</option>
                </NativeSelect>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={pending || !confirmed || person.role === role}
                  onClick={() =>
                    void run({
                      kind: 'setMembership',
                      projectId,
                      userId: person.id,
                      role,
                      confirmedIdentity: { issuer: person.issuer, subject: person.subject },
                    })
                  }
                >
                  {pending ? 'Updating…' : person.role ? 'Save role' : 'Add member'}
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setVerified(undefined);
                    setConfirmed(false);
                    setUser('');
                    setMessage('');
                  }}
                >
                  Choose someone else
                </Button>
              </div>
              {person.role && (
                <details className="border-t pt-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Remove workspace access
                  </summary>
                  <div className="space-y-3 pt-3">
                    <p className="text-sm text-muted-foreground">
                      This person will lose access to this workspace. The workspace must keep at
                      least one administrator.
                    </p>
                    <Button
                      variant="destructive"
                      disabled={pending || !confirmed}
                      onClick={() =>
                        void run({
                          kind: 'removeMembership',
                          projectId,
                          userId: person.id,
                          confirmedIdentity: { issuer: person.issuer, subject: person.subject },
                        })
                      }
                    >
                      Remove access
                    </Button>
                  </div>
                </details>
              )}
            </div>
          )}
          {message && (
            <p role="status" className="rounded-md border p-3 text-sm">
              {message}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
