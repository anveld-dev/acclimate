import { useEffect, useState } from 'react';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { Button } from './ui/button';
import { Panel } from './panel';
import { ReceiptTime } from './receipt-time';
import { StatusBadge, type StatusTone } from './status-badge';
import {
  describeImportReason,
  shortTaskId,
  type ImportSummary,
  type TaskReviewRequest,
} from '../lib/task-review';

export function TaskId({ id }: { id: string }) {
  const [copied, setCopied] = useState('');
  const short = shortTaskId(id);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <span className="font-medium">
        Task{' '}
        <code title={id} className="font-mono">
          {short}
        </code>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Copy the full task ID"
        aria-label={`Copy ID of task ${short}`}
        onClick={() => {
          Promise.resolve()
            .then(() => navigator.clipboard.writeText(id))
            .then(
              () => setCopied('Copied the task ID.'),
              () => setCopied('Could not copy. Select the ID and copy it: ' + id),
            );
        }}
      >
        {copied === 'Copied the task ID.' ? (
          <Check aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
      </Button>
      {copied && (
        <span role="status" className="text-xs text-muted-foreground">
          {copied}
        </span>
      )}
    </span>
  );
}

const importStatus = (job: ImportSummary): { label: string; tone: StatusTone } =>
  job.status === 'failed'
    ? { label: 'Failed', tone: 'danger' }
    : job.status === 'completed' || !job.pending
      ? { label: 'Completed', tone: 'success' }
      : { label: 'Converting', tone: 'info' };
const setAsideCount = (job: ImportSummary) =>
  job.setAsideCount ?? (Array.isArray(job.setAside) ? job.setAside.length : 0);

export function ImportList({ imports }: { imports: ImportSummary[] }) {
  if (!imports.length)
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        No imports yet. Import material above to create tasks.
      </p>
    );
  return (
    <ul className="divide-y">
      {imports.map((job) => {
        const status = importStatus(job);
        const aside = setAsideCount(job);
        return (
          <li key={job.importId}>
            <details className="group/import">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-sm hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/import:rotate-90"
                />
                <span className="min-w-0 flex-[1_1_12rem] font-medium [overflow-wrap:anywhere]">
                  {job.source || 'Import'}
                </span>
                <span className="text-muted-foreground">
                  <ReceiptTime value={job.createdAt} />
                </span>
                <span className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
                  <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  <StatusBadge>
                    {job.rows} {job.rows === 1 ? 'row' : 'rows'}
                  </StatusBadge>
                  <StatusBadge tone={job.converted ? 'success' : 'neutral'}>
                    {job.converted} converted
                  </StatusBadge>
                  <StatusBadge tone={job.pending ? 'info' : 'neutral'}>
                    {job.pending} pending
                  </StatusBadge>
                  <StatusBadge tone={aside ? 'warning' : 'neutral'}>{aside} set aside</StatusBadge>
                </span>
              </summary>
              <div className="space-y-2 px-4 pb-3 pl-10 text-sm">
                {job.status === 'failed' && (
                  <p>{job.message || 'Import failed.'} Fix the material and import it again.</p>
                )}
                {Array.isArray(job.setAside) && job.setAside.length > 0 ? (
                  <ul
                    aria-label={`Rows set aside from ${job.source || 'this import'}`}
                    className="space-y-1"
                  >
                    {job.setAside.map(({ row, source, reason }) => (
                      <li key={source + ':' + row}>
                        {source} · Row {row}: {describeImportReason(reason)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">No rows were set aside.</p>
                )}
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

export function LearningImports({
  scope,
  revision,
  load,
}: {
  scope: { workspaceId: string; bundleId: string };
  revision: string;
  load: <T>(data: TaskReviewRequest) => Promise<T>;
}) {
  const [imports, setImports] = useState<ImportSummary[]>();
  const [error, setError] = useState('');
  const { workspaceId, bundleId } = scope;
  useEffect(() => {
    let active = true;
    load<ImportSummary[]>({ workspaceId, bundleId, action: 'imports' }).then(
      (items) => {
        if (active) {
          setImports(items);
          setError('');
        }
      },
      () => {
        if (active) setError('Could not load past imports. Use Refresh tasks to try again.');
      },
    );
    return () => {
      active = false;
    };
  }, [workspaceId, bundleId, revision, load]);
  return (
    <Panel
      id="learning-imports"
      title="Imports"
      description="Past imports, newest first. Open one to see the rows it set aside."
      flush
    >
      {error ? (
        <p role="alert" className="px-4 py-3 text-sm">
          {error}
        </p>
      ) : !imports ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading imports…</p>
      ) : (
        <ImportList imports={imports} />
      )}
    </Panel>
  );
}
