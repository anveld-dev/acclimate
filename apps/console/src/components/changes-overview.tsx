import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import type { Evaluation } from '@acclimate/sdk';
import type { ConsoleState } from '../server/channel';
import { bundleHref, releaseRevision } from '../navigation';
import { artifactChanges } from '../lib/artifact-changes';
import { useEvaluationHistory } from './use-evaluation-history';
import type { EvaluationHistoryModel } from '../lib/changes-workspace';
import { EvaluationHistoryView, type HistoryFilters } from './evaluation-history-view';
import { HistoryFiles, useHistoryVersion } from './history-files';
import { ConsoleLink } from './console-link';
import { Button } from './ui/button';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from './ui/native-select';
import { evaluationVersionOptions } from '../lib/evaluation-version-options';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { ArrowLeft, Plus, Sparkles } from 'lucide-react';

type Ready = Extract<ConsoleState, { status: 'ready' }>;
const string = (value: unknown) => (typeof value === 'string' ? value : '');

type OverviewProps = {
  state: Ready;
  search: Record<string, unknown>;
  board?: (model: EvaluationHistoryModel) => ReactNode;
  /** Board-level view controls shown at the end of the Changes header row. */
  toolbar?: ReactNode;
};

export function ChangesOverview(props: OverviewProps) {
  const { actorScope, serviceIdentity, projectId, bundleId, channel } = props.state;
  return (
    <ScopedChangesOverview
      key={JSON.stringify([actorScope, serviceIdentity, projectId, bundleId, channel])}
      {...props}
    />
  );
}

