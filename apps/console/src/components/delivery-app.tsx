import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, GitBranch, Radio } from 'lucide-react';
import type { IntegrationObservation } from '@acclimate/sdk';
import type { DeliveryDetail, Report } from '../server/delivery-detail-core';
import { readDeliveryDetail } from '../server/delivery-observations-actions';
import { Button } from './ui/button';
import { StatusBadge } from './status-badge';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { VersionInspector } from './version-inspector';
import { ReceiptTime } from './receipt-time';
import { bundleHref } from '../navigation';
import { connectionHref } from '../lib/connection-navigation';

export function DeliveryApp({
  projectId,
  app,
  canManage,
}: {
  projectId: string;
  app: IntegrationObservation;
  canManage: boolean;
}) {
  const reportedPanel = useRef<HTMLElement>(null);
  const [detail, setDetail] = useState<DeliveryDetail>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [event, setEvent] = useState('');
  const [initialError, setInitialError] = useState(false);
  useEffect(() => {
    let active = true;
    readDeliveryDetail({ data: { projectId, integrationId: app.id } })
      .then((result) => {
        if (!active) return;
        if (result.ok) setDetail(result.detail);
        else {
          setInitialError(true);
          setError(result.message);
        }
      })
      .catch(() => {
        if (active) {
          setInitialError(true);
          setError('Receipt history is unavailable. Refresh to retry.');
        }
      });
    return () => {
      active = false;
    };
  }, [projectId, app.id]);
  async function more() {
    const cursor = detail?.receipts.nextCursor;
    if (!cursor || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await readDeliveryDetail({
        data: { projectId, integrationId: app.id, cursor },
      });
      if (!response.ok) {
        setError(response.message);
        return;
      }
      setDetail((previous) => {
        if (!previous) return response.detail;
        const items = new Map(previous.receipts.items.map((item) => [item.eventId, item]));
        for (const item of response.detail.receipts.items) items.set(item.eventId, item);
        return {
          ...response.detail,
          receipts: { ...response.detail.receipts, items: [...items.values()] },
        };
      });
    } catch {
      setError('Older receipts could not be loaded. Retry the history request.');
    } finally {
      setBusy(false);
    }
  }
  const receipts: Report[] =
    detail?.receipts.items ?? (app.latestObservation ? [app.latestObservation] : []);
  const report = receipts.find((item) => item.eventId === event) ?? receipts[0];
  const current = detail?.current;
  const same =
    report && current && report.versionId === current.versionId && report.digest === current.digest;
  const scope = { projectId, bundleId: app.bundleId, channel: app.channel };
  return (
    <section
      className="delivery-app-workspace"
      id="delivery-app"
      tabIndex={-1}
      aria-label={'Delivery for ' + app.displayName}
    >
      <header className="delivery-app-header">
        <div>
          <div className="delivery-app-heading">
            <Radio size={18} aria-hidden="true" />
            <h2>{app.displayName}</h2>
            <StatusBadge>{app.enabled ? 'Enabled' : 'Disabled'}</StatusBadge>
          </div>
          <span className="delivery-channel">
            <GitBranch size={13} aria-hidden="true" />
            <code>{app.channel}</code>
          </span>
        </div>
        <div className="delivery-app-links">
          <a
            href={
              bundleHref(scope, 'changes', { history: 1, tab: 'evaluations' }) +
              '#evaluation-history'
            }
            aria-label={'View bundle evaluations for ' + app.displayName}
          >
            Bundle evaluations <ArrowUpRight />
          </a>
          {canManage && (
            <a
              href={connectionHref(projectId, {}, app.id)}
              aria-label={'Open connection settings for ' + app.displayName}
            >
              Connection settings <ArrowUpRight />
            </a>
          )}
        </div>
      </header>
      {report && current && (
        <div className="delivery-comparison-status">
          <StatusBadge tone={same ? 'success' : 'warning'}>
            {same && <Check aria-hidden="true" />}
            {same ? 'Versions match' : 'Versions differ'}
          </StatusBadge>
        </div>
      )}
      <div className="delivery-versions">
        <section aria-label="Reported version" ref={reportedPanel} tabIndex={-1}>
          <div className="delivery-version-heading">
            <span>Reported version</span>
            {report && <StatusBadge>{report.stage}</StatusBadge>}
          </div>
          {report ? (
            <>
              <h3 title={report.versionId}>{report.versionId.slice(0, 8)}</h3>
              <dl>
                <div>
                  <dt>App observation time</dt>
                  <dd>
                    <ReceiptTime value={report.occurredAt} />
                  </dd>
                </div>
                <div>
                  <dt>Service received time</dt>
                  <dd>
                    <ReceiptTime value={report.receivedAt} />
                  </dd>
                </div>
              </dl>
              <VersionInspector
                scope={scope}
                versionId={report.versionId}
                label="Inspect reported files"
                contextLabel={app.displayName + ' · reported version ' + report.versionId}
              />
            </>
          ) : (
            <p>Nothing reported within retention · delivery unknown.</p>
          )}
        </section>
        <section aria-label="Current channel version">
          <div className="delivery-version-heading">
            <span>Current channel version</span>
          </div>
          {current ? (
            <>
              <h3 title={current.versionId}>{current.versionId.slice(0, 8)}</h3>
              <dl>
                <div>
                  <dt>Channel revision</dt>
                  <dd>{current.revision}</dd>
                </div>
                <div>
                  <dt>Promoted</dt>
                  <dd>
                    <ReceiptTime value={current.promotedAt} />
                  </dd>
                </div>
              </dl>
              <VersionInspector
                scope={scope}
                versionId={current.versionId}
                label="Inspect current files"
                contextLabel={app.displayName + ' · current version ' + current.versionId}
              />
            </>
          ) : (
            <p role="status">
              {!detail && !initialError
                ? 'Checking channel…'
                : 'Current channel release unavailable.'}
            </p>
          )}
        </section>
      </div>
      {error && (
        <p role="alert" className="delivery-detail-error">
          {error}
        </p>
      )}
      <section className="delivery-receipt-trail" aria-label="Receipt history">
        <header>
          <div>
            <h3>Receipt history</h3>
            <p>Most recently received first · retained for 30 days</p>
          </div>
          <span>{receipts.length} loaded</span>
        </header>
        {receipts.length > 0 ? (
          <>
            <div className="delivery-trail-cols" aria-hidden="true">
              <span>Reported stage</span>
              <span>Service received</span>
              <span>Version</span>
              <span>Receipt</span>
            </div>
            <ol>
              {receipts.map((item) => (
                <li key={item.eventId}>
                  <button
                    type="button"
                    aria-pressed={item.eventId === report?.eventId}
                    onClick={() => {
                      setEvent(item.eventId);
                      const panel = reportedPanel.current;
                      if (panel && panel.getBoundingClientRect().bottom < 110) {
                        panel.focus({ preventScroll: true });
                        panel.scrollIntoView({ block: 'start' });
                      }
                    }}
                  >
                    <strong>{item.stage}</strong>
                    <ReceiptTime value={item.receivedAt} />
                    <code title={item.versionId}>{item.versionId.slice(0, 8)}</code>
                    <code title={item.eventId}>{item.eventId.slice(0, 8)}</code>
                  </button>
                </li>
              ))}
            </ol>
            {report && (
              <Disclosure className="delivery-receipt-details">
                <DisclosureTrigger>Selected receipt details</DisclosureTrigger>
                <DisclosureContent>
                  <dl>
                    <div>
                      <dt>Receipt ID</dt>
                      <dd>{report.eventId}</dd>
                    </div>
                    <div>
                      <dt>Reported version</dt>
                      <dd>{report.versionId}</dd>
                    </div>
                    <div>
                      <dt>Digest</dt>
                      <dd>{report.digest}</dd>
                    </div>
                    <div>
                      <dt>Bundle</dt>
                      <dd>{app.bundleId}</dd>
                    </div>
                    {report.source && (
                      <div>
                        <dt>Source</dt>
                        <dd>
                          {report.source}
                          {report.delayed ? ' · delayed' : ''}
                        </dd>
                      </div>
                    )}
                  </dl>
                </DisclosureContent>
              </Disclosure>
            )}
          </>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No retained receipts.</p>
        )}
        {detail?.receipts.nextCursor && (
          <Button className="m-3" variant="outline" disabled={busy} onClick={() => void more()}>
            {busy ? 'Loading…' : 'Load older receipts'}
          </Button>
        )}
      </section>
    </section>
  );
}
