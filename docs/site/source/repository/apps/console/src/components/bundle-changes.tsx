import { useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { ListFilter } from 'lucide-react';
import type { Draft, Proposal } from '@acclimate/sdk';
import type { ConsoleState } from '../server/channel';
import { runDraftCommand } from '../server/content-actions';
import { runImprovement } from '../server/improvement-actions';
import { bundleHref, workspaceHref } from '../navigation';
import { ConsoleLink } from './console-link';
import { DraftWorkspace } from './draft-workspace';
import { ImprovementWorkspace } from './improvement-workspace';
import { Button } from './ui/button';
import { mergeHistory, refreshKnownActive } from '../lib/improvement-history';
import { ChangesPipeline } from './changes-pipeline';
import { ChangesOverview } from './changes-overview';
import { loadPending } from '../lib/pending-operation';

type Ready = Extract<ConsoleState, { status: 'ready' }>;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
export function BundleChanges({
  state,
  search,
}: {
  state: Ready;
  search: Record<string, unknown>;
}) {
  const router = useRouter();
  const savedDraftFocus = useRef<string | null>(null);
  const scope = { projectId: state.projectId, bundleId: state.bundleId, channel: state.channel };
  const draft = text(search.draft),
    proposal = text(search.proposal),
    candidate = text(search.candidate);
  const storageScope = `${state.actorScope}:${state.projectId}:${state.bundleId}:${state.channel}`;
  const history = String(search.history) === '1';
  const detail =
    !history && Boolean(draft || proposal || candidate || search.comparison || search.request);
  if (history && (draft || proposal))
    return (
      <div role="alert" className="space-y-3">
        <p>History cannot be combined with a draft or suggestion editor.</p>
        <div className="flex flex-wrap gap-3">
          <ConsoleLink className="underline" href={bundleHref(scope, 'changes', { history: 1 })}>
            Open evaluation history
          </ConsoleLink>
          <ConsoleLink
            className="underline"
            href={bundleHref(scope, 'changes', {
              ...(draft ? { draft } : { proposal }),
              ...Object.fromEntries(
                ['candidate', 'generation', 'request', 'comparison', 'path'].flatMap((key) => {
                  const value = search[key];
                  return typeof value === 'string' || typeof value === 'number'
                    ? [[key, value]]
                    : [];
                }),
              ),
            })}
          >
            Open the selected change
          </ConsoleLink>
        </div>
      </div>
    );
  return (
    <div className="bundle-changes space-y-4 text-sm">
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
            actorScope={state.actorScope}
            serviceIdentity={state.serviceIdentity}
            initialDraftId={draft === 'new' ? undefined : draft}
            initialPath={text(search.path)}
            canEdit={state.canEdit}
            detailOnly
            focusOnOpen={savedDraftFocus.current === draft}
            onOpenFocusHandled={() => {
              savedDraftFocus.current = null;
            }}
            onSaved={(saved, path) => {
              savedDraftFocus.current = document.activeElement?.classList.contains(
                'draft-save-action',
              )
                ? saved.id
                : null;
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
          initial={{
            candidate,
            draft: draft === 'new' ? '' : draft,
            generation: Number(search.generation) || 0,
            proposal,
            comparison: text(search.comparison),
            pair: text(search.pair),
            fromRevision:
              typeof search.fromRevision === 'number' || typeof search.fromRevision === 'string'
                ? search.fromRevision
                : undefined,
            request: text(search.request),
          }}
          reviewTab={text(search.reviewTab)}
          mode={proposal === 'new' ? 'proposal' : 'review'}
        />
      ) : history ? (
        <ChangesOverview state={state} search={search} />
      ) : (
        <ChangeLists
          key={`${storageScope}:${state.serviceIdentity}`}
          state={state}
          search={search}
        />
      )}
    </div>
  );
}
function ChangeLists({ state, search }: { state: Ready; search: Record<string, unknown> }) {
  const scope = { projectId: state.projectId, bundleId: state.bundleId, channel: state.channel };
  const { actorScope, projectId, creationRecoveryServiceIdentity } = state;
  const [pendingCreation, setPendingCreation] = useState(false);
  useEffect(() => {
    try {
      const operation = loadPending(sessionStorage, {
        owner: 'library',
        actorScope,
        projectId,
        serviceIdentity: creationRecoveryServiceIdentity,
      });
      setPendingCreation(Boolean(operation));
    } catch {
      setPendingCreation(false);
    }
  }, [actorScope, projectId, creationRecoveryServiceIdentity]);
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [proposals, setProposals] = useState<Proposal[]>([]);
  const [draftCursor, setDraftCursor] = useState<string | null>(null),
    [proposalCursor, setProposalCursor] = useState<string | null>(null);
  const [draftError, setDraftError] = useState(''),
    [proposalError, setProposalError] = useState('');
  const [draftBusy, setDraftBusy] = useState(true),
    [proposalBusy, setProposalBusy] = useState(true);
  const [proposalsRead, setProposalsRead] = useState(false);
  const [showClosedDrafts, setShowClosedDrafts] = useState(false);
  const epoch = useRef(0);
  const proposalsRef = useRef<Proposal[]>([]);
  useEffect(() => {
    proposalsRef.current = proposals;
  }, [proposals]);
  const loadedMore = useRef(false);
  const draftLoadedMore = useRef(false);
  async function loadDrafts(cursor?: string, background = false) {
    const started = epoch.current;
    if (!background) setDraftBusy(true);
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
            : mergeHistory(previous, result.page!.items),
        );
        if (!background || !draftLoadedMore.current) setDraftCursor(result.page.nextCursor);
        if (cursor) draftLoadedMore.current = true;
      }
    } catch (error) {
      if (started === epoch.current)
        setDraftError(error instanceof Error ? error.message : 'Saved drafts could not be read.');
    } finally {
      if (started === epoch.current && !background) setDraftBusy(false);
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
        setProposalsRead(true);
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
    setProposalsRead(false);
    loadedMore.current = false;
    setProposalCursor(null);
    draftLoadedMore.current = false;
    let firstDraftRead = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (document.hidden) {
        if (epoch.current === started) timer = setTimeout(poll, 5000);
        return;
      }
      await Promise.all([loadProposals(), loadDrafts(undefined, !firstDraftRead)]);
      firstDraftRead = false;
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
  const overview = (
    <ChangesOverview
      state={state}
      search={search}
      toolbar={
        <Button
          size="sm"
          variant={showClosedDrafts ? 'secondary' : 'outline'}
          className="min-h-9"
          aria-pressed={showClosedDrafts}
          aria-label="Include closed drafts"
          onClick={() => setShowClosedDrafts(!showClosedDrafts)}
        >
          <ListFilter aria-hidden="true" /> Include closed
        </Button>
      }
      board={(model) => (
        <ChangesPipeline
          state={state}
          model={model}
          drafts={drafts}
          proposals={proposals}
          includeClosed={showClosedDrafts}
          loading={
            (draftBusy && !drafts.length) || (proposalBusy && !proposalsRead) || model.loading
          }
          errors={[draftError, proposalError, model.error]}
          moreDrafts={
            draftCursor && (
              <Button
                variant="outline"
                disabled={draftBusy}
                onClick={() => loadDrafts(draftCursor)}
              >
                Load more drafts
              </Button>
            )
          }
          moreSuggestions={
            proposalCursor && (
              <Button
                variant="outline"
                disabled={proposalBusy}
                onClick={() => loadProposals(proposalCursor)}
              >
                Load more suggestions
              </Button>
            )
          }
        />
      )}
    />
  );
  return (
    <>
      {pendingCreation && state.canEdit && (
        <div className="workspace-panel flex flex-wrap items-center justify-between gap-2 p-4">
          <p role="status">A bundle publication is still unresolved.</p>
          <Button asChild variant="outline">
            <ConsoleLink href={workspaceHref(projectId)}>Open creation recovery</ConsoleLink>
          </Button>
        </div>
      )}
      {overview}
    </>
  );
}
