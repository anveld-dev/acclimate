import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import type { Draft, Proposal } from '@acclimate/sdk';
import type { ConsoleState } from '../server/channel';
import { runDraftCommand } from '../server/content-actions';
import { runImprovement } from '../server/improvement-actions';
import { bundleHref } from '../navigation';
import { ConsoleLink } from './console-link';
import { DraftWorkspace } from './draft-workspace';
import { ImprovementWorkspace } from './improvement-workspace';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { mergeHistory, refreshKnownActive } from '../lib/improvement-history';

type Ready = Extract<ConsoleState, { status: 'ready' }>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
export function BundleChanges({
  state,
  search,
  draftChannelControl,
}: {
  state: Ready;
  search: Record<string, unknown>;
  draftChannelControl?: ReactNode;
}) {
  const router = useRouter();
  const scope = { projectId: state.projectId, bundleId: state.bundleId, channel: state.channel };
  const draft = text(search.draft),
    proposal = text(search.proposal),
    candidate = text(search.candidate);
  const storageScope = `${state.actorScope}:${state.projectId}:${state.bundleId}:${state.channel}`;
  const detail = Boolean(draft || proposal || candidate || search.comparison);
  return (
    <div className="space-y-4 text-sm">
      {detail && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ConsoleLink
            href={bundleHref(scope, 'changes')}
            className="inline-block text-sm underline"
          >
            Back to changes
          </ConsoleLink>
          {draft && !candidate && draftChannelControl}
        </div>
      )}
      {draft && !candidate ? (
        draft === 'new' && !state.canEdit ? (
          <p role="alert">
            You have read-only access. Open an existing saved change to inspect it.
          </p>
        ) : (
          <DraftWorkspace
            key={`${storageScope}:${draft === 'new' ? 'new' : draft}`}
            published={state.payload}
            compatibilityTarget={state.compatibilityTarget}
            revision={state.resolution.revision}
            versionId={state.resolution.version.id}
            scope={storageScope}
            commandScope={scope}
            initialDraftId={draft === 'new' ? undefined : draft}
            initialPath={text(search.path)}
            canEdit={state.canEdit}
            detailOnly
            onSaved={(saved, path) => {
              return router.navigate({
                href: bundleHref(scope, 'changes', {
                  draft: saved.id,
                  path: path || text(search.path) || undefined,
                }),
                replace: true,
                ignoreBlocker: true,
              });
            }}
            onSelectPath={(path) =>
              void router.navigate({
                href: bundleHref(scope, 'changes', { draft, path }),
                replace: true,
                ignoreBlocker: true,
              })
            }
          />
        )
      ) : proposal === 'new' && !state.canEdit ? (
        <p role="alert">You have read-only access. Open an existing suggestion to inspect it.</p>
      ) : detail ? (
        <ImprovementWorkspace
          key={`${storageScope}:${proposal}:${candidate}:${draft}:${Number(search.generation) || 0}`}
          state={state}
          releaseTargetControl={draftChannelControl}
          initial={{
            candidate,
            draft: draft === 'new' ? '' : draft,
            generation: Number(search.generation) || 0,
            proposal,
            comparison: text(search.comparison),
          }}
          mode={proposal === 'new' ? 'proposal' : 'review'}
        />
      ) : (
        <ChangeLists state={state} draftChannelControl={draftChannelControl} />
      )}
    </div>
  );
}
function ChangeLists({
  state,
  draftChannelControl,
}: {
  state: Ready;
  draftChannelControl?: ReactNode;
}) {
  const scope = { projectId: state.projectId, bundleId: state.bundleId, channel: state.channel };
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [proposals, setProposals] = useState<Proposal[]>([]);
  const [draftCursor, setDraftCursor] = useState<string | null>(null),
    [proposalCursor, setProposalCursor] = useState<string | null>(null);
  const [draftError, setDraftError] = useState(''),
    [proposalError, setProposalError] = useState('');
  const [draftBusy, setDraftBusy] = useState(true),
    [proposalBusy, setProposalBusy] = useState(true);
  const [showClosedDrafts, setShowClosedDrafts] = useState(false);
  const visibleDrafts = showClosedDrafts
    ? drafts
    : drafts.filter((draft) => draft.status === 'open');
  const epoch = useRef(0);
  const proposalsRef = useRef<Proposal[]>([]);
  useEffect(() => {
    proposalsRef.current = proposals;
  }, [proposals]);
  const loadedMore = useRef(false);
  async function loadDrafts(cursor?: string) {
    const started = epoch.current;
    setDraftBusy(true);
    setDraftError('');
    try {
      const result = await runDraftCommand({ data: { action: 'list', cursor, scope } });
      if (started !== epoch.current) return;
      if (!result.ok) throw Error(result.message);
      if (result.page) {
        setDrafts((previous) =>
          cursor
            ? [
                ...previous,
                ...result.page!.items.filter((next) => !previous.some((old) => old.id === next.id)),
              ]
            : result.page!.items,
        );
        setDraftCursor(result.page.nextCursor);
      }
    } catch (error) {
      if (started === epoch.current)
        setDraftError(error instanceof Error ? error.message : 'Saved drafts could not be read.');
    } finally {
      if (started === epoch.current) setDraftBusy(false);
    }
  }
  async function loadProposals(cursor?: string) {
    const started = epoch.current;
    setProposalBusy(true);
    setProposalError('');
    try {
      const result = await runImprovement({
        data: { action: 'proposals', proposalCursor: cursor, scope },
      });
      if (started !== epoch.current) return;
      if (!result.ok) throw Error(result.message);
      if ('proposals' in result && result.proposals) {
        const page = result.proposals;
        setProposals((previous) => mergeHistory(previous, page.items, !!cursor));
        if (cursor || !loadedMore.current) setProposalCursor(page.nextCursor);
        if (cursor) loadedMore.current = true;
      }
    } catch (error) {
      if (started === epoch.current)
        setProposalError(error instanceof Error ? error.message : 'Suggestions could not be read.');
    } finally {
      if (started === epoch.current) setProposalBusy(false);
    }
  }
  useEffect(() => {
    epoch.current++;
    const started = epoch.current;
    setDrafts([]);
    setProposals([]);
    loadedMore.current = false;
    setProposalCursor(null);
    void loadDrafts();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await loadProposals();
      try {
        const changed = await refreshKnownActive(
          proposalsRef.current,
          async (id) => {
            const result = await runImprovement({ data: { action: 'proposal', id, scope } });
            return result.ok ? result.proposal : undefined;
          },
          () => epoch.current === started,
        );
        if (epoch.current !== started) return;
        setProposals((previous) =>
          previous.map((row) => changed.find((next) => next.id === row.id) || row),
        );
      } catch {
        if (epoch.current === started)
          setProposalError('Some suggestion states could not be refreshed.');
      }
      if (epoch.current === started) timer = setTimeout(poll, 5000);
    }
    void poll();
    return () => {
      epoch.current++;
      clearTimeout(timer);
    };
  }, [state.actorScope, state.projectId, state.bundleId, state.channel]);
  return (
    <>
      <div className="workspace-panel flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Make a change</h2>
          <p className="text-muted-foreground">
            Edit a draft, evaluate the saved change, then publish when ready.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {state.canEdit && (
            <>
              <Button asChild>
                <ConsoleLink href={bundleHref(scope, 'changes', { draft: 'new' })}>
                  New draft
                </ConsoleLink>
              </Button>
              <Button asChild variant="outline">
                <ConsoleLink href={bundleHref(scope, 'changes', { proposal: 'new' })}>
                  Suggest a change
                </ConsoleLink>
              </Button>
            </>
          )}
        </div>
      </div>
      <section className="workspace-panel space-y-4 p-4" aria-label="Saved drafts">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">
              {showClosedDrafts ? 'All drafts' : 'Open drafts'} · {state.channel}
            </h2>
          </div>
          {draftChannelControl}
          <Button variant="outline" disabled={draftBusy} onClick={() => void loadDrafts()}>
            Refresh drafts
          </Button>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={showClosedDrafts}
          onClick={() => setShowClosedDrafts(!showClosedDrafts)}
        >
          {showClosedDrafts ? 'Show open drafts' : 'Include published and discarded drafts'}
        </Button>
        {draftError && <p role="alert">{draftError}</p>}
        {draftBusy && !drafts.length ? (
          <p role="status">Loading saved drafts…</p>
        ) : !draftError && !visibleDrafts.length ? (
          <p className="text-muted-foreground">
            {showClosedDrafts
              ? 'No saved drafts in this channel.'
              : 'No open drafts. Start a new draft to edit the current release.'}
          </p>
        ) : (
          <ul className="divide-y">
            {visibleDrafts.map((draft) => (
              <li key={draft.id} className="py-3">
                <ConsoleLink
                  className="font-medium underline"
                  href={bundleHref(scope, 'changes', { draft: draft.id })}
                >
                  Draft {draft.id.slice(0, 8)}
                </ConsoleLink>
                <Badge className="ml-2" variant="outline">
                  {draft.status === 'open'
                    ? 'Draft'
                    : draft.status === 'published'
                      ? 'Published'
                      : 'Discarded'}
                </Badge>
                <p className="mt-1 text-muted-foreground">
                  Generation {draft.generation} · updated{' '}
                  <time dateTime={draft.updatedAt}>
                    {new Date(draft.updatedAt).toLocaleString()}
                  </time>
                </p>
                <details className="mt-1 text-muted-foreground">
                  <summary className="cursor-pointer">Draft details</summary>
                  <p className="break-all">
                    Draft {draft.id} · base {draft.baseVersionId} · revision {draft.baseRevision} ·
                    snapshot {draft.snapshotVersion.id}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        )}
        {draftCursor && (
          <Button
            variant="outline"
            disabled={draftBusy}
            onClick={() => void loadDrafts(draftCursor)}
          >
            Load more drafts
          </Button>
        )}
      </section>
      <section className="workspace-panel space-y-4 p-4" aria-label="Suggestions">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">Suggestions · all channels</h2>
            <p className="text-sm text-muted-foreground">
              Review provider suggestions before choosing a release channel.
            </p>
          </div>
          <Button variant="outline" disabled={proposalBusy} onClick={() => void loadProposals()}>
            Refresh suggestions
          </Button>
        </div>
        {proposalError && <p role="alert">{proposalError}</p>}
        {proposalBusy && !proposals.length ? (
          <p role="status">Loading suggestions…</p>
        ) : !proposalError && !proposals.length ? (
          <p className="text-muted-foreground">No suggestions yet.</p>
        ) : (
          <ul className="divide-y">
            {proposals.map((proposal) => (
              <li key={proposal.id} className="py-3">
                <ConsoleLink
                  className="font-medium underline"
                  href={bundleHref(scope, 'changes', { proposal: proposal.id })}
                >
                  Suggestion {proposal.id.slice(0, 8)}
                </ConsoleLink>
                <p className="mt-1 text-muted-foreground">
                  {proposal.status === 'queued'
                    ? 'Waiting for provider'
                    : proposal.status === 'running'
                      ? 'Preparing suggestion'
                      : proposal.status === 'succeeded'
                        ? 'Ready to review'
                        : 'Failed'}{' '}
                  · created{' '}
                  <time dateTime={proposal.createdAt}>
                    {new Date(proposal.createdAt).toLocaleString()}
                  </time>
                </p>
                <details className="mt-1 text-muted-foreground">
                  <summary className="cursor-pointer">Suggestion details</summary>
                  <p className="break-all">
                    Suggestion {proposal.id} · parent {proposal.parentVersionId}
                  </p>
                </details>
                {proposal.error && <p className="mt-1 text-sm">{proposal.error}</p>}
              </li>
            ))}
          </ul>
        )}
        {proposalCursor && (
          <Button
            variant="outline"
            disabled={proposalBusy}
            onClick={() => void loadProposals(proposalCursor)}
          >
            Load more suggestions
          </Button>
        )}
      </section>
    </>
  );
}
