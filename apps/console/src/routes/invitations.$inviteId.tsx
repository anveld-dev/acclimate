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
    <div className="mx-auto w-full max-w-xl space-y-5 py-8">
      <PageTitle
        title={invitation ? `Join ${invitation.projectName}` : 'Workspace invitation'}
        description={invitation ? `Invited as ${invitation.role} · ${invitation.email}` : ''}
      />
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
                if (joined.ok && joined.projectId) {
                  window.location.assign(`/w/${encodeURIComponent(joined.projectId)}/bundles`);
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
            <a href={`/w/${encodeURIComponent(invitation.projectId!)}/bundles`}>Open workspace</a>
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
