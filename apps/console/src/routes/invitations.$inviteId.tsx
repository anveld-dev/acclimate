import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { runInvitationCommand } from '../server/invitation-actions';
import { Button } from '../components/ui/button';
import { PageTitle } from '../components/shared';

export const Route = createFileRoute('/invitations/$inviteId')({
  loader: ({ params }) => runInvitationCommand({ data: { kind: 'preview', id: params.inviteId } }),
  component: JoinWorkspace,
});
function JoinWorkspace() {
  const result = Route.useLoaderData();
  const { inviteId } = Route.useParams();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const invitation = result.ok ? result.invitation : undefined;
  const active = invitation?.status === 'pending' && Date.parse(invitation.expiresAt) > Date.now();
  const closed =
    invitation?.status === 'accepted'
      ? 'This invitation has already been accepted.'
      : 'This invitation has expired or was revoked. Ask an administrator for a new one.';
  return (
    <div className="mx-auto w-full max-w-xl space-y-5 rounded-xl border bg-card p-5 sm:p-8">
      <PageTitle
        title={invitation ? `Join ${invitation.workspaceName}` : 'Workspace invitation'}
        description=""
      />
      {invitation && (
        <dl className="grid gap-3 rounded-lg bg-muted p-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
          <div>
            <dt className="text-muted-foreground">Invited account</dt>
            <dd className="mt-1 break-all font-medium">{invitation.email}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Workspace role</dt>
            <dd className="mt-1 font-medium capitalize">{invitation.role}</dd>
          </div>
        </dl>
      )}
      {!result.ok ? (
        <p role="alert">{result.message}</p>
      ) : !active ? (
        <p role="status">{closed}</p>
      ) : (
        <p>Accept to access this workspace with your signed-in account.</p>
      )}
      <div className="flex flex-wrap gap-3">
        {active && (
          <Button
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setMessage('');
              try {
                const joined = await runInvitationCommand({
                  data: { kind: 'accept', id: inviteId },
                });
                if (joined.ok && joined.workspaceId) {
                  window.location.assign(`/w/${encodeURIComponent(joined.workspaceId)}/bundles`);
                } else setMessage(joined.ok ? 'Could not confirm membership.' : joined.message);
              } catch {
                setMessage('Could not confirm membership. Try again.');
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? 'Joining…' : 'Join workspace'}
          </Button>
        )}
        {invitation?.status === 'accepted' && (
          <Button asChild>
            <a href={`/w/${encodeURIComponent(invitation.workspaceId!)}/bundles`}>Open workspace</a>
          </Button>
        )}
        <Button variant="outline" asChild>
          <a
            href={`/auth/login?prompt=login&returnTo=${encodeURIComponent(`/invitations/${inviteId}`)}`}
          >
            Use another account
          </a>
        </Button>
      </div>
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