/** A scoped collection selects context; one ledger explains the selected run. */
function ScopedChangesOverview({ state, search, board, toolbar }: OverviewProps) {
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>({ query: '', status: '' });
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
  const { versions, outside } = evaluationVersionOptions(model.requests, selectedCandidate);
  const fileCount =
    version.status === 'ready'
      ? version.base
        ? artifactChanges(version.base.payload, version.payload).length
        : version.payload.files.length
      : undefined;
  const heading = useRef<HTMLHeadingElement>(null);
  const selectorId = useId();
  const focusRegion = useRef('');
  useEffect(() => {
    if (focusRegion.current === 'files' && document.activeElement === document.body)
      heading.current?.focus();
  }, [selectedCandidate, version.status, tab]);

  const fromRevision = releaseRevision(search.fromRevision);
  function href(values: Record<string, string | number | undefined> = {}) {
    return bundleHref(scope, 'changes', {
      history: 1,
      candidate: selectedCandidate || undefined,
      request: requestId || undefined,
      tab: tab === 'files' ? 'files' : undefined,
      path: string(search.path) || undefined,
      fromRevision:
        !values.candidate || values.candidate === selectedCandidate ? fromRevision : undefined,
      ...values,
    });
  }
  // Opening a row from the unfiltered ledger moves it into the version tabs.
  const keyboardRequest = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const trigger = keyboardRequest.current;
    keyboardRequest.current = null;
    if (!trigger || trigger.isConnected || document.activeElement !== document.body || !requestId)
      return;
    document.getElementById(`ledger-request-${requestId}`)?.focus({ preventScroll: true });
  }, [selectedCandidate, requestId]);

  function selectRequest(request: Evaluation | null) {
    keyboardRequest.current = request
      ? document.querySelector<HTMLElement>('.evaluation-ledger-trigger:focus-visible')
      : null;
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
      fromRevision: request.candidateVersionId === selectedCandidate ? fromRevision : undefined,
      request: request.id,
      comparison: request.comparisonId || undefined,
    });
  }
  const allHistoryHref = bundleHref(scope, 'changes', { history: 1 });
  const selectionMismatch =
    model.selectedState === 'mismatch' ||
    (Boolean(search.comparison) &&
      model.selectedState === 'ready' &&
      model.selectedRequest?.comparisonId !== search.comparison);

  const historyPage = String(search.history) === '1';
  const restoreVersionFocus = useRef(false);
  const versionSelector = (
    <div className="changes-version-selector ledger-version-filter">
      <label htmlFor={selectorId}>Evaluation version</label>
      <NativeSelect
        id={selectorId}
        ref={(node) => {
          if (node && restoreVersionFocus.current && document.activeElement === document.body) {
            node.focus({ preventScroll: true });
            restoreVersionFocus.current = false;
          }
        }}
        aria-describedby={`${selectorId}-scope`}
        value={selectedCandidate || (requestId ? '__unresolved__' : '')}
        onChange={(event) => {
          const value = event.target.value;
          if (
            value === '__unresolved__' ||
            (value === selectedCandidate && (value !== '' || !requestId))
          )
            return;
          restoreVersionFocus.current =
            Boolean(value) !== Boolean(selectedCandidate) &&
            document.activeElement === event.currentTarget;
          void router.navigate({
            href: value
              ? href({
                  candidate: value,
                  request: undefined,
                  comparison: undefined,
                  path: undefined,
                })
              : allHistoryHref,
          });
        }}
      >
        <NativeSelectOption value="">All evaluations</NativeSelectOption>
        {requestId && !selectedCandidate && (
          <NativeSelectOption value="__unresolved__" disabled>
            Request selection unresolved
          </NativeSelectOption>
        )}
        {outside && (
          <NativeSelectOption value={outside}>
            Selected outside loaded history: {outside}
          </NativeSelectOption>
        )}
        <NativeSelectOptGroup label="Versions in loaded history">
          {versions.map(({ id, count }) => (
            <NativeSelectOption key={id} value={id}>
              {id === state.resolution.version.id ? `Published on ${state.channel}` : 'Candidate'}{' '}
              {id.slice(0, 8)} · {count} loaded {count === 1 ? 'request' : 'requests'}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
      </NativeSelect>
      <p id={`${selectorId}-scope`}>
        {versions.length} candidate {versions.length === 1 ? 'version' : 'versions'} in loaded
        history.
      </p>
      {selectedCandidate && (
        <p className="changes-selected-version-id">Selected version: {selectedCandidate}</p>
      )}
    </div>
  );
  const ledger = (
    <>
      {selectedCandidate &&
        !model.requests.some((request) => request.candidateVersionId === selectedCandidate) &&
        !model.loading &&
        !model.error && (
          <div className="changes-history-context text-sm text-muted-foreground">
            <p>
              No requests for this version in the loaded history. Older evaluations may still exist.
            </p>
            <ConsoleLink
              className="underline"
              href={bundleHref(scope, 'changes', { candidate: selectedCandidate, fromRevision })}
            >
              Open version review and evaluation setup
            </ConsoleLink>
          </div>
        )}
      <EvaluationHistoryView
        filters={historyFilters}
        onFiltersChange={setHistoryFilters}
        versionSelector={selectedCandidate ? undefined : versionSelector}
        model={model}
        selectedCandidateId={selectedCandidate || undefined}
        selectedRequestId={requestId || undefined}
        onSelectRequest={selectRequest}
        reviewHref={reviewHref}
      />
    </>
  );

  return (
    <div
      className="changes-overview"
      data-version-selected={selectedCandidate ? true : undefined}
      data-history={historyPage || undefined}
    >
      {historyPage ? (
        <header className="changes-history-toolbar">
          <Button asChild size="sm" variant="ghost">
            <ConsoleLink href={bundleHref(scope, 'changes')}>
              <ArrowLeft aria-hidden="true" /> Changes
            </ConsoleLink>
          </Button>
          <span ref={heading} tabIndex={-1}>
            {state.channel} · Revision {state.resolution.revision}
          </span>
        </header>
      ) : (
        <header className="changes-overview-toolbar">
          <div>
            <h2 ref={heading} tabIndex={-1}>
              Changes
            </h2>
            <p>
              {state.channel} · {selectedCandidate ? 'Current revision' : 'Revision'}{' '}
              {state.resolution.revision}
              {state.canEdit ? '' : ' · Read-only'}
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
          {toolbar && <div className="changes-overview-view">{toolbar}</div>}
        </header>
      )}
      {!historyPage && board?.(model)}
      {historyPage && (
        <div className="changes-overview-grid">
          <section
            className="changes-main"
            aria-label="Changes workspace"
            onFocusCapture={(event) => {
              focusRegion.current = (event.target as HTMLElement).closest(
                '.history-files, [role="tablist"]',
              )
                ? 'files'
                : 'main';
            }}
          >
            {(selectedCandidate || selectionMismatch) && versionSelector}
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
                    fromRevision,
                  })}
                >
                  Open comparison
                </ConsoleLink>
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
