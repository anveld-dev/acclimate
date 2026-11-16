import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { PageTitle } from './shared';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { NativeSelect } from './ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import {
  readWorkspaceAccess,
  readWorkspaceMembers,
  runAccessCommand,
} from '../server/access-actions';
import type { AccessCommand, AccessState, VerifiedUser } from '../server/access-core';
import { runInvitationCommand } from '../server/invitation-actions';
import type { Invitation, InvitationCommand } from '../server/invitation-core';
import { useBackgroundRefresh } from './use-background-refresh';

const ACCESS_UPDATED = 'Workspace access updated.';
const INVITATION_QUEUED = 'Invitation queued.';
const ROLES = [
  { value: 'viewer', label: 'Viewer', description: 'Read content' },
  { value: 'editor', label: 'Editor', description: 'Read and change content' },
  { value: 'admin', label: 'Administrator', description: 'Manage content and members' },
] as const;
type Role = (typeof ROLES)[number]['value'];

export function WorkspaceMembers({
  projectId,
  initial,
}: {
  projectId: string;
  initial?: AccessState;
}) {
  const router = useRouter();
  const [access, setAccess] = useState(initial);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [mailAvailable, setMailAvailable] = useState<boolean>();
  const [invitationError, setInvitationError] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [removing, setRemoving] = useState<VerifiedUser>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const addTrigger = useRef<HTMLButtonElement>(null);
  const actionTriggers = useRef(new Map<string, HTMLButtonElement>());
  const removalTrigger = useRef<HTMLButtonElement | null>(null);
  const generation = useRef(0);
  const readEpoch = useRef(0);
  const loadedPages = useRef(1);
  const currentProject = useRef(projectId);
  const feedbackScope = useRef({
    projectId,
    identityId: initial?.ok ? initial.identity.userId : undefined,
  });
  currentProject.current = projectId;

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    const identityId = initial?.ok ? initial.identity.userId : undefined;
    const sameIdentity =
      feedbackScope.current.projectId === projectId &&
      feedbackScope.current.identityId === identityId;
    // Polls may refresh rows without interrupting an action or clearing feedback.
    if (
      sameIdentity &&
      initial?.ok &&
      initial.projects.some((p) => p.id === projectId && p.role === 'admin')
    ) {
      if (loadedPages.current === 1) setAccess(initial);
      return;
    }
    feedbackScope.current = { projectId, identityId };
    generation.current += 1;
    loadedPages.current = 1;
    setAccess(initial);
    setAdding(false);
    setRemoving(undefined);
    setPending(false);
    setEmail('');
    setRole('viewer');
    setMessage('');
    if (!initial)
      void readWorkspaceAccess({ data: { projectId } })
        .then((value) => {
          if (active) setAccess(value);
        })
        .catch(() => {
          if (active) setMessage('Could not load members. Retrying automatically.');
        });
    return () => {
      active = false;
    };
  }, [projectId, initial]);

  async function run(command: AccessCommand) {
    if (pending) return;
    const scope = projectId;
    const version = generation.current;
    readEpoch.current += 1;
    setPending(true);
    setMessage('');
    try {
      const result = await runAccessCommand({ data: command });
      if (scope !== currentProject.current || version !== generation.current) return;
      if (!result.ok) {
        setMessage(result.message);
        return;
      }
      setMessage(ACCESS_UPDATED);
      const next = await readMemberWindow(scope);
      if (scope !== currentProject.current || version !== generation.current) return;
      setAccess(next);
      await router.invalidate();
      setAdding(false);
      setRemoving(undefined);
    } catch {
      if (scope === currentProject.current && version === generation.current)
        setMessage('Could not confirm the change. Check the member list before trying again.');
    } finally {
      if (scope === currentProject.current && version === generation.current) setPending(false);
    }
  }

  async function loadMore() {
    if (pending || !access?.ok || !access.nextMemberCursor) return;
    const scope = projectId;
    const version = generation.current;
    readEpoch.current += 1;
    setPending(true);
    try {
      const page = await readWorkspaceMembers({
        data: { projectId: scope, cursor: access.nextMemberCursor },
      });
      if (scope !== currentProject.current || version !== generation.current) return;
      if (!page.ok) {
        setMessage(page.message);
        return;
      }
      loadedPages.current += 1;
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
      if (scope === currentProject.current && version === generation.current)
        setMessage('Could not load more members. Try again.');
    } finally {
      if (scope === currentProject.current && version === generation.current) setPending(false);
    }
  }

  async function copyUserId(member: VerifiedUser) {
    try {
      await navigator.clipboard.writeText(member.id);
      setMessage('User ID copied.');
    } catch {
      setMessage(`Copy this user ID: ${member.id}`);
    }
  }

  const allowed =
    access?.ok && access.projects.some((p) => p.id === projectId && p.role === 'admin');

  async function readMemberWindow(scope: string): Promise<AccessState> {
    const pages = loadedPages.current;
    const next = await readWorkspaceAccess({ data: { projectId: scope } });
    if (!next.ok) return next;
    const members = [...(next.members ?? [])];
    let cursor = next.nextMemberCursor;
    for (let page = 1; page < pages && cursor; page++) {
      const more = await readWorkspaceMembers({ data: { projectId: scope, cursor } });
      if (!more.ok) return { ...more, identity: null, projects: [] };
      members.push(
        ...more.items.filter((item) => !members.some((member) => member.id === item.id)),
      );
      cursor = more.nextCursor;
    }
    return { ...next, members, nextMemberCursor: cursor };
  }

  useBackgroundRefresh(
    async () => {
      const scope = projectId;
      const version = generation.current;
      const epoch = readEpoch.current;
      const current = () =>
        scope === currentProject.current &&
        version === generation.current &&
        epoch === readEpoch.current;
      let accessLost = false;
      await Promise.allSettled([
        readMemberWindow(scope).then(async (next) => {
          if (!current()) return;
          if (!next.ok) {
            // Outages retain rows. Denied access clears them independently of invitations.
            if (next.denied) {
              accessLost = true;
              setAccess(next);
              setInvitations([]);
              await router.invalidate();
            }
            return;
          }
          if (next.identity.userId !== feedbackScope.current.identityId) {
            accessLost = true;
            await router.invalidate();
            return;
          }
          setAccess(next);
          if (!next.projects.some((project) => project.id === scope && project.role === 'admin')) {
            accessLost = true;
            setInvitations([]);
            setMailAvailable(undefined);
            setInvitationError('');
            await router.invalidate();
          }
        }),
        runInvitationCommand({ data: { kind: 'list', projectId: scope } })
          .then((invites) => {
            if (!current() || accessLost) return;
            if (invites.ok) {
              setInvitations(invites.items ?? []);
              setMailAvailable(invites.available === true);
              setInvitationError('');
              setMessage((value) => (value === INVITATION_QUEUED ? '' : value));
            } else {
              setInvitationError(
                'Could not refresh invitations. Showing the last known list; retrying automatically.',
              );
            }
          })
          .catch(() => {
            if (current() && !accessLost)
              setInvitationError(
                'Could not refresh invitations. Showing the last known list; retrying automatically.',
              );
          }),
      ]);
    },
    {
      enabled: Boolean(allowed) && !pending,
      interval: 5_000,
      allowButtonFocus: true,
      allowScroll: true,
    },
  );

  useEffect(() => {
    let active = true;
    if (!allowed) {
      setMailAvailable(undefined);
      setInvitations([]);
    }
    setInvitationError('');
    if (allowed)
      void runInvitationCommand({ data: { kind: 'list', projectId } })
        .then((value) => {
          if (!active) return;
          if (value.ok) {
            setInvitations(value.items ?? []);
            setMailAvailable(value.available === true);
          } else setInvitationError(value.message);
        })
        .catch(() => {
          if (active) setInvitationError('Could not load invitations. Retrying automatically.');
        });
    return () => {
      active = false;
    };
  }, [projectId, allowed, initial]);

  async function invite(command: InvitationCommand) {
    if (pending || !allowed) return;
    const version = generation.current;
    readEpoch.current += 1;
    const scope = projectId;
    setPending(true);
    setMessage('');
    try {
      const value = await runInvitationCommand({ data: command });
      if (version !== generation.current || scope !== currentProject.current) return;
      if (!value.ok) {
        setMessage(value.message);
        return;
      }
      setAdding(false);
      setMessage(
        command.kind === 'revoke'
          ? 'Invitation revoked.'
          : command.kind === 'create' &&
              value.invitation &&
              (Date.parse(value.invitation.expiresAt) <= Date.now() ||
                ['sent', 'failed'].includes(value.invitation.deliveryStatus))
            ? 'An invitation already exists. You can resend it below.'
            : INVITATION_QUEUED,
      );
      const list = await runInvitationCommand({ data: { kind: 'list', projectId: scope } });
      if (version !== generation.current || scope !== currentProject.current) return;
      if (list.ok) setInvitations(list.items ?? []);
      await router.invalidate();
    } catch {
      if (version === generation.current)
        setMessage('Could not confirm the invitation. Check the list before trying again.');
    } finally {
      if (version === generation.current) setPending(false);
    }
  }
  return (
    <div className="workspace-members space-y-4">
      <PageTitle
        title="Members"
        description="Choose who can view, edit, and manage this workspace."
        actions={
          allowed && (
            <Button
              ref={addTrigger}
              disabled={pending || !mailAvailable}
              onClick={() => {
                setEmail('');
                setRole('viewer');
                setMessage('');
                setAdding(true);
              }}
            >
              Invite member
            </Button>
          )
        }
      />
      {access && !allowed ? (
        <p role="alert" className="rounded-lg border p-4">
          {!access.ok
            ? access.message
            : 'Workspace membership management requires a workspace administrator.'}
        </p>
      ) : !access ? (
        <p role="status">{message || 'Loading members…'}</p>
      ) : (
        <section
          aria-labelledby="current-members-heading"
          className="workspace-members-panel workspace-panel overflow-hidden"
        >
          <h2 id="current-members-heading" className="members-section-heading">
            Current members
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {access.ok &&
                access.members?.map((member) => (
                  <TableRow key={member.id} className="workspace-member-row">
                    <TableCell className="workspace-member-identity">
                      <div className="member-identity-heading flex flex-wrap items-center gap-2">
                        <span className="font-medium break-words">{memberName(member)}</span>
                        {member.id === access.identity.userId && (
                          <span className="text-muted-foreground">You</span>
                        )}
                      </div>
                      <div className="member-identity-meta">
                        <div className="member-id">User ID: {member.id}</div>
                        <Disclosure>
                          <DisclosureTrigger>Identity details</DisclosureTrigger>
                          <DisclosureContent className="member-details">
                            <div>Issuer: {member.issuer}</div>
                            <div>Subject: {member.subject}</div>
                          </DisclosureContent>
                        </Disclosure>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="members-cell-label">Role</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-disabled={pending}
                            aria-busy={pending}
                            onPointerDown={(event) => {
                              if (pending) event.preventDefault();
                            }}
                            onKeyDown={(event) => {
                              if (
                                pending &&
                                ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)
                              )
                                event.preventDefault();
                            }}
                            className="member-role-trigger"
                            aria-label={`Role for ${memberName(member)}, user ID ${member.id}: ${roleName(member.role)}`}
                          >
                            {roleName(member.role)}
                            <ChevronDown
                              aria-hidden="true"
                              className="size-3.5 text-muted-foreground"
                            />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="member-role-menu">
                          <DropdownMenuRadioGroup
                            value={member.role ?? ''}
                            onValueChange={(value) => {
                              if (value !== member.role)
                                void run({
                                  kind: 'setMembership',
                                  projectId,
                                  userId: member.id,
                                  role: value as Role,
                                  confirmedIdentity: {
                                    issuer: member.issuer,
                                    subject: member.subject,
                                  },
                                });
                            }}
                          >
                            {ROLES.map((option) => (
                              <DropdownMenuRadioItem
                                key={option.value}
                                value={option.value}
                                disabled={pending}
                              >
                                <span>
                                  <span className="block font-medium">{option.label}</span>
                                  <span className="block text-muted-foreground">
                                    {option.description}
                                  </span>
                                </span>
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="members-cell-label">Actions</span>
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="member-actions-trigger"
                                ref={(node) => {
                                  if (node) actionTriggers.current.set(member.id, node);
                                  else actionTriggers.current.delete(member.id);
                                }}
                                disabled={pending}
                                aria-label={`Actions for ${memberName(member)}, user ID ${member.id}`}
                              >
                                <MoreHorizontal aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent>Member actions</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel className="break-words">
                            {memberName(member)}
                          </DropdownMenuLabel>
                          <DropdownMenuItem onSelect={() => void copyUserId(member)}>
                            Copy user ID
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onSelect={() => {
                              setMessage('');
                              removalTrigger.current =
                                actionTriggers.current.get(member.id) ?? null;
                              setRemoving(member);
                            }}
                          >
                            Remove access
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
          {access.ok && !access.members?.length && (
            <p className="p-4 text-muted-foreground">No members to show.</p>
          )}
          {access.ok && access.nextMemberCursor && (
            <div className="border-t p-3">
              <Button variant="outline" disabled={pending} onClick={() => void loadMore()}>
                Load more members
              </Button>
            </div>
          )}
        </section>
      )}
      {allowed && invitationError && <p role="alert">{invitationError}</p>}
      {allowed && !invitationError && mailAvailable === false && (
        <p className="text-sm text-muted-foreground">
          Email invitations are unavailable until SMTP is configured.
        </p>
      )}
      {allowed && (
        <section className="workspace-panel overflow-hidden" aria-label="Pending invitations">
          <h2 className="members-section-heading">Pending invitations</h2>
          {mailAvailable !== undefined && !invitationError && invitations.length === 0 && (
            <p className="members-empty">No pending invitations.</p>
          )}
          {invitations.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead>
                    <span className="sr-only">Invitation actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id}>
                    <TableCell className="break-all">
                      <span className="members-cell-label">Email</span>
                      {invitation.email}
                    </TableCell>
                    <TableCell>
                      <span className="members-cell-label">Role</span>
                      {roleName(invitation.role)}
                    </TableCell>
                    <TableCell>
                      <span className="members-cell-label">Delivery</span>
                      {Date.parse(invitation.expiresAt) <= Date.now()
                        ? 'Expired'
                        : {
                            queued: 'Queued',
                            sending: 'Sending…',
                            sent: 'Sent',
                            failed: 'Could not send',
                          }[invitation.deliveryStatus]}
                      <div>Expires: {invitation.expiresAt}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="members-cell-label">Actions</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={pending}
                            aria-label={`Invitation actions for ${invitation.email}`}
                          >
                            <MoreHorizontal aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={
                              !mailAvailable ||
                              pending ||
                              ['queued', 'sending'].includes(invitation.deliveryStatus)
                            }
                            onSelect={() =>
                              void invite({ kind: 'resend', projectId, id: invitation.id })
                            }
                          >
                            Resend invitation
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            disabled={pending}
                            onSelect={() =>
                              void invite({ kind: 'revoke', projectId, id: invitation.id })
                            }
                          >
                            Revoke invitation
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      )}
      {message && !adding && !removing && (
        <p role="status" className="member-feedback">
          {message}
        </p>
      )}
      <Dialog
        open={adding && Boolean(allowed)}
        onOpenChange={(open) => {
          if (!pending) setAdding(open);
        }}
      >
        <DialogContent returnFocusRef={addTrigger} className="member-add-dialog">
          <DialogHeader>
            <DialogTitle>Invite member</DialogTitle>
            <DialogDescription>
              They’ll get a link to join using their verified email.
            </DialogDescription>
          </DialogHeader>
          <form
            id="invite-member-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (email.trim())
                void invite({ kind: 'create', projectId, email: email.trim(), role });
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="invitation-email">Email</Label>
              <Input
                id="invitation-email"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                placeholder="name@example.com"
                value={email}
                disabled={pending}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setMessage('');
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="membership-role">Workspace role</Label>
              <NativeSelect
                id="membership-role"
                value={role}
                disabled={pending}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {ROLES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-sm text-muted-foreground">
                {ROLES.find((option) => option.value === role)?.description}
              </p>
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button form="invite-member-form" type="submit" disabled={pending || !email.trim()}>
              {pending ? 'Sending…' : 'Send invite'}
            </Button>
          </DialogFooter>
          {message && (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(removing && allowed)}
        onOpenChange={(open) => {
          if (!pending && !open) setRemoving(undefined);
        }}
      >
        <AlertDialogContent returnFocusRef={removalTrigger}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove workspace access?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing && memberName(removing)} will lose access to this workspace. Their account
              stays active.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removing && (
            <div className="member-details removal-identity">
              <div>Name: {memberName(removing)}</div>
              <div>User ID: {removing.id}</div>
              <div>Issuer: {removing.issuer}</div>
              <div>Subject: {removing.subject}</div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep member</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending || !removing}
              onClick={(event) => {
                event.preventDefault();
                if (removing)
                  void run({
                    kind: 'removeMembership',
                    projectId,
                    userId: removing.id,
                    confirmedIdentity: { issuer: removing.issuer, subject: removing.subject },
                  });
              }}
            >
              {pending ? 'Removing…' : 'Remove member'}
            </AlertDialogAction>
          </AlertDialogFooter>
          {message && (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function roleName(role: string | null) {
  return ROLES.find((option) => option.value === role)?.label ?? 'Unknown role';
}
function memberName(member: VerifiedUser) {
  return (
    member.displayName ||
    (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(member.subject)
      ? `Account ${member.subject.slice(0, 8)}`
      : member.subject)
  );
}
