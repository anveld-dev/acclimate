import { useEffect, useState } from 'react';
import { loadPending } from '../lib/pending-operation';
import type { ConsoleState } from '../server/channel';
import { workspaceHref } from '../navigation';
import { ChangesOverview } from './changes-overview';
import { ImprovementWorkspace } from './improvement-workspace';
import { ConsoleLink } from './console-link';

export function BundleChanges({
  state,
  search,
}: {
  state: Extract<ConsoleState, { status: 'ready' }>;
  search: Record<string, unknown>;
}) {
  const { actorScope, workspaceId, creationRecoveryServiceIdentity } = state;
  const [pendingCreation, setPendingCreation] = useState(false);
  useEffect(() => {
    try {
      setPendingCreation(
        Boolean(
          loadPending(sessionStorage, {
            owner: 'library',
            actorScope,
            workspaceId,
            serviceIdentity: creationRecoveryServiceIdentity,
          }),
        ),
      );
    } catch {
      setPendingCreation(false);
    }
  }, [actorScope, workspaceId, creationRecoveryServiceIdentity]);
  if (search.draft === 'new' || search.proposal === 'new')
    return (
      <p>
        Changes now come from connected learning.{' '}
        <ConsoleLink className="underline" href={workspaceHref(state.workspaceId, 'connections')}>
          Open connections
        </ConsoleLink>
      </p>
    );
  if (String(search.history) !== '1' && (search.comparison || search.proposal || search.draft))
    return (
      <ImprovementWorkspace
        key={JSON.stringify([
          state.actorScope,
          state.serviceIdentity,
          state.workspaceId,
          state.bundleId,
          state.channel,
          search,
        ])}
        state={state}
        search={search}
      />
    );
  return (
    <>
      {pendingCreation && state.canEdit && (
        <div className="workspace-panel flex flex-wrap items-center justify-between gap-2 p-4">
          <p role="status">A bundle publication is still unresolved.</p>
          <ConsoleLink className="underline" href={workspaceHref(workspaceId)}>
            Open creation recovery
          </ConsoleLink>
        </div>
      )}
      <p>
        Connected learning tests changes and releases them to your app.{' '}
        <ConsoleLink className="underline" href={workspaceHref(state.workspaceId, 'connections')}>
          View connections and learning rounds
        </ConsoleLink>
      </p>
      <ChangesOverview state={state} search={search} />
    </>
  );
}
