import { useState } from 'react';
import type { DeliveryReceipt, Page } from '@acclimate/sdk';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ConsoleLink } from './console-link';

export function ConnectionReports({
  receipts,
  channel,
  currentRevision,
  currentVersionId,
  setupHref,
  busy,
  onLoadOlder,
}: {
  receipts: Page<DeliveryReceipt>;
  channel: string;
  currentRevision: string;
  currentVersionId: string;
  setupHref: string;
  busy: boolean;
  onLoadOlder(): void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? receipts.items : receipts.items.slice(0, 3);
  return (
    <section
      id="delivery-reports"
      className="workspace-panel connection-reports-panel space-y-4 p-4"
      aria-label="App-reported delivery"
    >
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">App-reported delivery</h2>
          <Badge variant="outline">{receipts.items.length} reports loaded</Badge>
        </div>
        <p className="mt-1 break-all text-sm text-muted-foreground">
          Bundle channel {channel}: revision {currentRevision} · version {currentVersionId}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Each row is an independent observation, ordered by service receipt time. History lasts 30
        days. It does not establish a completed delivery chain or model consumption.
      </p>
      {!receipts.items.length ? (
        <p className="rounded bg-muted/50 p-4">
          No delivery report received; status unknown.{' '}
          <ConsoleLink href={`${setupHref}#reporting`} className="underline">
            Set up reporting
          </ConsoleLink>
        </p>
      ) : (
        <div className="connection-report-list">
          <div className="connection-report-columns" aria-hidden="true">
            <span>App report/source</span>
            <span>Service received</span>
            <span>Version</span>
          </div>
          {visible.map((receipt) => (
            <ReceiptFact key={receipt.eventId} receipt={receipt} />
          ))}
        </div>
      )}
      {receipts.items.length > 3 && (
        <Button variant="outline" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show latest 3 reports' : `Show all ${receipts.items.length} loaded reports`}
        </Button>
      )}
      {receipts.nextCursor && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setShowAll(true);
            onLoadOlder();
          }}
        >
          Load older reports
        </Button>
      )}
    </section>
  );
}

function ReceiptFact({ receipt: r }: { receipt: DeliveryReceipt }) {
  const stage =
    r.stage === 'started' ? 'App reported a session or turn started' : `App reported ${r.stage}`;
  const received = new Date(r.receivedAt).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return (
    <article className="connection-report-row" data-testid="delivery-report">
      <Disclosure>
        <DisclosureTrigger className="connection-report-trigger">
          <span className="connection-report-summary">
            <span className="connection-report-stage">
              <span className="font-medium">{stage}</span>
              <Badge variant="outline">{r.source}</Badge>
              {r.stale && <Badge variant="secondary">Stale mapping</Badge>}
              {r.delayed && <Badge variant="secondary">Delayed report</Badge>}
            </span>
            <span className="connection-report-received text-muted-foreground">
              <time dateTime={r.receivedAt} title={r.receivedAt}>
                {received}
              </time>
            </span>
            <span className="connection-report-version font-mono break-all">
              Version {r.versionId.slice(0, 8)}
            </span>
          </span>
          <span className="sr-only">
            Received {r.receivedAt}. Event {r.eventId}.
          </span>
        </DisclosureTrigger>
        <DisclosureContent className="connection-report-details">
          <dl>
            <div>
              <dt>Event ID</dt>
              <dd>{r.eventId}</dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{r.versionId}</dd>
            </div>
            <div>
              <dt>Digest</dt>
              <dd>{r.digest}</dd>
            </div>
            <div>
              <dt>App-reported occurrence</dt>
              <dd>
                <time dateTime={r.occurredAt}>{r.occurredAt}</time>
              </dd>
            </div>
            <div>
              <dt>Service received</dt>
              <dd>
                <time dateTime={r.receivedAt}>{r.receivedAt}</time>
              </dd>
            </div>
            <div>
              <dt>Mapping</dt>
              <dd>
                {r.channel
                  ? `${r.channel} · revision ${r.revision ?? 'not reported'} · ${r.stale === true ? 'stale' : r.stale === false ? 'fresh' : 'freshness not reported'}`
                  : 'Explicit pinned version'}
              </dd>
            </div>
            {r.resolvedAt && (
              <div>
                <dt>App-reported resolution</dt>
                <dd>
                  <time dateTime={r.resolvedAt}>{r.resolvedAt}</time>
                </dd>
              </div>
            )}
          </dl>
        </DisclosureContent>
      </Disclosure>
    </article>
  );
}
