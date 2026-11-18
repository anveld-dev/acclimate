import { useEffect, useRef, useState } from 'react';
import './changes-queues.css';
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
import { FilePenLine, ListFilter, Plus, Sparkles } from 'lucide-react';
import { ChangeRecordDetails } from './change-record-details';
import { mergeHistory, refreshKnownActive } from '../lib/improvement-history';
import { ChangesOverview } from './changes-overview';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';

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
          mode={proposal === 'new' ? 'proposal' : 'review'}
        />
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
  const [draftsOpen, setDraftsOpen] = useState(() => String(search.history) !== '1');
  const [suggestionsOpen, setSuggestionsOpen] = useState(() => String(search.history) !== '1');
  const draftTrigger = useRef<HTMLButtonElement>(null);
  const suggestionTrigger = useRef<HTMLButtonElement>(null);
  const draftBody = useRef<HTMLDivElement>(null);
  const suggestionBody = useRef<HTMLDivElement>(null);
  function changeOpen(
    open: boolean,
    body: HTMLDivElement | null,
    trigger: HTMLButtonElement | null,
    setOpen: (value: boolean) => void,
  ) {
    if (!open && body?.contains(document.activeElement)) trigger?.focus();
    setOpen(open);
  }
  const visibleDrafts = showClosedDrafts
    ? drafts
    : drafts.filter((draft) => draft.status === 'open');
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
  return (
    <ChangesOverview state={state} search={search}>
      <div className="change-queues changes-worklists">
        <section className="change-queue draft-worklist" aria-label="Saved drafts">
          <Disclosure
            open={draftsOpen}
            onOpenChange={(open) =>
              changeOpen(open, draftBody.current, draftTrigger.current, setDraftsOpen)
            }
          >
            <div className="change-queue-heading">
              <h3>
                <DisclosureTrigger ref={draftTrigger} className="change-queue-trigger">
                  <span className="change-queue-title">
                    {showClosedDrafts ? 'All drafts' : 'Open drafts'}
                  </span>
                  <span className="worklist-count" aria-hidden="true">
                    {!drafts.length && draftError
                      ? '—'
                      : draftBusy && !drafts.length
                        ? '…'
                        : visibleDrafts.length}
                  </span>
                  <span className="change-queue-scope">
                    {state.channel} channel
                    <span className="sr-only">
                      {' '}
                      · {showClosedDrafts ? '' : `${visibleDrafts.length} open in `}
                      {drafts.length} loaded{draftBusy ? ' · Loading…' : ''}
                    </span>
                    {draftCursor && <span> · More available</span>}
                  </span>
                </DisclosureTrigger>
              </h3>
              <div className="worklist-filter">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={showClosedDrafts}
                  aria-label="Include closed drafts"
                  aria-description="Include published and discarded drafts in this list"
                  onClick={() => setShowClosedDrafts(!showClosedDrafts)}
                >
                  <ListFilter aria-hidden="true" /> Include closed
                </Button>
              </div>
            </div>
            {draftError && (
              <p role="alert" className="change-queue-message text-destructive">
                {draftError}
              </p>
            )}
            <DisclosureContent className="change-queue-content" hidden={!draftsOpen}>
              <div ref={draftBody} className="change-queue-body">
                {draftBusy && !drafts.length ? (
                  <p role="status" className="change-queue-message">
                    Loading saved drafts…
                  </p>
                ) : !draftError && !visibleDrafts.length ? (
                  <div className="change-queue-empty">
                    <FilePenLine aria-hidden="true" />
                    <p>
                      {showClosedDrafts
                        ? 'No saved drafts in this channel.'
                        : draftCursor
                          ? 'No open drafts on the loaded pages. Load more drafts to check older entries.'
                          : 'No open drafts. Start a new draft to edit the current release.'}
                    </p>
                  </div>
                ) : (
                  <ul className="change-record-list">
                    {visibleDrafts.map((draft) => (
                      <li key={draft.id} className="change-record-row">
                        <FilePenLine aria-hidden="true" className="change-record-icon" />
                        <div className="change-record-copy">
                          <ConsoleLink
                            className="change-record-title"
                            href={bundleHref(scope, 'changes', { draft: draft.id })}
                          >
                            Draft from revision {draft.baseRevision}
                            <span className="sr-only"> · {draft.id}</span>
                          </ConsoleLink>
                          <p className="change-record-meta">
                            <span className="worklist-record-id">#{draft.id.slice(0, 8)}</span>
                            {' · '}Generation {draft.generation}
                            {' · '}
                            <time dateTime={draft.updatedAt}>
                              {new Date(draft.updatedAt).toLocaleDateString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                year: 'numeric',
                              })}
                            </time>
                          </p>
                        </div>
                        <div className="change-record-actions">
                          <Badge variant="outline" data-work-status={draft.status}>
                            {draft.status === 'open'
                              ? 'Open'
                              : draft.status === 'published'
                                ? 'Published'
                                : 'Discarded'}
                          </Badge>
                          <ChangeRecordDetails
                            title="Draft details"
                            identity={draft.id}
                            triggerLabel={`Draft details for ${draft.id}`}
                            description="The saved snapshot and the release it started from."
                            copyLabel="Copy draft details"
                            value={JSON.stringify(draft, null, 2)}
                            fields={[
                              ['Status', draft.status],
                              ['Generation', draft.generation],
                              ['Updated', new Date(draft.updatedAt).toLocaleString()],
                              ['Base revision', draft.baseRevision],
                              ['Draft ID', draft.id],
                              ['Base version', draft.baseVersionId],
                              ['Snapshot version', draft.snapshotVersion.id],
                            ]}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {draftCursor && (
                  <div className="change-queue-footer">
                    <Button
                      variant="outline"
                      disabled={draftBusy}
                      onClick={() => void loadDrafts(draftCursor)}
                    >
                      Load more drafts
                    </Button>
                  </div>
                )}
              </div>
            </DisclosureContent>
          </Disclosure>
        </section>
        <section className="change-queue suggestion-worklist" aria-label="Suggestions">
          <Disclosure
            open={suggestionsOpen}
            onOpenChange={(open) =>
              changeOpen(
                open,
                suggestionBody.current,
                suggestionTrigger.current,
                setSuggestionsOpen,
              )
            }
          >
            <div className="change-queue-heading">
              <h3>
                <DisclosureTrigger ref={suggestionTrigger} className="change-queue-trigger">
                  <span className="change-queue-title">Suggestions</span>
                  <span className="worklist-count" aria-hidden="true">
                    {!proposalsRead && proposalError
                      ? '—'
                      : !proposalsRead
                        ? '…'
                        : proposals.length}
                  </span>
                  <span className="change-queue-scope">
                    All bundle channels
                    <span className="sr-only">
                      {' '}
                      · {proposals.length} loaded
                      {proposalBusy && !proposalsRead ? ' · Loading…' : ''}
                    </span>
                    {proposalCursor && <span> · More available</span>}
                  </span>
                </DisclosureTrigger>
              </h3>
            </div>
            {proposalError && (
              <p role="alert" className="change-queue-message text-destructive">
                {proposalError}
              </p>
            )}
            <DisclosureContent className="change-queue-content" hidden={!suggestionsOpen}>
              <div ref={suggestionBody} className="change-queue-body">
                {proposalBusy && !proposalsRead && !proposals.length ? (
                  <p role="status" className="change-queue-message">
                    Loading suggestions…
                  </p>
                ) : !proposalError && !proposals.length ? (
                  <div className="change-queue-empty">
                    <Sparkles aria-hidden="true" />
                    <p>No suggestions yet.</p>
                  </div>
                ) : (
                  <ul className="change-record-list">
                    {proposals.map((proposal) => (
                      <li key={proposal.id} className="change-record-row">
                        <Sparkles aria-hidden="true" className="change-record-icon" />
                        <div className="change-record-copy">
                          <ConsoleLink
                            className="change-record-title change-proposal-title"
                            href={bundleHref(scope, 'changes', { proposal: proposal.id })}
                          >
                            {proposal.rationale?.trim().split('\n')[0] ||
                              (proposal.candidate ? 'Suggested update' : 'Suggestion request')}{' '}
                            <span className="change-record-short-id">
                              {proposal.id.slice(0, 8)}
                            </span>
                          </ConsoleLink>
                          <p className="change-record-meta">
                            Created{' '}
                            <time dateTime={proposal.createdAt}>
                              {new Date(proposal.createdAt).toLocaleString()}
                            </time>
                          </p>
                          {proposal.error && (
                            <p className="change-record-error">{proposal.error}</p>
                          )}
                        </div>
                        <div className="change-record-actions">
                          <Badge
                            variant={proposal.status === 'failed' ? 'destructive' : 'outline'}
                            data-work-status={
                              proposal.status === 'succeeded' && !proposal.candidate
                                ? 'no-candidate'
                                : proposal.status
                            }
                          >
                            {proposal.status === 'queued'
                              ? 'Queued'
                              : proposal.status === 'running'
                                ? 'Preparing'
                                : proposal.status === 'succeeded'
                                  ? proposal.candidate
                                    ? 'Ready to review'
                                    : 'No candidate'
                                  : 'Failed'}
                          </Badge>
                          <ChangeRecordDetails
                            title="Suggestion details"
                            identity={proposal.id}
                            triggerLabel={`Suggestion details for ${proposal.id}`}
                            description="The provider’s explanation and the version it started from."
                            copyLabel="Copy suggestion details"
                            value={JSON.stringify(proposal, null, 2)}
                            fields={[
                              ['Status', proposal.status],
                              ['Created', new Date(proposal.createdAt).toLocaleString()],
                              ['Rationale', proposal.rationale || 'No rationale reported.'],
                              ['Attempts', proposal.attempts],
                              ['Suggestion ID', proposal.id],
                              ['Parent version', proposal.parentVersionId],
                              ...(proposal.candidate
                                ? [['Candidate version', proposal.candidate.id] as [string, string]]
                                : []),
                              ...(proposal.error
                                ? [['Error', proposal.error] as [string, string]]
                                : []),
                            ]}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {proposalCursor && (
                  <div className="change-queue-footer">
                    <Button
                      variant="outline"
                      disabled={proposalBusy}
                      onClick={() => void loadProposals(proposalCursor)}
                    >
                      Load more suggestions
                    </Button>
                  </div>
                )}
              </div>
            </DisclosureContent>
          </Disclosure>
        </section>
      </div>
    </ChangesOverview>
  );
}
