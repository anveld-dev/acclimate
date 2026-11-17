import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { PageTitle } from './shared';
import { readDeliveryObservations } from '../server/delivery-observations-actions';
import type { DeliveryObservationsResult } from '../server/delivery-observations-core';

export function WorkspaceDelivery({
  projectId,
  initial,
}: {
  projectId: string;
  initial: DeliveryObservationsResult;
}) {
  const [result, setResult] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setResult(initial);
    setError('');
  }, [initial, projectId]);
  async function load(cursor?: string) {
    setBusy(true);
    setError('');
    try {
      const next = await readDeliveryObservations({ data: { projectId, cursor } });
      if (!next.ok) {
        setError(next.message);
        return;
      }
      setResult((previous) => {
        if (!cursor || !previous.ok || previous.projectId !== next.projectId) return next;
        const items = new Map(previous.page.items.map((item) => [item.id, item]));
        for (const item of next.page.items) items.set(item.id, item);
        return { ...next, page: { ...next.page, items: [...items.values()] } };
      });
    } catch {
      setError('Delivery observations could not be refreshed. Current delivery is unknown.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-delivery space-y-4">
      <PageTitle
        title="Delivery"
        description="App-reported observations of published content, available to workspace readers."
      />
      <div className="workspace-panel space-y-3 p-4">
        <p>
          These observations do not prove model consumption, skill invocation, evaluator progress,
          or agent quality. No observation means unknown; retained observations expire after 30
          days.
        </p>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void load()}>
          Refresh observations
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!result.ok ? (
        <p role="alert">{result.message}</p>
      ) : (
        <>
          {!result.page.items.length && (
            <p>No connected app observations are available. Delivery is unknown.</p>
          )}
          <div className="space-y-3">
            {result.page.items.map((connection) => {
              const observation = connection.latestObservation;
              return (
                <article key={connection.id} className="workspace-panel space-y-2 p-4">
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold">{connection.displayName}</h2>
                    <Badge variant="outline">{connection.enabled ? 'Enabled' : 'Disabled'}</Badge>
                  </div>
                  <p className="text-sm break-all">
                    Bundle {connection.bundleId} · channel {connection.channel}
                  </p>
                  {observation ? (
                    <dl className="space-y-1 text-sm">
                      <div>
                        <dt className="font-medium">Latest reported stage</dt>
                        <dd>{observation.stage}</dd>
                      </div>
                      <div>
                        <dt className="font-medium">Reported version</dt>
                        <dd className="break-all">{observation.versionId}</dd>
                      </div>
                      <div>
                        <dt className="font-medium">Digest</dt>
                        <dd className="break-all">{observation.digest}</dd>
                      </div>
                      <div>
                        <dt className="font-medium">App observation time</dt>
                        <dd>
                          <time dateTime={observation.occurredAt}>{observation.occurredAt}</time>
                        </dd>
                      </div>
                      <div>
                        <dt className="font-medium">Service received time</dt>
                        <dd>
                          <time dateTime={observation.receivedAt}>{observation.receivedAt}</time>
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p>Nothing reported within retention · delivery unknown.</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Latest is selected by service receipt time. A delayed observation can refer to
                    an older version.
                  </p>
                </article>
              );
            })}
          </div>
          {result.page.nextCursor && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void load(result.page.nextCursor!)}
            >
              Load more connections
            </Button>
          )}
        </>
      )}
    </section>
  );
}
