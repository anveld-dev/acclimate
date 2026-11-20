import { useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { ArrowRight, ChevronRight, Radio, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import { OutcomeLookup } from './outcome-lookup';
import { PageTitle } from './shared';
import { WorkspaceEmptyState } from './workspace-empty-state';
import { workspaceHref } from '../navigation';
import { readDeliveryObservations } from '../server/delivery-observations-actions';
import type { DeliveryObservationsResult } from '../server/delivery-observations-core';
import { DeliveryApp } from './delivery-app';

export function WorkspaceDelivery({
  workspaceId,
  initial,
  initialAppId,
  canManage = false,
}: {
  workspaceId: string;
  initialAppId?: string;
  canManage?: boolean;
  initial: DeliveryObservationsResult;
}) {
  const router = useRouter({ warn: false });
  const [result, setResult] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setResult(initial);
    setError('');
  }, [initial, workspaceId]);
  async function load(cursor?: string) {
    setBusy(true);
    setError('');
    try {
      const next = await readDeliveryObservations({
        data: { workspaceId, cursor, connectionId: cursor ? undefined : initialAppId },
      });
      setResult((previous) => {
        if (!cursor || !previous.ok || !next.ok || previous.workspaceId !== next.workspaceId)
          return next;
        const items = new Map(previous.page.items.map((item) => [item.id, item]));
        for (const item of next.page.items) items.set(item.id, item);
        return { ...next, page: { ...next.page, items: [...items.values()] } };
      });
      if (!cursor) setRefresh((value) => value + 1);
    } catch {
      setError('Delivery observations could not be refreshed. Current delivery is unknown.');
    } finally {
      setBusy(false);
    }
  }
  const apps = result.ok ? result.page.items : [];
  // Without an explicit choice, open the app with the most recent report rather than
  // an arbitrary first row that may have nothing to show.
  const selected = initialAppId
    ? apps.find((app) => app.id === initialAppId)
    : apps.reduce<(typeof apps)[number] | undefined>((best, app) => {
        const time = Date.parse(app.latestObservation?.receivedAt ?? '');
        const bestTime = Date.parse(best?.latestObservation?.receivedAt ?? '');
        return !best || (Number.isFinite(time) && !(time <= bestTime)) ? app : best;
      }, undefined);
  const home = workspaceHref(workspaceId, 'delivery');
  return (
    <section className="workspace-delivery delivery-console space-y-4">
      <PageTitle
        title="Delivery"
        description="Compare the version an app reported with its current channel release."
        actions={
          <Button type="button" variant="outline" onClick={() => void load()} disabled={busy}>
            <RefreshCw />
            {busy ? 'Loading observations…' : 'Refresh observations'}
          </Button>
        }
      />
      {error && <p role="alert">{error}</p>}
      {!result.ok ? (
        <p role="alert">{result.message}</p>
      ) : !apps.length ? (
        <WorkspaceEmptyState
          icon={Radio}
          title="No delivery reports yet"
          description="A connected app can report which bundle version it fetched. Until one does, Acclimate can't confirm what your apps are running."
          steps={
            canManage
              ? [
                  'Create a connection for the app’s bundle and channel.',
                  'Give the app its content-read credential.',
                  'Turn on optional reporting so the app sends a receipt after each fetch.',
                ]
              : undefined
          }
          actions={
            <Button asChild variant={canManage ? 'default' : 'outline'}>
              <a href={workspaceHref(workspaceId, canManage ? 'connections' : 'bundles')}>
                {canManage ? 'Set up a connection' : 'Browse bundles'}
                <ArrowRight aria-hidden="true" />
              </a>
            </Button>
          }
        />
      ) : (
        <>
          <div className="delivery-station">
            <nav aria-label="Connected apps" className="delivery-app-directory">
              <h2>
                Connected apps <span>{apps.length}</span>
              </h2>
              <ul>
                {apps.map((app) => {
                  const href =
                    home + '?connection=' + encodeURIComponent(app.id) + '#delivery-app';
                  return (
                    <li key={app.id}>
                      <a
                        className="delivery-app-select"
                        href={href}
                        aria-current={selected?.id === app.id ? 'true' : undefined}
                        onClick={(e) => {
                          if (
                            !router ||
                            e.ctrlKey ||
                            e.metaKey ||
                            e.shiftKey ||
                            e.altKey ||
                            e.button !== 0
                          )
                            return;
                          e.preventDefault();
                          void router.navigate({ href });
                        }}
                      >
                        <Radio size={15} aria-hidden="true" />
                        <span>
                          <strong>{app.displayName}</strong>
                          <small>
                            {app.latestObservation
                              ? app.latestObservation.stage
                              : 'Nothing reported within retention'}{' '}
                            · {app.channel}
                          </small>
                        </span>
                        <ChevronRight size={14} aria-hidden="true" />
                      </a>
                    </li>
                  );
                })}
              </ul>
              {result.page.nextCursor && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void load(result.page.nextCursor!)}
                >
                  Load more connections
                </Button>
              )}
            </nav>
            {selected ? (
              <div key={selected.id}>
                <DeliveryApp
                  key={selected.id + ':' + refresh}
                  app={selected}
                  workspaceId={workspaceId}
                  canManage={canManage}
                />
                <OutcomeLookup target={{ workspaceId, connectionId: selected.id }} />
              </div>
            ) : (
              <div className="p-4">
                <p role="alert">This app is unavailable in the workspace.</p>
                <a href={home} className="underline">
                  View connected apps
                </a>
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            A delayed observation can refer to an older version. Evaluations measure agent quality.
          </p>
        </>
      )}
    </section>
  );
}
