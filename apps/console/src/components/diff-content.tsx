import { diffArrays } from 'diff';
import { FileMerge } from './file-merge';
import type { BundlePayload } from '@acclimate/sdk';
import { Badge } from './ui/badge';
import { useId, useState } from 'react';
import { artifactChanges } from '../lib/artifact-changes';
import { Button } from './ui/button';
import { FileText, BookOpen, Bookmark } from 'lucide-react';
function changedLines(before: string, after: string) {
  const original = before ? before.split('\n') : [];
  const revised = after ? after.split('\n') : [];
  let first = 0;
  while (first < original.length && first < revised.length && original[first] === revised[first])
    first++;
  let oldEnd = original.length;
  let newEnd = revised.length;
  while (oldEnd > first && newEnd > first && original[oldEnd - 1] === revised[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const removed = original.slice(first, oldEnd);
  const added = revised.slice(first, newEnd);
  // A large rewrite still gets the complete replacement block and download.
  const chunks = diffArrays(removed, added, { maxEditLength: 512 });
  if (!chunks)
    return {
      lines: [...removed.map((line) => '- ' + line), ...added.map((line) => '+ ' + line)],
      additions: added.length,
    };
  return {
    lines: chunks.flatMap((chunk) =>
      chunk.added || chunk.removed
        ? chunk.value.map((line) => `${chunk.added ? '+' : '-'} ${line}`)
        : [],
    ),
    additions: chunks.reduce((sum, chunk) => sum + (chunk.added ? chunk.count : 0), 0),
  };
}

export function EntryDiffDownloads({
  path,
  before,
  after,
}: {
  path: string;
  before?: BundlePayload['files'][number];
  after?: BundlePayload['files'][number];
}) {
  return (
    <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {before && (
        <a
          className="underline"
          download={`${path.replaceAll('/', '-')}.before.json`}
          href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(before, null, 2))}`}
        >
          Download original entry JSON
        </a>
      )}
      {after && (
        <a
          className="underline"
          download={`${path.replaceAll('/', '-')}.after.json`}
          href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(after, null, 2))}`}
        >
          Download current entry JSON
        </a>
      )}
    </div>
  );
}

export function ContentDiff({
  base,
  current,
  selectedPath,
  onSelectPath,
  hideMap = false,
  labels,
  variant,
}: {
  base: BundlePayload;
  current: BundlePayload;
  selectedPath?: string;
  onSelectPath?: (path: string | null) => void;
  hideMap?: boolean;
  labels?: readonly [string, string];
  variant?: 'workspace';
}) {
  const changes = artifactChanges(base, current);
  const [selected, setSelected] = useState<string | null>(null);
  const prefix = useId();
  const selection = selectedPath ?? selected;
  const hasSelection = selection !== null && changes.some((change) => change.path === selection);
  const activeSelection = hasSelection ? selection : null;
  const visible = hasSelection ? changes.filter((change) => change.path === selection) : changes;
  const content = (
    <div
      className={`content-diff space-y-4${variant === 'workspace' ? ' content-diff-workspace' : ''}`}
    >
      {!changes.length ? (
        <p className="py-3 text-sm text-muted-foreground">No changes to compare.</p>
      ) : !hideMap ? (
        <p className="text-sm text-muted-foreground">
          {changes.length} {changes.length === 1 ? 'entry' : 'entries'} changed{' '}
          <span aria-hidden="true">·</span>{' '}
          <span className="text-emerald-700 dark:text-emerald-400">+ additions</span>{' '}
          <span className="text-red-700 dark:text-red-400">− removals</span>
        </p>
      ) : null}
      {!!changes.length && !hideMap && (
        <section className="artifact-change-map" aria-label="Changed artifact map">
          {(
            [
              ['instruction', 'Instructions', FileText],
              ['skill', 'Skills and resources', BookOpen],
              ['memory', 'Memory', Bookmark],
            ] as const
          ).map(([kind, label, Icon]) => {
            const files = changes.filter((change) => change.kind === kind);
            return (
              <div key={kind} className="artifact-change-group">
                <h4>
                  <Icon aria-hidden="true" className="size-4" />
                  {label}
                  <span>{files.length}</span>
                </h4>
                {files.length ? (
                  <ul>
                    {files.map((file) => (
                      <li key={file.path}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-pressed={activeSelection === file.path}
                          aria-label={`${file.operation}: ${file.path}`}
                          aria-controls={`${prefix}-diff`}
                          onClick={() =>
                            (onSelectPath ?? setSelected)(
                              activeSelection === file.path ? null : file.path,
                            )
                          }
                        >
                          <span className="artifact-change-operation" aria-hidden="true">
                            {file.operation === 'Added'
                              ? '+'
                              : file.operation === 'Removed'
                                ? '−'
                                : '~'}
                          </span>
                          <span className="artifact-change-path">{file.path}</span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">Unchanged</p>
                )}
              </div>
            );
          })}
        </section>
      )}
      {activeSelection && !selectedPath && !hideMap && (
        <Button size="sm" variant="outline" onClick={() => setSelected(null)}>
          Show all file changes
        </Button>
      )}
      <div id={`${prefix}-diff`} className="space-y-4">
        {visible.map(({ path, before, after }) => {
          const { lines, additions } = changedLines(before?.text ?? '', after?.text ?? '');
          return (
            <section key={path} className="overflow-hidden rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-3">
                <h3 className="min-w-0 break-all text-sm font-medium">
                  {!before ? 'Added' : !after ? 'Removed' : 'Changed'}: {path}
                </h3>
                <div className="flex flex-wrap items-center gap-3">
                  {lines.length > 0 && (
                    <span className="diff-line-counts font-mono text-xs">
                      <span aria-label={`${additions} added lines`}>+{additions}</span>
                      <span aria-label={`${lines.length - additions} removed lines`}>
                        −{lines.length - additions}
                      </span>
                    </span>
                  )}
                  <Badge variant="outline">
                    {!before
                      ? 'New entry'
                      : !after
                        ? 'Deleted entry'
                        : before.text === after.text
                          ? 'Type changed'
                          : 'Content changed'}
                  </Badge>
                </div>
              </div>
              <div className="p-4">
                {before && after && before.kind !== after.kind && (
                  <p>
                    Kind: {before.kind} → {after.kind}
                  </p>
                )}
                {lines.length ? (
                  <FileMerge
                    path={path}
                    before={before?.text ?? ''}
                    after={after?.text ?? ''}
                    labels={labels}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {before && after ? 'The text is unchanged.' : 'This entry has no text.'}
                  </p>
                )}
                {lines.length > 500 && (
                  <p>
                    {' '}
                    <a
                      className="underline"
                      download={`${path.replaceAll('/', '-')}.diff.txt`}
                      href={`data:text/plain;charset=utf-8,${encodeURIComponent(lines.join('\n'))}`}
                    >
                      Download all changed lines
                    </a>
                  </p>
                )}
                <EntryDiffDownloads path={path} before={before} after={after} />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
  return variant === 'workspace' ? (
    <div className="source-review-container">{content}</div>
  ) : (
    content
  );
}
