import { AcclimateUsageError } from './errors.js';
import { randomUUID } from 'node:crypto';
import type { Selection } from './cache.js';
import type { VerifiedVersion } from './types.js';
import type { AcclimateClient } from './client.js';
import type { DeliveryReceiptRequest } from './types.js';

export interface DeliveryObservation {
  selection: Selection;
  bundle: VerifiedVersion;
  source: DeliveryReceiptRequest['source'];
  downloaded: boolean;
}
export interface DeliveryObserver {
  observeDelivery(observation: DeliveryObservation): void | Promise<void>;
}
export interface ReceiptReporterOptions {
  client: AcclimateClient;
  projectId: string;
  integrationId: string;
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
    bundle: VerifiedVersion,
    stage: DeliveryReceiptRequest['stage'],
  ): Readonly<DeliveryReceiptRequest> {
    const binding = bindings.get(bundle);
    if (!binding) throw new AcclimateUsageError('Bundle has not been observed by this reporter', 'bundle');
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
  function reportStage(bundle: VerifiedVersion, stage: DeliveryReceiptRequest['stage']) {
    return queueReceipt(createStageReceipt(bundle, stage));
  }
  function observeDelivery({ selection, bundle, source, downloaded }: DeliveryObservation): void {
    if (
      selection.projectId !== options.projectId ||
      bundle.version.bundleId !== selection.bundleId ||
      (bundle.connection &&
        (bundle.connection.projectId !== options.projectId ||
          bundle.connection.integrationId.toLowerCase() !== options.integrationId.toLowerCase()))
    )
      throw new AcclimateUsageError('Delivery scope must match reporter scope', 'scope');
    const binding: Omit<DeliveryReceiptRequest, 'eventId' | 'stage' | 'occurredAt'> = {
      integrationId: options.integrationId,
      projectId: selection.projectId,
      bundleId: selection.bundleId,
      versionId: bundle.version.id,
      digest: bundle.version.digest,
      source,
      ...(bundle.resolution
        ? {
            channel: bundle.resolution.channel,
            revision: bundle.resolution.revision,
            resolvedAt: new Date(bundle.resolvedAt).toISOString(),
            stale: bundle.stale,
          }
        : {}),
    };
    bindings.set(bundle, binding);
    if (bundle.resolution) reportStage(bundle, 'resolved');
    if (downloaded) {
      // This stage reports network bytes even when an older mapping was permitted offline.
      const original = binding.source;
      binding.source = 'network';
      reportStage(bundle, 'downloaded');
      binding.source = original;
    }
    reportStage(bundle, 'verified');
  }
  function enqueue(receipt: DeliveryReceiptRequest): boolean {
    if (closed) return false;
    if (receipt.projectId !== options.projectId || receipt.integrationId !== options.integrationId)
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
              options.projectId,
              options.integrationId,
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
    reportPrepared: (bundle: VerifiedVersion) => reportStage(bundle, 'prepared') !== null,
    reportStarted: (bundle: VerifiedVersion) => reportStage(bundle, 'started') !== null,
    /** Bind a single job's first observed start time and event ID across queue refusals. */
    bindStartedReceipt(bundle: VerifiedVersion) {
      const receipt = createStageReceipt(bundle, 'started');
      let queued: Readonly<DeliveryReceiptRequest> | null = null;
      return () => (queued ??= queueReceipt(receipt));
    },
    /** Queue a started receipt and return its exact body for a durable job handoff. */
    reportStartedReceipt: (bundle: VerifiedVersion) => reportStage(bundle, 'started'),
    /** Stop claiming events. An already in-flight request may still finish. */
    close() {
      closed = true;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}
