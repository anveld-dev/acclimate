import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  findRelatedPending,
  loadPending,
  resolvePending,
  type PendingOperation,
  type PendingScope,
} from '../lib/pending-operation';
import type { BundleScope } from '../server/selection';
import { runDraftCommand } from '../server/content-actions';
import { Button } from './ui/button';
import { CopyButton } from './copy-button';

export function useRelatedPending(scope: PendingScope, ownerPending: unknown) {
  const [record, setRecord] = useState<PendingOperation | null>(null);
  const [error, setError] = useState('');
  const identity = JSON.stringify(scope);
  const refresh = useCallback(() => {
    try {
      setRecord(findRelatedPending(sessionStorage, JSON.parse(identity)));
      setError('');
    } catch {
      setError('Recovery storage is unavailable. No new submission can start.');
    }
  }, [identity]);
  useEffect(refresh, [refresh, ownerPending]);
  return { record, error, refresh, blocked: Boolean(record || error) };
}

/** Recover foreign UI envelopes through their original route and storage key. */
export function RelatedPendingNotice({
  recovery,
  scope,
  canEdit,
}: {
  recovery: ReturnType<typeof useRelatedPending>;
  scope: BundleScope;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const record = recovery.record;
  if (recovery.error) return <p role="alert">{recovery.error}</p>;
  if (!record) return null;
  async function reconcile(close: boolean) {
    if (!record || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const current = loadPending(sessionStorage, record.scope);
      if (!current || current.key !== record.key || current.action !== record.action)
        throw Error('The recovery record changed. Refresh before checking again.');
      const result = await runDraftCommand({
        data: {
          scope,
          action: close ? 'close' : 'recover',
          key: record.key,
          operationPath: record.action,
        },
      });
      if (!result.ok) throw Error(result.message);
      if (
        !('operation' in result) ||
        !result.operation ||
        result.operation.status === 'not_observed'
      ) {
        setMessage(
          'No result observed. This submission may still commit. Keep it pending or close it.',
        );
        return;
      }
      resolvePending(sessionStorage, record.scope);
      toast.success(
        result.operation.status === 'committed'
          ? 'Earlier submission confirmed.'
          : 'Earlier submission closed.',
      );
      recovery.refresh();
      await router
        .invalidate()
        .catch(() => toast.error('Result confirmed. Refresh the page to update its data.'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Recovery remains uncertain.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Pending submission from another page"
      className="space-y-3 rounded-md border border-amber-500/50 bg-amber-500/5 p-4 text-sm"
    >
      <h2 className="font-semibold">An earlier submission needs confirmation</h2>
      <p className="text-muted-foreground">
        A submission from another page in this bundle and channel is unresolved. Check its result to
        continue.
      </p>
      <Button type="button" disabled={busy} onClick={() => void reconcile(false)}>
        Check result
      </Button>
      {message && <p role="status">{message}</p>}
      <Disclosure>
        <DisclosureTrigger className="cursor-pointer">Recovery details</DisclosureTrigger>
        <DisclosureContent>
          <div className="space-y-2 pt-2">
            <p className="select-text break-all">Operation: {record.key}</p>
            <p className="select-text break-all">{record.action}</p>
            <CopyButton value={record.key} label="Copy operation ID" />
            <p>
              Close preserves a known commit; otherwise it blocks delayed writes for this operation.
              It does not undo a saved change.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !canEdit}
              onClick={() => void reconcile(true)}
            >
              Close unresolved operation
            </Button>
          </div>
        </DisclosureContent>
      </Disclosure>
    </section>
  );
}
