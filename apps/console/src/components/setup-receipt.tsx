import { useEffect, useState } from 'react';
import { ArrowUpRight, Radio } from 'lucide-react';
import { readSetupReport } from '../server/delivery-observations-actions';
import type { SetupReportResult } from '../server/delivery-detail-core';
import { workspaceHref } from '../navigation';
import { ConsoleLink } from './console-link';
import { ReceiptTime } from './receipt-time';

export function SetupReceipt({
  workspaceId,
  bundleId,
  channel,
}: {
  workspaceId: string;
  bundleId: string;
  channel: string;
}) {
  const [result, setResult] = useState<SetupReportResult>();
  useEffect(() => {
    let active = true;
    setResult(undefined);
    readSetupReport({ data: { workspaceId, bundleId, channel } })
      .then((next) => {
        if (active) setResult(next);
      })
      .catch(() => {
        if (active) setResult({ state: 'error' });
      });
    return () => {
      active = false;
    };
  }, [workspaceId, bundleId, channel]);
  return (
    <section className="setup-receipt rounded-md border p-4" aria-label="Latest delivery receipt">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Radio size={16} /> Latest delivery receipt
      </h3>
      {result?.state === 'received' ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <strong>{result.app}</strong>
          <span>
            {result.report.stage} ·{' '}
            <code title={result.report.versionId}>{result.report.versionId.slice(0, 8)}</code>
          </span>
          <span>
            Received <ReceiptTime value={result.report.receivedAt} />
          </span>
          <ConsoleLink
            className="inline-flex items-center gap-1 underline"
            href={
              workspaceHref(workspaceId, 'delivery') +
              '?integration=' +
              encodeURIComponent(result.appId)
            }
          >
            View delivery <ArrowUpRight size={14} />
          </ConsoleLink>
        </div>
      ) : (
        <p role="status" className="mt-1 text-sm text-muted-foreground">
          {!result
            ? 'Checking delivery…'
            : result.state === 'error'
              ? 'Delivery status is unavailable.'
              : 'No receipt reported for this bundle and channel in the last 30 days.'}
        </p>
      )}
    </section>
  );
}
