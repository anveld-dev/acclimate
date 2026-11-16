import { SyntaxCode } from './syntax-code';
import type { BundlePayload } from '@acclimate/sdk';
import { Badge } from './ui/badge';
import { useId, useState } from 'react';
import { artifactChanges } from '../lib/artifact-changes';
import { Button } from './ui/button';
import { FileText, BookOpen, Bookmark } from 'lucide-react';
export function ContentDiff({
  base,
  current,
  selectedPath,
  hideMap = false,
  variant,
}: {
  base: BundlePayload;
  current: BundlePayload;
  selectedPath?: string;
  hideMap?: boolean;
  variant?: 'workspace';
}) {
  const changes = artifactChanges(base, current);
  const [selected, setSelected] = useState<string | null>(null);
  const prefix = useId();
  const selection = selectedPath ?? selected;
  const activeSelection =
    selection && changes.some((change) => change.path === selection) ? selection : null;
  const visible =
    selection && changes.some((change) => change.path === selection)
      ? changes.filter((change) => change.path === selection)
      : changes;
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
                            setSelected(activeSelection === file.path ? null : file.path)
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
          const a = (before?.text || '').split('\n'),
            b = (after?.text || '').split('\n');
          let prefix = 0;
          while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
          let suffix = 0;
          while (
            suffix < a.length - prefix &&
            suffix < b.length - prefix &&
            a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
          )
            suffix++;
          const lines = [
            ...a.slice(prefix, a.length - suffix).map((t) => '- ' + t),
            ...b.slice(prefix, b.length - suffix).map((t) => '+ ' + t),
          ];
          return (
            <section key={path} className="overflow-hidden rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-3">
                <h3 className="min-w-0 break-all text-sm font-medium">
                  {!before ? 'Added' : !after ? 'Removed' : 'Changed'}: {path}
                </h3>
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
              <div className="p-4">
                {before && after && before.kind !== after.kind && (
                  <p>
                    Kind: {before.kind} → {after.kind}
                  </p>
                )}
                {lines.length ? (
                  <SyntaxCode
                    code={lines.slice(0, 500).join('\n') + '\n'}
                    language="diff"
                    aria-label={`Changed lines in ${path}`}
                    className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border font-mono text-sm leading-6 p-3"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {before && after ? 'The text is unchanged.' : 'This entry has no text.'}
                  </p>
                )}
                {lines.length > 500 && (
                  <p>
                    Preview limited to 500 changed lines.{' '}
                    <a
                      className="underline"
                      download={`${path.replaceAll('/', '-')}.diff.txt`}
                      href={`data:text/plain;charset=utf-8,${encodeURIComponent(lines.join('\n'))}`}
                    >
                      Download all changed lines
                    </a>
                  </p>
                )}
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
