import { useEffect, useId, useRef, type ReactNode } from 'react';
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
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from './ui/native-select';
import { evaluationVersionOptions } from '../lib/evaluation-version-options';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Plus, Sparkles } from 'lucide-react';

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
    <div className="changes-overview">
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
      <div className="changes-overview-queues">{children}</div>
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
          <div className="changes-version-selector">
            <label htmlFor={selectorId}>Evaluation version</label>
            <NativeSelect
              id={selectorId}
              value={selectedCandidate || (requestId ? '__unresolved__' : '')}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === '__unresolved__' ||
                  (value === selectedCandidate && (value !== '' || !requestId))
                )
                  return;
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
                    {id} · {count} loaded {count === 1 ? 'request' : 'requests'}
                  </NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
            </NativeSelect>
            <p>Versions and counts come from loaded history only.</p>
            {selectedCandidate && (
              <p className="changes-selected-version-id">Selected version: {selectedCandidate}</p>
            )}
          </div>
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
