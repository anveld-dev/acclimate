import { AcclimateUsageError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type { Selection } from './cache.js';
import type { VerifiedVersion } from './types.js';
import type { AcclimateClient } from './client.js';
import type { DeliveryReceiptRequest } from './types.js';

export interface DeliveryObservation {
  selection: Selection;
  version: VerifiedVersion;
  source: DeliveryReceiptRequest['source'];
  downloaded: boolean;
}
export interface DeliveryObserver {
  observeDelivery(observation: DeliveryObservation): void | Promise<void>;
}
export interface ReceiptReporterOptions {
  client: AcclimateClient;
  workspaceId: string;
  connectionId: string;
  maxPending?: number;
  now?: () => number;
}

/** Explicit, opt-in, memory-only reporting. Failure never changes content delivery. */
export function createReceiptReporter(options: ReceiptReporterOptions) {
  const maxPending = options.maxPending ?? 100;
  if (!Number.isInteger(maxPending) || maxPending < 1 || maxPending > 1000)
    throw new AcclimateUsageError('maxPending must be an integer between 1 and 1000', 'maxPending');
  const now = options.now ?? Date.now;
  const pending = new Map<string, { receipt: DeliveryReceiptRequest; queuedAt: number }>();
  let running: Promise<void> | undefined;
  let closed = false;
  const bindings = new WeakMap<
    VerifiedVersion,
    Omit<DeliveryReceiptRequest, 'eventId' | 'stage' | 'occurredAt'>
  >();
  function createStageReceipt(
    verified: VerifiedVersion,
    stage: DeliveryReceiptRequest['stage'],
  ): Readonly<DeliveryReceiptRequest> {
    const binding = bindings.get(verified);
    if (!binding) throw new AcclimateUsageError('Version has not been observed by this reporter', 'version');
    return Object.freeze({
      ...binding,
      eventId: randomUUID(),
      stage,
      occurredAt: new Date(now()).toISOString(),
    });
  }
  function queueReceipt(receipt: Readonly<DeliveryReceiptRequest>) {
    const accepted = enqueue(receipt);
    void flush();
    return accepted ? receipt : null;
  }
  function reportStage(verified: VerifiedVersion, stage: DeliveryReceiptRequest['stage']) {
    return queueReceipt(createStageReceipt(verified, stage));
  }
  function observeDelivery({ selection, version: verified, source, downloaded }: DeliveryObservation): void {
    if (
      selection.workspaceId !== options.workspaceId ||
      verified.version.bundleId !== selection.bundleId ||
      (verified.connection &&
        (verified.connection.workspaceId !== options.workspaceId ||
          verified.connection.connectionId.toLowerCase() !== options.connectionId.toLowerCase()))
    )
      throw new AcclimateUsageError('Delivery scope must match reporter scope', 'scope');
    const binding: Omit<DeliveryReceiptRequest, 'eventId' | 'stage' | 'occurredAt'> = {
      connectionId: options.connectionId,
      workspaceId: selection.workspaceId,
      bundleId: selection.bundleId,
      versionId: verified.version.id,
      digest: verified.version.digest,
      source,
      ...(verified.resolution
        ? {
            channel: verified.resolution.channel,
            revision: verified.resolution.revision,
            resolvedAt: new Date(verified.resolvedAt).toISOString(),
            stale: verified.stale,
          }
        : {}),
    };
    bindings.set(verified, binding);
    if (verified.resolution) reportStage(verified, 'resolved');
    if (downloaded) {
      // This stage reports network bytes even when an older mapping was permitted offline.
      const original = binding.source;
      binding.source = 'network';
      reportStage(verified, 'downloaded');
      binding.source = original;
    }
    reportStage(verified, 'verified');
  }
  function enqueue(receipt: DeliveryReceiptRequest): boolean {
    if (closed) return false;
    if (receipt.workspaceId !== options.workspaceId || receipt.connectionId !== options.connectionId)
      throw new AcclimateUsageError('Receipt scope must match reporter scope', 'scope');
    if (pending.has(receipt.eventId)) return false;
    if (pending.size >= maxPending) return false;
    pending.set(receipt.eventId, { receipt: structuredClone(receipt), queuedAt: now() });
    return true;
  }
  function flush(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      // Assign running before even an empty pass completes. Clear it in the same
      // continuation as the final iterator check, so fresh arrivals cannot attach
      // to a finished pass during a later .finally microtask.
      await Promise.resolve();
      try {
        for (const [id, item] of pending) {
          if (closed) break;
          if (now() - item.queuedAt >= 24 * 60 * 60 * 1000) {
            pending.delete(id);
            continue;
          }
          try {
            await options.client.reportDeliveryReceipt(
              options.workspaceId,
              options.connectionId,
              item.receipt,
              id,
            );
            pending.delete(id);
          } catch {
            // Keep the exact event and key for the next explicit flush.
          }
        }
      } finally {
        running = undefined;
      }
    })();
    return running;
  }
  return {
    enqueue,
    flush,
    observeDelivery,
    reportPrepared: (verified: VerifiedVersion) => reportStage(verified, 'prepared') !== null,
    reportStarted: (verified: VerifiedVersion) => reportStage(verified, 'started') !== null,
    /** Bind a single job's first observed start time and event ID across queue refusals. */
    bindStartedReceipt(verified: VerifiedVersion) {
      const receipt = createStageReceipt(verified, 'started');
      let queued: Readonly<DeliveryReceiptRequest> | null = null;
      return () => (queued ??= queueReceipt(receipt));
    },
    /** Queue a started receipt and return its exact body for a durable job handoff. */
    reportStartedReceipt: (verified: VerifiedVersion) => reportStage(verified, 'started'),
    /** Stop claiming events. An already in-flight request may still finish. */
    close() {
      closed = true;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}
