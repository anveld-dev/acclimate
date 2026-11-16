import { useRouter } from '@tanstack/react-router';
import { RelatedPendingNotice, useRelatedPending } from './related-pending';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { VersionInspector } from './version-inspector';
import { ConsoleLink } from './console-link';
import { CopyButton } from './copy-button';
import { bundleHref } from '../navigation';
import {
  freezePending,
  loadPending,
  resolvePending,
  forgetPending,
  type PendingScope,
  type PendingOperation,
} from '../lib/pending-operation';
import { restoreRequest } from '../lib/content-operation';
import {
  readReleaseHistory,
  runReleaseOperation,
  reconcileReleaseOperation,
} from '../server/read-console';
import type { ConsoleState } from '../server/channel';

export function BundleReleases({ state }: { state: Extract<ConsoleState, { status: 'ready' }> }) {
  const router = useRouter();
  const scope = { projectId: state.projectId, bundleId: state.bundleId, channel: state.channel };
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [page, setPage] = useState(state.history);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [target, setTarget] = useState<(typeof page.items)[number] | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const recoveryScope: PendingScope = {
    actorScope: state.actorScope,
    serviceIdentity: state.serviceIdentity,
    projectId: state.projectId,
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
  }, [state.actorScope, state.serviceIdentity, state.projectId, state.bundleId, state.channel]);

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
    if (!state.canEdit || submitting || (!operation && (!target || !reason.trim()))) return;
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
          { versionId: target!.version.id, expectedRevision: state.resolution.revision, reason },
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
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Recovery details</summary>
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
              <pre
                tabIndex={0}
                aria-label="Frozen restore request"
                className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3"
              >
                {operation.body}
              </pre>
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
      </details>
    </section>
  );

  return (
    <div className="space-y-4">
      <RelatedPendingNotice recovery={related} scope={scope} canEdit={state.canEdit} />
      {!target && recovery}
      {status && (
        <p role="status" className="text-sm">
          {status}
        </p>
      )}
      <section className="workspace-panel">
        <div className="border-b px-4 py-4 sm:px-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">Release history</h2>
            <Badge variant="outline">
              {state.channel} · current revision {state.resolution.revision}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Inspect past releases or restore an earlier version as a new release.
          </p>
        </div>
        {page.items.length ? (
          <div className="divide-y">
            {page.items.map((item) => (
              <article
                data-testid="release-decision"
                key={item.id}
                className="flex flex-col gap-4 px-4 py-3 sm:px-4 md:flex-row md:items-start md:justify-between"
              >
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">Revision {item.revision}</h3>
                    {item.revision === state.resolution.revision && <Badge>Current</Badge>}
                    <Badge variant="outline">
                      {item.comparisonId ? 'Evaluation recorded' : 'Manual release'}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <time dateTime={item.createdAt}>
                      {new Date(item.createdAt).toISOString().replace('T', ' ').slice(0, 19)} UTC
                    </time>
                  </p>
                  <p className="break-words text-sm">
                    {item.unevaluatedReason ?? 'Released with recorded comparison evidence.'}
                  </p>
                  <details className="text-sm">
                    <summary className="cursor-pointer text-muted-foreground">Details</summary>
                    <dl className="mt-2 space-y-2 break-all">
                      <div>
                        <dt className="text-muted-foreground">Reviewer</dt>
                        <dd>{item.reviewer}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Evaluation</dt>
                        <dd>
                          {item.comparisonId
                            ? 'Recorded comparison evidence'
                            : 'No evaluation supports this release.'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Release ID</dt>
                        <dd>{item.id}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Version</dt>
                        <dd>{item.version.id}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Digest</dt>
                        <dd>{item.version.digest}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Previous version</dt>
                        <dd>{item.previousVersionId ?? 'None'}</dd>
                      </div>
                      {item.comparisonId && (
                        <div>
                          <dt className="text-muted-foreground">Comparison</dt>
                          <dd>{item.comparisonId}</dd>
                        </div>
                      )}
                    </dl>
                    <CopyButton
                      className="mt-2"
                      value={JSON.stringify(item, null, 2)}
                      label="Copy release details"
                    />
                  </details>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <VersionInspector scope={scope} versionId={item.version.id} />
                  {item.comparisonId && (
                    <Button asChild variant="outline">
                      <ConsoleLink
                        href={bundleHref(scope, 'changes', {
                          candidate: item.version.id,
                          comparison: item.comparisonId,
                        })}
                      >
                        Inspect evidence
                      </ConsoleLink>
                    </Button>
                  )}
                  {state.canEdit && item.version.id !== state.resolution.version.id && (
                    <Button
                      variant="outline"
                      disabled={!hydrated || Boolean(operation) || related.blocked}
                      onClick={() => {
                        setError('');
                        setStatus('');
                        setReason('');
                        setTarget(item);
                      }}
                    >
                      Restore
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="px-4 py-5 text-sm text-muted-foreground">No release decisions yet.</p>
        )}
        {page.nextBeforeRevision && (
          <div className="border-t px-4 py-4 sm:px-4">
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
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Restore revision {target?.revision}?</DialogTitle>
            <DialogDescription>
              Replace the current {state.channel} release (revision {state.resolution.revision})
              with this version. A new release records your reason without claiming evaluation
              support.
            </DialogDescription>
          </DialogHeader>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">Selected version details</summary>
            <p className="mt-2 break-all">Version: {target?.version.id}</p>
            <p>Compatibility target: {state.compatibilityTarget}</p>
          </details>
          {recovery}
          <div className="space-y-2">
            <Label htmlFor="restore-reason" className="text-sm">
              Reason for restoring
            </Label>
            <Textarea
              disabled={submitting || Boolean(operation) || related.blocked}
              id="restore-reason"
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain why this version is being restored"
              className="text-sm"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={submitting} onClick={() => setTarget(null)}>
              {operation ? 'Close dialog' : 'Cancel'}
            </Button>
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
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
