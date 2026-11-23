import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import {
  describeImportReason,
  shortTaskId,
  type ImportSummary,
  type TaskReviewRequest,
} from '../lib/task-review';

export function TaskId({ id }: { id: string }) {
  const [copied, setCopied] = useState('');
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm">
      <span>
        Task <code title={id}>{shortTaskId(id)}</code>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`Copy ID of task ${shortTaskId(id)}`}
        onClick={() => {
          Promise.resolve()
            .then(() => navigator.clipboard.writeText(id))
            .then(
              () => setCopied('Copied the task ID.'),
              () => setCopied('Could not copy. Select the ID and copy it: ' + id),
            );
        }}
      >
        Copy ID
      </Button>
      {copied && <span role="status">{copied}</span>}
    </span>
  );
}

const when = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};
const importStatus = (job: ImportSummary) =>
  job.status === 'failed'
    ? 'Failed'
    : job.status === 'completed' || !job.pending
      ? 'Completed'
      : 'Converting';
const setAsideCount = (job: ImportSummary) =>
  job.setAsideCount ?? (Array.isArray(job.setAside) ? job.setAside.length : 0);

export function ImportList({ imports }: { imports: ImportSummary[] }) {
  if (!imports.length) return <p>No imports yet. Import material above to create tasks.</p>;
  return (
    <ul className="space-y-2">
      {imports.map((job) => (
        <li key={job.importId} className="rounded-md border p-3">
          <details>
            <summary>
              {job.source || 'Import'} · {when(job.createdAt)} · {importStatus(job)} · {job.rows}{' '}
              rows · {job.converted} converted · {job.pending} pending · {setAsideCount(job)} set
              aside
            </summary>
            {job.status === 'failed' && (
              <p>{job.message || 'Import failed.'} Fix the material and import it again.</p>
            )}
            {Array.isArray(job.setAside) && job.setAside.length > 0 ? (
              <ul aria-label={`Rows set aside from ${job.source || 'this import'}`}>
                {job.setAside.map(({ row, source, reason }) => (
                  <li key={source + ':' + row}>
                    {source} · Row {row}: {describeImportReason(reason)}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No rows were set aside.</p>
            )}
          </details>
        </li>
      ))}
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
    <section className="workspace-panel space-y-3 p-5" aria-labelledby="learning-imports">
      <h2 id="learning-imports" className="font-semibold">
        Imports
      </h2>
      {error ? (
        <p role="alert">{error}</p>
      ) : !imports ? (
        'Loading imports…'
      ) : (
        <ImportList imports={imports} />
      )}
    </section>
  );
}
