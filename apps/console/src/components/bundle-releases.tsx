import { ReceiptTime } from './receipt-time';
import { ReleaseComparison } from './release-comparison';
import './release-comparison.css';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { RelatedPendingNotice, useRelatedPending } from './related-pending';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { CircleCheck, GitCommitHorizontal } from 'lucide-react';
import { ChangeRecordDetails } from './change-record-details';
import { SyntaxCode } from './syntax-code';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { VersionInspector } from './version-inspector';
import { ConsoleLink, consoleDestination } from './console-link';
import { CopyButton } from './copy-button';
import { bundleHref, releaseRevision } from '../navigation';
import {
  freezePending,
  loadPending,
  resolvePending,
  forgetPending,
  type PendingScope,
  type PendingOperation,
} from '../lib/pending-operation';
import { matchesRelease } from '../lib/release-search';
import { restoreRequest } from '../lib/content-operation';
import {
  readReleaseHistory,
  runReleaseOperation,
  reconcileReleaseOperation,
} from '../server/read-console';
import type { ConsoleState } from '../server/channel';

export function BundleReleases({ state }: { state: Extract<ConsoleState, { status: 'ready' }> }) {
  const router = useRouter();
  const restoreReturnRef = useRef<HTMLElement | null>(null);
  const scope = { workspaceId: state.workspaceId, bundleId: state.bundleId, channel: state.channel };
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [page, setPage] = useState(state.history);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [linkedRelease, setLinkedRelease] = useState<(typeof page.items)[number] | null>(null);
  const activeHash = useRouterState({ select: (state) => state.location.hash });
  const fragment = activeHash ? '#' + activeHash : '';
  useEffect(() => {
    let ignore = false;
    const revision = releaseRevision(/^#revision-(.+)$/.exec(fragment)?.[1]);
    if (
      !revision ||
      linkedRelease?.revision === revision ||
      page.items.some((item) => item.revision === revision)
    )
      return;
    if (!page.nextBeforeRevision || BigInt(revision) >= BigInt(page.nextBeforeRevision)) return;
    const beforeRevision = String(BigInt(revision) + 1n);
    async function readLinkedRelease() {
      try {
        const result = await readReleaseHistory({
          data: { scope, beforeRevision },
        });
        if (ignore) return;
        if (!result.ok) setError(result.message);
        else {
          const found = result.page.items.find((item) => item.revision === revision);
          if (found) setLinkedRelease(found);
          else setError('This revision could not be found in the channel history.');
        }
      } catch {
        if (!ignore) setError('Could not load the linked revision. Reload to retry.');
      }
    }
    void readLinkedRelease();
    return () => {
      ignore = true;
    };
  }, [fragment, linkedRelease, page, state.workspaceId, state.bundleId, state.channel]);
  useEffect(() => {
    if (linkedRelease && fragment === '#revision-' + linkedRelease.revision) {
      document.getElementById(fragment.slice(1))?.focus();
    }
  }, [linkedRelease, fragment]);
  const showLinked =
    linkedRelease &&
    fragment === '#revision-' + linkedRelease.revision &&
    !page.items.some((item) => item.id === linkedRelease.id);
  const loadedItems = showLinked ? [...page.items, linkedRelease] : page.items;
  const term = query.trim().toLowerCase();
  const matches = loadedItems.filter((item) => matchesRelease(item, term));
  const requestedRevision = releaseRevision(/^#revision-(.+)$/.exec(fragment)?.[1]);
  const selected =
    matches.find((item) => item.revision === requestedRevision) ??
    (term || !requestedRevision ? matches[0] : undefined);
  function chooseRevision(revision: string) {
    void router.navigate({
      ...consoleDestination(bundleHref(scope, 'releases') + '#revision-' + revision),
      hashScrollIntoView: false,
      resetScroll: false,
      replace: true,
    });
  }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [target, setTarget] = useState<{
    sourceRevision: string;
    versionId: string;
    reviewedRevision: string;
  } | null>(null);
  const [staleReview, setStaleReview] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const recoveryScope: PendingScope = {
    owner: 'releases',
    actorScope: state.actorScope,
    serviceIdentity: state.serviceIdentity,
    workspaceId: state.workspaceId,
    bundleId: state.bundleId,
    channel: state.channel,
  };
  const [operation, setOperation] = useState<PendingOperation | null>(null);
  const related = useRelatedPending(recoveryScope, operation);
  useEffect(() => {
    try {
      setOperation(loadPending(sessionStorage, recoveryScope));
    } catch {
      setError('Recovery storage unavailable. Enable session storage before restoring.');
    }
  }, [state.actorScope, state.serviceIdentity, state.workspaceId, state.bundleId, state.channel]);

  async function loadMore() {
    if (!page.nextBeforeRevision || loading) return;
    setLoading(true);
    setError('');
    try {
      const result = await readReleaseHistory({
        data: { beforeRevision: page.nextBeforeRevision, scope },
      });
      if (!result.ok) setError(result.message);
      else
        setPage((previous) => ({
          items: [
            ...previous.items,
            ...result.page.items.filter(
              (item) => !previous.items.some((existing) => existing.id === item.id),
            ),
          ],
          nextBeforeRevision: result.page.nextBeforeRevision,
        }));
    } catch {
      setError('Could not read release history. Check the connection and retry.');
    } finally {
      setLoading(false);
    }
  }

  async function reconcile(close = false) {
    if (!operation) return;
    setSubmitting(true);
    setError('');
    setStatus('');
    try {
      const result = await reconcileReleaseOperation({
        data: { scope, key: operation.key, close },
      });
      if (!result.ok) setError(result.message);
      else if (result.operation.status !== 'not_observed') {
        resolvePending(sessionStorage, recoveryScope);
        setOperation(null);
        setTarget(null);
        setReason('');
        setStatus(
          result.operation.status === 'committed'
            ? 'Restore confirmed.'
            : 'Operation closed. Review a new restore request.',
        );
        if (result.operation.status === 'committed') toast.success('Restore confirmed.');
        else toast.success('Operation closed. Review a new restore request.');
        await router.invalidate().catch(() => {
          setError(
            'The operation is confirmed, but release history could not refresh. Reload this page.',
          );
        });
      } else
        setError(
          'No result observed. Execution remains uncertain. Check again or review recovery details.',
        );
    } catch {
      setError('Recovery outcome unknown. Keep this operation pending.');
    } finally {
      setSubmitting(false);
    }
  }
  async function restore() {
    if (related.blocked) return;
    if (!state.canEdit || submitting || (!operation && (!target || staleReview || !reason.trim())))
      return;
    setSubmitting(true);
    setError('');
    setStatus('');
    try {
      let frozen = operation ? loadPending(sessionStorage, recoveryScope) : null;
      const replayingUncertain = Boolean(operation) || related.blocked;
      if (operation && !frozen?.body) {
        setOperation(frozen || { ...operation, body: undefined });
        setError('Submitted text was forgotten or expired. Reconcile or close this operation.');
        return;
      }
      if (!frozen) {
        const wire = restoreRequest(
          { versionId: target!.versionId, expectedRevision: target!.reviewedRevision, reason },
          scope,
        );
        frozen = freezePending(
          sessionStorage,
          recoveryScope,
          wire.operationPath,
          JSON.parse(wire.body),
        );
        setOperation(frozen);
      }
      if (!frozen.body) {
        setError(
          'Submitted text is unavailable. Reconcile or close this operation before a new restore.',
        );
        return;
      }
      const result = await runReleaseOperation({
        data: { scope, key: frozen.key, body: frozen.body },
      });
      if (!result.ok) {
        setError(result.message);
        if (!replayingUncertain && !result.uncertain) {
          resolvePending(sessionStorage, recoveryScope);
          setOperation(null);
          if ('revisionChanged' in result && result.revisionChanged) setStaleReview(result.message);
        }
      } else {
        toast.success(`Restored as revision ${result.promotion.revision}`);
        setStatus(`Restored as revision ${result.promotion.revision}.`);
        resolvePending(sessionStorage, recoveryScope);
        setOperation(null);
        setTarget(null);
        setReason('');
        await router.invalidate().catch(() => {
          setError('Restore confirmed, but release history could not refresh. Reload this page.');
        });
      }
    } catch {
      // A failed text-storage write can still leave unresolved metadata. Keep it visible.
      try {
        setOperation(loadPending(sessionStorage, recoveryScope));
      } catch {
        // The storage error remains visible and no new request can bypass freezing.
      }
      setError(
        'The restore could not be confirmed. Resolve this operation before another restore.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function reviewCurrentRelease() {
    setSubmitting(true);
    try {
      await router.navigate({
        ...consoleDestination(bundleHref(scope, 'releases')),
        replace: true,
        resetScroll: false,
      });
      await router.invalidate();
    } catch {
      setError('Could not load the current release. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const recovery = operation && (
    <section
      aria-label="Unresolved restore"
      className="rounded-md border border-amber-500/50 bg-amber-500/5 p-4 space-y-3"
    >
      <h2 className="text-sm font-semibold" role="status">
        {submitting ? 'Waiting for restore confirmation…' : 'Restore needs confirmation'}
      </h2>
      <p className="text-sm text-muted-foreground">
        Check the result before restoring again. An unconfirmed result does not mean the restore
        failed.
      </p>
      <Button disabled={submitting} onClick={() => void reconcile()}>
        Check result
      </Button>
      <Disclosure className="text-sm">
        <DisclosureTrigger className="cursor-pointer font-medium">
          Recovery details
        </DisclosureTrigger>
        <DisclosureContent>
          <div className="mt-3 space-y-3">
            <p className="break-all">Operation {operation.key}</p>
            <CopyButton value={operation.key} label="Copy operation ID" />
            {operation.body ? (
              <>
                <p>
                  Retry sends exactly the stored request with the same operation ID. It does not
                  include edits to the reason.
                </p>
                <Button
                  disabled={submitting || !state.canEdit}
                  variant="outline"
                  onClick={() => void restore()}
                >
                  Retry exact restore
                </Button>
                <SyntaxCode
                  code={operation.body}
                  language="json"
                  tabIndex={0}
                  aria-label="Frozen restore request"
                  className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3"
                />
                <CopyButton value={operation.body} label="Copy frozen request" />
              </>
            ) : (
              <p>
                Submitted text is unavailable. Exact retry is unavailable; check the result or close
                this operation.
              </p>
            )}
            <p>
              Closing records a closed operation after checking its result. Review a new restore
              request only after closure is confirmed.
            </p>
            <Button disabled={submitting} variant="outline" onClick={() => void reconcile(true)}>
              Close unresolved restore
            </Button>
            {operation.body && (
              <>
                <p>
                  Forgetting text removes the stored payload and exact retry. It does not cancel the
                  restore or clear uncertainty.
                </p>
                <Button
                  disabled={submitting}
                  variant="outline"
                  onClick={() => {
                    try {
                      setOperation(forgetPending(sessionStorage, recoveryScope));
                    } catch {
                      setError(
                        'Submitted text could not be forgotten. The restore remains unresolved.',
                      );
                    }
                  }}
                >
                  Forget submitted text
                </Button>
              </>
            )}
          </div>
        </DisclosureContent>
      </Disclosure>
    </section>
  );

  return (
    <div className="bundle-releases release-page-layout space-y-4">
      <RelatedPendingNotice recovery={related} scope={scope} canEdit={state.canEdit} />
      {!target && recovery}
      {status && (
        <p role="status" className="text-sm">
          {status}
        </p>
      )}
      <section className="release-history release-history-layout">
        <div className="release-history-header">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Release history</h2>
            {!state.canEdit && <span className="text-sm text-muted-foreground">Read only</span>}
          </div>
        </div>
        {loadedItems.length ? (
          <div className="release-workbench">
            <div className="release-picker" aria-label="Release revisions">
              <div className="release-picker-search">
                <div className="grid w-full max-w-sm gap-1.5">
                  <Label htmlFor="release-search">Find a release</Label>
                  <Input
                    id="release-search"
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Revision, version ID, or digest"
                  />
                </div>
                {term && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setQuery('');
                      searchRef.current?.focus();
                    }}
                  >
                    Clear search
                  </Button>
                )}
                <span role="status" className="pb-1 text-xs text-muted-foreground">
                  {term
                    ? `${matches.length} of ${loadedItems.length} loaded releases`
                    : `${loadedItems.length} loaded ${loadedItems.length === 1 ? 'release' : 'releases'}`}
                </span>
              </div>

              <div className="release-picker-scroll">
                {matches.map((item) => (
                  <article
                    data-testid="release-decision"
                    key={item.id}
                    id={`revision-${item.revision}`}
                    tabIndex={-1}
                    aria-label={`Revision ${item.revision}${item.revision === state.resolution.revision ? ' · Current' : ''}`}
                  >
                    <button
                      type="button"
                      className="release-picker-option"
                      disabled={!hydrated}
                      aria-pressed={selected?.id === item.id}
                      onClick={() => chooseRevision(item.revision)}
                    >
                      {item.revision === state.resolution.revision ? (
                        <CircleCheck aria-hidden="true" />
                      ) : (
                        <GitCommitHorizontal aria-hidden="true" />
                      )}
                      <strong>
                        <span className="sr-only">Compare </span>Revision {item.revision}
                      </strong>
                      {item.revision === state.resolution.revision && <Badge>Current</Badge>}
                      {showLinked && linkedRelease?.id === item.id && (
                        <Badge variant="outline">Linked revision</Badge>
                      )}
                      <ReceiptTime value={item.createdAt} />
                      <code>{item.version.id.slice(0, 8)}</code>
                    </button>
                  </article>
                ))}
              </div>
            </div>
            {selected ? (
              <ReleaseComparison
                key={selected.id}
                scope={scope}
                release={selected}
                current={selected.revision === state.resolution.revision}
                actions={
                  <>
                    {selected.version.parentVersionId && (
                      <ConsoleLink
                        className="release-comparison-link"
                        href={bundleHref(scope, 'changes', {
                          history: 1,
                          fromRevision: selected.revision,
                          candidate: selected.version.id,
                          tab: 'files',
                        })}
                        aria-label={`Compare with creation base for revision ${selected.revision}`}
                      >
                        Compare with creation base
                      </ConsoleLink>
                    )}
                    <div className="release-actions">
                      <div className="release-inspection-actions">
                        <VersionInspector
                          scope={scope}
                          versionId={selected.version.id}
                          label="Inspect content"
                          contextLabel={`revision ${selected.revision}`}
                        />
                        <ChangeRecordDetails
                          title="Release details"
                          triggerLabel={`Release details for revision ${selected.revision}`}
                          description="The saved content, release decision and recorded evidence."
                          copyLabel="Copy release details"
                          value={JSON.stringify(selected, null, 2)}
                          fields={[
                            ['Revision', selected.revision],
                            ['Published', <ReceiptTime value={selected.createdAt} />],
                            ['Reviewer', selected.reviewer],
                            [
                              'Reason',
                              selected.policyOverride?.reason ||
                                selected.unevaluatedReason ||
                                (selected.comparisonId
                                  ? 'Recorded evaluation evidence.'
                                  : 'No release reason recorded.'),
                            ],
                            ...(selected.policyOverride?.receipts.map(
                              (receipt): [string, string] => [
                                'Overridden policy',
                                receipt.policyDigest + ' · comparison ' + receipt.comparisonId,
                              ],
                            ) ?? []),
                            ['Release ID', selected.id],
                            ['Version', selected.version.id],
                            ['Digest', selected.version.digest],
                            ['Previous version', selected.previousVersionId || 'None'],
                            ...(selected.comparisonId
                              ? [['Comparison', selected.comparisonId] as [string, string]]
                              : []),
                          ]}
                        />
                      </div>
                      {selected.comparisonId && (
                        <Button asChild variant="outline">
                          <ConsoleLink
                            aria-label={`Inspect evidence for revision ${selected.revision}`}
                            href={bundleHref(scope, 'changes', {
                              candidate: selected.version.id,
                              comparison: selected.comparisonId,
                              fromRevision: selected.revision,
                            })}
                          >
                            Inspect evidence
                          </ConsoleLink>
                        </Button>
                      )}
                      {state.canEdit && selected.version.id !== state.resolution.version.id && (
                        <Button
                          variant="outline"
                          aria-label={`Restore revision ${selected.revision}`}
                          disabled={!hydrated || Boolean(operation) || related.blocked}
                          onClick={(event) => {
                            restoreReturnRef.current = event.currentTarget;
                            setError('');
                            setStatus('');
                            setReason('');
                            setTarget({
                              sourceRevision: selected.revision,
                              versionId: selected.version.id,
                              reviewedRevision: state.resolution.revision,
                            });
                          }}
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  </>
                }
              />
            ) : !matches.length ? (
              <p className="p-4 text-sm text-muted-foreground">
                No loaded releases match your search.
              </p>
            ) : (
              <div className="space-y-3 p-4">
                <p role="status">
                  {page.nextBeforeRevision &&
                  requestedRevision &&
                  BigInt(requestedRevision) < BigInt(page.nextBeforeRevision) &&
                  !error
                    ? 'Loading linked revision…'
                    : 'This revision is unavailable in the channel history.'}
                </p>
                <Button variant="outline" onClick={() => chooseRevision(state.resolution.revision)}>
                  Show current revision
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="px-4 py-5 text-sm text-muted-foreground">
            {term ? 'No loaded releases match your search.' : 'No release decisions yet.'}
          </p>
        )}
        {page.nextBeforeRevision && (
          <div className="border-t px-4 py-3">
            <Button
              variant="outline"
              disabled={!hydrated || loading}
              onClick={() => void loadMore()}
            >
              {loading ? 'Loading…' : 'Load older releases'}
            </Button>
          </div>
        )}
      </section>
      {!target && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !submitting) {
            setTarget(null);
            setError('');
          }
        }}
      >
        <DialogContent
          size="decision"
          returnFocusRef={restoreReturnRef}
          className="max-h-[90dvh] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>Restore revision {target?.sourceRevision}?</DialogTitle>
            <DialogDescription>
              Replace the current {state.channel} release (revision {target?.reviewedRevision})
              with this content version. This creates a new manual revision and retains the existing
              history, without inheriting evaluation support.
            </DialogDescription>
          </DialogHeader>
          <dl className="release-restore-summary">
            <div>
              <dt>Bundle</dt>
              <dd>{state.bundleName || state.bundleId}</dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>{state.channel}</dd>
            </div>
            <div>
              <dt>Current revision</dt>
              <dd>{target?.reviewedRevision}</dd>
            </div>
            <div>
              <dt>Restore content from</dt>
              <dd>Revision {target?.sourceRevision}</dd>
            </div>
          </dl>
          <Disclosure className="text-sm text-muted-foreground">
            <DisclosureTrigger className="cursor-pointer">
              Selected version details
            </DisclosureTrigger>
            <DisclosureContent>
              <p className="break-all">Version: {target?.versionId}</p>
              <p>Compatibility target: {state.compatibilityTarget}</p>
            </DisclosureContent>
          </Disclosure>
          {recovery}
          <div className="space-y-2">
            <Label htmlFor="restore-reason" className="text-sm">
              Reason for restoring
            </Label>
            <Textarea
              disabled={submitting || Boolean(staleReview) || Boolean(operation) || related.blocked}
              id="restore-reason"
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain why this version is being restored"
              className="text-sm"
            />
          </div>
          {(error || staleReview) && (
            <p role="alert" className="text-sm text-destructive">
              {error || staleReview}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={submitting} onClick={() => setTarget(null)}>
              {operation ? 'Close dialog' : 'Cancel'}
            </Button>
            {staleReview ? (
              <Button disabled={submitting} onClick={() => void reviewCurrentRelease()}>
                {submitting ? 'Loading current release…' : 'Review current release'}
              </Button>
            ) : (
              <Button
                disabled={
                  !state.canEdit ||
                  !reason.trim() ||
                  submitting ||
                  Boolean(operation) ||
                  related.blocked
                }
                onClick={() => void restore()}
              >
                {submitting ? 'Restoring…' : 'Restore version'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
