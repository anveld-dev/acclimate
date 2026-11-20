import { useEffect, useState } from 'react';
import type { BundlePayload, VersionMetadata } from '@acclimate/sdk';
import type { ChangesHistoryScope } from '../lib/changes-workspace';
import { artifactChanges } from '../lib/artifact-changes';
import { readStoredVersion } from '../server/read-console';
import { FileNavigator } from './file-navigator';
import { FileTree } from './file-tree';
import { ContentDiff } from './diff-content';
import { SyntaxCode } from './syntax-code';
import { Button } from './ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';

export type HistoryVersionState =
  | { status: 'none'; id: string }
  | { status: 'loading'; id: string }
  | { status: 'unavailable'; id: string; message: string }
  | {
      status: 'ready';
      id: string;
      version: VersionMetadata;
      payload: BundlePayload;
      base?: { version: VersionMetadata; payload: BundlePayload };
      baseError?: string;
    };

/** Immutable bytes are verified on the server. A failed base read never becomes a fabricated diff. */
export function useHistoryVersion(scope: ChangesHistoryScope, id?: string): HistoryVersionState {
  const [result, setResult] = useState<HistoryVersionState>({ status: 'none', id: '' });
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!id) {
      setResult({ status: 'none', id: '' });
      return;
    }
    const selected = id;
    setResult({ status: 'loading', id: selected });
    async function read() {
      let retry = false;
      try {
        const candidate = await readStoredVersion({ data: { scope, versionId: selected } });
        if (!active) return;
        if (!candidate.ok) throw Error(candidate.message);
        let base: { version: VersionMetadata; payload: BundlePayload } | undefined;
        let baseError: string | undefined;
        if (candidate.version.parentVersionId) {
          try {
            const parent = await readStoredVersion({
              data: { scope, versionId: candidate.version.parentVersionId },
            });
            if (!active) return;
            if (!parent.ok) throw Error(parent.message);
            base = parent;
          } catch {
            baseError =
              'The creation base is unavailable. Showing saved content; retrying the base automatically.';
            retry = true;
          }
        }
        if (active)
          setResult({
            status: 'ready',
            id: selected,
            version: candidate.version,
            payload: candidate.payload,
            base,
            baseError,
          });
      } catch {
        if (active)
          setResult({
            status: 'unavailable',
            id: selected,
            message:
              'This version could not be read. Check its identity or access. Retrying automatically.',
          });
        retry = true;
      }
      if (active && retry) timer = setTimeout(read, 15000);
    }
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    id,
    scope.workspaceId,
    scope.bundleId,
    scope.channel,
    scope.actorScope,
    scope.serviceIdentity,
  ]);
  return result.id === (id || '') ? result : { status: id ? 'loading' : 'none', id: id || '' };
}

export function HistoryFiles({
  value,
  requestedPath,
  scopeKey,
  onSelectPath,
}: {
  value: HistoryVersionState;
  requestedPath?: string;
  scopeKey: string;
  onSelectPath: (path: string) => void;
}) {
  if (value.status === 'none') return <p>Choose a version to inspect its files.</p>;
  if (value.status === 'loading')
    return (
      <p role="status" className="text-muted-foreground">
        Reading verified files…
      </p>
    );
  if (value.status === 'unavailable')
    return (
      <p role="alert" className="text-destructive">
        {value.message}
      </p>
    );
  const changes = value.base ? artifactChanges(value.base.payload, value.payload) : [];
  const items = value.base
    ? changes.map((change) => ({ id: change.path, path: change.path, kind: change.kind }))
    : value.payload.files.map((file) => ({ id: file.path, path: file.path, kind: file.kind }));
  const path = requestedPath || items[0]?.path;
  const missing = !!requestedPath && !items.some((item) => item.path === requestedPath);
  const file = value.payload.files.find((entry) => entry.path === path);
  return (
    <section className="history-files space-y-3" aria-label="Saved version files">
      <div className="history-files-base text-sm text-muted-foreground">
        {value.base ? (
          <p>
            File changes from this version’s creation base{' '}
            <code>{value.base.version.id.slice(0, 8)}</code>. Each evaluation lists its own
            comparison parent.
          </p>
        ) : (
          <p>
            {value.baseError || 'This version has no creation base. Showing its saved content.'}
          </p>
        )}
        <Disclosure>
          <DisclosureTrigger>Version details</DisclosureTrigger>
          <DisclosureContent>
            <dl className="history-version-details">
              <dt>Saved version</dt>
              <dd>{value.version.id}</dd>
              <dt>Digest</dt>
              <dd>{value.version.digest}</dd>
              <dt>Creation base</dt>
              <dd>{value.version.parentVersionId || 'None'}</dd>
            </dl>
          </DisclosureContent>
        </Disclosure>
      </div>
      {!items.length ? (
        <div className="space-y-3">
          <p className="text-muted-foreground">No file changes from the creation base.</p>
          {missing && (
            <div role="alert" className="space-y-3">
              <p>
                The requested path is not in this file view: <code>{requestedPath}</code>.
              </p>
              <Button variant="outline" onClick={() => onSelectPath('')}>
                Clear file selection
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="history-files-grid">
          <FileNavigator count={items.length} selectedPath={path}>
            <FileTree
              items={items}
              selectedId={missing ? undefined : path}
              scopeKey={`${scopeKey}:${value.id}`}
              onSelectItem={(item) => onSelectPath(item.path)}
            />
          </FileNavigator>
          <div className="history-files-content">
            {missing ? (
              <div role="alert" className="space-y-3">
                <p>
                  The requested path is not in this file view: <code>{requestedPath}</code>.
                </p>
                <Button variant="outline" onClick={() => onSelectPath(items[0].path)}>
                  Show the first file
                </Button>
              </div>
            ) : value.base ? (
              <ContentDiff
                base={value.base.payload}
                current={value.payload}
                selectedPath={path}
                hideMap
              />
            ) : file ? (
              <section>
                <h3 className="mb-3 font-semibold break-all">{file.path}</h3>
                <SyntaxCode
                  path={file.path}
                  code={file.text}
                  aria-label={`Saved content of ${file.path}`}
                />
              </section>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
