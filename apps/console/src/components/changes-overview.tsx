import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import type { Evaluation } from '@acclimate/sdk';
import type { ConsoleState } from '../server/channel';
import { bundleHref } from '../navigation';
import { artifactChanges } from '../lib/artifact-changes';
import { useEvaluationHistory } from './use-evaluation-history';
import { EvaluationHistoryView } from './evaluation-history-view';
import { HistoryFiles, useHistoryVersion } from './history-files';
import { ConsoleLink } from './console-link';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { ChevronDown, FileClock, History, Plus, Sparkles } from 'lucide-react';

type Ready = Extract<ConsoleState, { status: 'ready' }>;
const string = (value: unknown) => (typeof value === 'string' ? value : '');

/** A scoped collection selects context; one ledger explains the selected run. */
export function ChangesOverview({
  state,
  search,
  children,
}: {
  state: Ready;
  search: Record<string, unknown>;
  children: ReactNode;
}) {
  const router = useRouter();
  const scope = {
    projectId: state.projectId,
    bundleId: state.bundleId,
    channel: state.channel,
    actorScope: state.actorScope,
    serviceIdentity: state.serviceIdentity,
  };
  const candidate = string(search.candidate);
  const requestId = string(search.request);
  const model = useEvaluationHistory({
    scope,
    selectedCandidateId: candidate || undefined,
    selectedRequestId: requestId || undefined,
  });
  const selectedCandidate =
    candidate ||
    (model.selectedState !== 'mismatch' && model.selectedRequest?.id === requestId
      ? model.selectedRequest.candidateVersionId
      : '') ||
    '';
  const version = useHistoryVersion(scope, selectedCandidate || undefined);
  const tab = search.tab === 'files' && selectedCandidate ? 'files' : 'evaluations';
  const invalidTab =
    search.tab !== undefined && !['files', 'evaluations'].includes(String(search.tab));
  const groups = new Map<string, number>();
  for (const request of model.requests)
    groups.set(request.candidateVersionId, (groups.get(request.candidateVersionId) || 0) + 1);
  const outside = selectedCandidate && !groups.has(selectedCandidate);
  const fileCount =
    version.status === 'ready'
      ? version.base
        ? artifactChanges(version.base.payload, version.payload).length
        : version.payload.files.length
      : undefined;
  const [compact, setCompact] = useState(true);
  const [browseOpen, setBrowseOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const navigator = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const browseRef = useRef(browseOpen);
  browseRef.current = browseOpen;
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const browseId = useId();
  const focusRegion = useRef('');
  const restoreDesktopFocus = useRef(false);
  useLayoutEffect(() => {
    if (!compact && restoreDesktopFocus.current) {
      restoreDesktopFocus.current = false;
      (
        navigator.current?.querySelector<HTMLElement>('a[aria-current="page"], a[href]') ||
        heading.current
      )?.focus();
    }
  }, [compact]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width < 1000;
      if (next && !compactRef.current && navigator.current?.contains(document.activeElement))
        setBrowseOpen(true);
      if (!next && compactRef.current && document.activeElement === toggle.current)
        restoreDesktopFocus.current = true;
      setCompact(next);
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (focusRegion.current === 'files' && document.activeElement === document.body)
      heading.current?.focus();
  }, [selectedCandidate, version.status, tab]);

  function closeBrowse() {
    if (compactRef.current && browseRef.current) {
      if (navigator.current?.contains(document.activeElement))
        requestAnimationFrame(() => toggle.current?.focus());
      setBrowseOpen(false);
    }
  }
  function href(values: Record<string, string | number | undefined> = {}) {
    return bundleHref(scope, 'changes', {
      history: 1,
      candidate: selectedCandidate || undefined,
      request: requestId || undefined,
      tab: tab === 'files' ? 'files' : undefined,
      path: string(search.path) || undefined,
      ...values,
    });
  }
  function selectRequest(request: Evaluation | null) {
    const changedCandidate = request && request.candidateVersionId !== selectedCandidate;
    void router.navigate({
      href: href({
        request: request?.id,
        candidate: request?.candidateVersionId || selectedCandidate || undefined,
        comparison: undefined,
        path: changedCandidate ? undefined : string(search.path) || undefined,
      }),
    });
  }
  function reviewHref(request: Evaluation) {
    return bundleHref(scope, 'changes', {
      candidate: request.candidateVersionId,
      request: request.id,
      comparison: request.comparisonId || undefined,
    });
  }
  const allHistoryHref = bundleHref(scope, 'changes', { history: 1 });
  const context = selectedCandidate
    ? `Version ${selectedCandidate.slice(0, 8)}`
    : 'All evaluations';
  const selectionMismatch =
    model.selectedState === 'mismatch' ||
    (search.comparison &&
      model.selectedState === 'ready' &&
      model.selectedRequest?.comparisonId !== search.comparison);

  const ledger = (
    <>
      {selectedCandidate &&
        !model.requests.some((request) => request.candidateVersionId === selectedCandidate) &&
        !model.loading && (
          <div className="changes-history-context text-sm text-muted-foreground">
            <p>
              No requests for this version in the loaded history. Older evaluations may still exist.
            </p>
            <ConsoleLink
              className="underline"
              href={bundleHref(scope, 'changes', { candidate: selectedCandidate })}
            >
              Open version review and evaluation setup
            </ConsoleLink>
          </div>
        )}
      <EvaluationHistoryView
        model={model}
        selectedCandidateId={selectedCandidate || undefined}
        selectedRequestId={requestId || undefined}
        onSelectRequest={selectRequest}
        reviewHref={reviewHref}
      />
    </>
  );

  return (
    <div ref={host} className="changes-overview" data-compact={compact}>
      <header className="changes-overview-toolbar">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            Changes
          </h2>
          <p>
            {state.canEdit
              ? 'Drafts, suggestions and evaluation evidence.'
              : 'Read-only access · inspect drafts, suggestions and evidence.'}
          </p>
        </div>
        {state.canEdit && (
          <div className="changes-overview-actions">
            <Button asChild>
              <ConsoleLink href={bundleHref(scope, 'changes', { draft: 'new' })}>
                <Plus aria-hidden="true" />
                New draft
              </ConsoleLink>
            </Button>
            <Button asChild variant="outline">
              <ConsoleLink href={bundleHref(scope, 'changes', { proposal: 'new' })}>
                <Sparkles aria-hidden="true" />
                Suggest a change
              </ConsoleLink>
            </Button>
          </div>
        )}
      </header>
      <div className="changes-overview-grid">
        <Collapsible
          open={!compact || browseOpen}
          onOpenChange={setBrowseOpen}
          className="changes-collection"
        >
          <CollapsibleTrigger asChild hidden={!compact}>
            <Button
              ref={toggle}
              type="button"
              variant="outline"
              className="changes-browse-trigger"
              aria-controls={browseId}
            >
              <span>
                Browse changes{' '}
                <span className="text-muted-foreground">· {context} · all bundle channels</span>
              </span>
              <ChevronDown aria-hidden="true" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent
            id={browseId}
            ref={navigator}
            className="changes-collection-body"
            onClickCapture={(event) => {
              if ((event.target as HTMLElement).closest('a[href]')) closeBrowse();
            }}
          >
            {children}
            <section
              className="changes-history-navigation"
              aria-label="Evaluation history navigation"
            >
              <h3>Evaluation history</h3>
              <p>All bundle channels · {model.requests.length} loaded requests</p>
              <ConsoleLink
                href={allHistoryHref}
                className="changes-collection-link"
                aria-current={!selectedCandidate ? 'page' : undefined}
              >
                <History aria-hidden="true" />
                <span>All evaluations</span>
              </ConsoleLink>
              <h4>Versions in loaded history</h4>
              {!groups.size && (
                <p className="changes-navigation-empty">
                  {model.loading
                    ? 'Loading history…'
                    : model.error
                      ? 'History unavailable.'
                      : 'No loaded requests yet.'}
                </p>
              )}
              {[...groups].map(([id, count]) => (
                <ConsoleLink
                  key={id}
                  href={href({
                    candidate: id,
                    request: undefined,
                    path: undefined,
                    comparison: undefined,
                  })}
                  className="changes-collection-link"
                  aria-current={selectedCandidate === id ? 'page' : undefined}
                  aria-label={`Version ${id}, ${count} loaded requests`}
                >
                  <FileClock aria-hidden="true" />
                  <span>
                    <strong>Version {id.slice(0, 8)}</strong>
                    <small>
                      {count} loaded {count === 1 ? 'request' : 'requests'}
                    </small>
                  </span>
                </ConsoleLink>
              ))}
              {outside && (
                <div className="changes-selected-version" aria-current="page">
                  <strong>{context}</strong>
                  <p>Selected outside loaded history</p>
                </div>
              )}
              {model.cursor && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={model.loading}
                  onClick={() => void model.loadMore()}
                >
                  Load older history
                </Button>
              )}
            </section>
          </CollapsibleContent>
        </Collapsible>
        <section
          className="changes-main"
          aria-label="Changes workspace"
          onFocusCapture={(event) => {
            focusRegion.current = (event.target as HTMLElement).closest('.history-files')
              ? 'files'
              : 'main';
          }}
        >
          {selectedCandidate && (
            <div className="changes-main-heading">
              <div>
                <h3>{context}</h3>
                <p>Requests for this version · all bundle channels</p>
              </div>
              <ConsoleLink className="underline text-sm" href={allHistoryHref}>
                All evaluations
              </ConsoleLink>
            </div>
          )}
          {(invalidTab || (search.tab === 'files' && !selectedCandidate)) && (
            <p role="status" className="changes-view-note">
              That file view is unavailable here. Showing evaluations.
            </p>
          )}
          {selectionMismatch ? (
            <div role="alert" className="space-y-3">
              <p>
                The selected request, version or comparison does not match. No evidence has been
                attached to this selection.
              </p>
              <ConsoleLink className="underline" href={allHistoryHref}>
                Clear the selection
              </ConsoleLink>
            </div>
          ) : selectedCandidate ? (
            <Tabs
              value={tab}
              onValueChange={(value) => {
                void router.navigate({ href: href({ tab: value }) });
              }}
            >
              <TabsList variant="line" aria-label="Selected version view">
                <TabsTrigger value="evaluations">Evaluations</TabsTrigger>
                <TabsTrigger value="files">
                  Files{fileCount === undefined ? '' : ` ${fileCount}`}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="evaluations">
                {version.status === 'unavailable' && (
                  <p role="alert" className="changes-view-note">
                    {version.message} Evaluation history remains available below.
                  </p>
                )}
                {ledger}
              </TabsContent>
              <TabsContent
                value="files"
                onFocusCapture={() => {
                  focusRegion.current = 'files';
                }}
              >
                <HistoryFiles
                  value={version}
                  scopeKey={`${state.actorScope}:${state.serviceIdentity}:${state.projectId}:${state.bundleId}`}
                  requestedPath={string(search.path) || undefined}
                  onSelectPath={(path) => {
                    void router.navigate({ href: href({ path }) });
                  }}
                />
              </TabsContent>
            </Tabs>
          ) : (
            ledger
          )}
          {!!search.comparison && !requestId && (
            <p role="alert" className="changes-view-note">
              A comparison needs its independent review view.{' '}
              <ConsoleLink
                className="underline"
                href={bundleHref(scope, 'changes', {
                  candidate: candidate || undefined,
                  comparison: string(search.comparison),
                })}
              >
                Open comparison
              </ConsoleLink>
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
