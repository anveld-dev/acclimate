import { SyntaxCode } from './syntax-code';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { useEffect, useRef, useState } from 'react';
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
import { CopyButton } from './copy-button';
import { Input } from './ui/input';
import { FileGlyph, fileTitle, KindBadge } from './shared';

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
    setLoading(true);
    try {
      const next = await readStoredVersion({ data: { versionId, scope } });
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Version content</DialogTitle>
          <DialogDescription>
            {contextLabel && <>{contextLabel}. </>}Browse the files saved in this version.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading version…</p>
        ) : result && !result.ok ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {result.message}
            </p>
            <Button variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : result?.ok ? (
          <div className="space-y-4">
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                Created{' '}
                <time dateTime={result.version.createdAt}>
                  {new Date(result.version.createdAt).toISOString().replace('T', ' ').slice(0, 19)}{' '}
                  UTC
                </time>
              </p>
              <Disclosure>
                <DisclosureTrigger className="cursor-pointer font-medium">
                  Version details
                </DisclosureTrigger>
                <DisclosureContent>
                  <dl className="mt-2 space-y-2 break-all">
                    <div>
                      <dt className="text-muted-foreground">Version ID</dt>
                      <dd>{result.version.id}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Digest</dt>
                      <dd>{result.version.digest}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Parent version</dt>
                      <dd>{result.version.parentVersionId ?? 'None'}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <CopyButton value={result.version.id} label="Copy version ID" />
                    <CopyButton value={result.version.digest} label="Copy digest" />
                  </div>
                </DisclosureContent>
              </Disclosure>
            </div>
            <div className="grid overflow-hidden rounded-lg border md:grid-cols-[250px_minmax(0,1fr)]">
              <div className="flex min-w-0 flex-col border-b md:border-b-0 md:border-r">
                <div className="space-y-2 border-b p-3">
                  <Input
                    type="search"
                    aria-label="Find a version entry"
                    placeholder="Search paths or content…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <div className="max-h-52 overflow-auto p-2 md:max-h-[50vh]">
                  {matchingFiles.map((file) => (
                    <Button
                      key={file.path}
                      variant="ghost"
                      className={`h-auto min-h-12 w-full justify-start gap-3 whitespace-normal px-2 py-3 text-left ${selected?.path === file.path ? 'bg-accent' : ''}`}
                      onClick={() => setSelectedPath(file.path)}
                      aria-pressed={selected?.path === file.path}
                    >
                      <FileGlyph kind={file.kind} />
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-medium">
                          {fileTitle(file)}
                        </span>
                        <span className="block break-all text-xs text-muted-foreground">
                          {file.path}
                        </span>
                      </span>
                    </Button>
                  ))}
                  {!matchingFiles.length && (
                    <p className="p-3 text-sm text-muted-foreground">
                      {query ? 'No matching entries.' : 'No entries in this version.'}
                    </p>
                  )}
                </div>
                <p
                  className="mt-auto border-t px-3 py-2 text-sm text-muted-foreground"
                  role="status"
                >
                  {matchingFiles.length} {matchingFiles.length === 1 ? 'entry' : 'entries'}
                  {query && ` of ${result.payload.files.length}`}
                </p>
              </div>
              <div className="min-w-0 p-4">
                {selected ? (
                  <>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 space-y-2">
                        <h3 className="break-all text-sm font-medium">{selected.path}</h3>
                        <KindBadge kind={selected.kind} />
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <CopyButton value={selected.text} label="Copy content" />
                        <Button variant="outline" size="sm" onClick={download}>
                          Download
                        </Button>
                      </div>
                    </div>
                    <SyntaxCode
                      tabIndex={0}
                      aria-label={`Content of ${selected.path}`}
                      className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-4 text-sm leading-7"
                      code={selected.text}
                      path={selected.path}
                    />
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {query
                      ? 'No entries match your search. Try another word or clear the search.'
                      : 'This version has no entries.'}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
