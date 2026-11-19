import { ReceiptTime } from './receipt-time';
import { SyntaxCode } from './syntax-code';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { readStoredVersion } from '../server/read-console';
import { ShieldCheck } from 'lucide-react';
import { Badge } from './ui/badge';
import { CopyButton } from './copy-button';
import { Input } from './ui/input';
import { fileTitle, KindBadge } from './shared';
import { FileNavigator } from './file-navigator';
import { FileTree } from './file-tree';

import type { BundleScope } from '../server/selection';

type Result = Awaited<ReturnType<typeof readStoredVersion>>;

export function VersionInspector({
  versionId,
  scope,
  label = 'Inspect',
  contextLabel,
}: {
  versionId: string;
  scope: BundleScope;
  label?: string;
  contextLabel?: string;
}) {
  return (
    <ScopedVersionInspector
      key={JSON.stringify([scope.projectId, scope.bundleId, scope.channel, versionId])}
      versionId={versionId}
      scope={scope}
      label={label}
      contextLabel={contextLabel}
    />
  );
}

function ScopedVersionInspector({
  versionId,
  scope,
  label,
  contextLabel,
}: {
  versionId: string;
  scope: BundleScope;
  label: string;
  contextLabel?: string;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const scopeKey = JSON.stringify([scope.projectId, scope.bundleId, scope.channel, versionId]);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const loadSequence = useRef(0);
  useEffect(
    () => () => {
      loadSequence.current++;
    },
    [],
  );

  async function load() {
    const sequence = ++loadSequence.current;
    setResult(null);
    setLoading(true);
    try {
      const next = await readStoredVersion({ data: { versionId, scope } });
      if (!next || typeof next.ok !== 'boolean') throw new Error('Version response unavailable');
      if (sequence === loadSequence.current) setResult(next);
    } catch {
      if (sequence === loadSequence.current)
        setResult({
          ok: false,
          message: 'Could not read this version. Check the connection and retry.',
        });
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }

  const matchingFiles = result?.ok
    ? result.payload.files.filter(
        (file) =>
          !query.trim() ||
          `${file.path} ${file.text}`.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : [];
  const selected = matchingFiles.find((file) => file.path === selectedPath) ?? matchingFiles[0];
  const sourceBytes = useMemo(() => (selected ? new Blob([selected.text]).size : 0), [selected]);
  const fileReference =
    result?.ok && selected
      ? JSON.stringify(
          {
            projectId: scope.projectId,
            bundleId: scope.bundleId,
            versionId: result.version.id,
            versionDigest: result.version.digest,
            path: selected.path,
          },
          null,
          2,
        )
      : '';
  function download() {
    if (!selected) return;
    const url = URL.createObjectURL(
      new Blob([selected.text], { type: 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = selected.path.split('/').pop() || 'entry.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open) {
          setResult(null);
          setSelectedPath(null);
          setQuery('');
          void load();
        } else loadSequence.current++;
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          disabled={!hydrated}
          aria-label={contextLabel ? `${label} for ${contextLabel}` : undefined}
        >
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="version-inspector-dialog">
        <DialogHeader className="version-inspector-header">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <DialogTitle>Version content</DialogTitle>
            {result?.ok && !loading && (
              <Badge variant="secondary">
                <ShieldCheck aria-hidden="true" />
                Bundle digest verified
              </Badge>
            )}
          </div>
          <DialogDescription>
            {contextLabel && <>{contextLabel}. </>}Read-only snapshot.
            {result?.ok && !loading && (
              <>
                {' '}
                Created{' '}
                <ReceiptTime value={result.version.createdAt} />
                .
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="version-inspector-body">
          {loading ? (
            <p role="status" className="version-inspector-state text-sm text-muted-foreground">
              Loading version…
            </p>
          ) : result && !result.ok ? (
            <div className="version-inspector-state space-y-3">
              <p role="alert" className="text-sm text-destructive">
                {result.message}
              </p>
              <Button variant="outline" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : result?.ok ? (
            <>
              <Disclosure>
                <div className="version-inspector-metadata">
                  <DisclosureTrigger className="cursor-pointer font-medium">
                    Version details
                  </DisclosureTrigger>
                  <DisclosureContent>
                    <dl className="mt-2 space-y-2 break-all">
                      <div>
                        <dt>Version ID</dt>
                        <dd>{result.version.id}</dd>
                      </div>
                      <div>
                        <dt>Bundle payload digest</dt>
                        <dd>{result.version.digest}</dd>
                      </div>
                      <div>
                        <dt>Parent version</dt>
                        <dd>{result.version.parentVersionId ?? 'None'}</dd>
                      </div>
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <CopyButton value={result.version.id} label="Copy version ID" />
                      <CopyButton value={result.version.digest} label="Copy digest" />
                      {result.version.parentVersionId && (
                        <CopyButton
                          value={result.version.parentVersionId}
                          label="Copy parent version"
                        />
                      )}
                    </div>
                  </DisclosureContent>
                </div>
              </Disclosure>
              <div className="content-workspace version-inspector-workspace">
                <FileNavigator
                  count={matchingFiles.length}
                  totalCount={result.payload.files.length}
                  filtered={!!query.trim()}
                  selectedPath={selected?.path}
                >
                  <div className="file-navigator-controls">
                    <Input
                      ref={searchRef}
                      type="search"
                      aria-label="Find a version entry"
                      placeholder="Search paths or content…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    {query && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setQuery('');
                          searchRef.current?.focus();
                        }}
                      >
                        Clear search
                      </Button>
                    )}
                  </div>
                  <FileTree
                    items={matchingFiles.map((file) => ({
                      id: file.path,
                      path: file.path,
                      kind: file.kind,
                    }))}
                    selectedId={selected?.path}
                    scopeKey={scopeKey}
                    filtered={!!query.trim()}
                    filterKey={query}
                    onSelectItem={(item) => setSelectedPath(item.id)}
                  />
                </FileNavigator>
                <div className="version-inspector-reader">
                  {selected ? (
                    <>
                      <header className="version-inspector-file-header">
                        <div>
                          <h3>{fileTitle(selected)}</h3>
                          <KindBadge kind={selected.kind} />
                          <span className="text-xs text-muted-foreground">
                            {sourceBytes.toLocaleString()} {sourceBytes === 1 ? 'byte' : 'bytes'}
                          </span>
                          {fileTitle(selected) !== selected.path && (
                            <p className="break-all">{selected.path}</p>
                          )}
                        </div>
                        <div className="version-file-actions flex flex-wrap gap-2">
                          <CopyButton value={fileReference} label="Copy file reference" />
                          <CopyButton value={selected.text} label="Copy content" iconOnly />
                          <Button variant="outline" size="sm" onClick={download}>
                            Download
                          </Button>
                        </div>
                      </header>
                      <SyntaxCode
                        aria-label={`Content of ${selected.path}`}
                        lineNumbers
                        className="version-inspector-source"
                        code={selected.text}
                        path={selected.path}
                      />
                    </>
                  ) : (
                    <p className="version-inspector-state text-sm text-muted-foreground">
                      {query.trim()
                        ? 'No entries match your search. Try another word or clear the search.'
                        : 'This version has no entries.'}
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
