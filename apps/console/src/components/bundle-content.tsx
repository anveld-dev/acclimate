import './source-editor.css';
import './published-source.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import {
  Braces,
  Code2,
  Download,
  Ellipsis,
  Pencil,
  Search,
  ShieldCheck,
  WrapText,
} from 'lucide-react';
import { Button } from './ui/button';
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from './ui/input-group';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Label } from './ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { sourceLines } from '../lib/syntax-source';
import { Badge } from './ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { FileGlyph, KindBadge, PathText, fileTitle } from './shared';
import type { ConsoleState } from '../server/channel';
import { bundleHref } from '../navigation';
import { ConsoleLink } from './console-link';
import { CopyButton } from './copy-button';
import { FileNavigator } from './file-navigator';
import { FileTree } from './file-tree';
import { SyntaxCode } from './syntax-code';

type Ready = Extract<ConsoleState, { status: 'ready' }>;
export function BundleContent({
  state,
  search,
}: {
  state: Ready;
  search: Record<string, unknown>;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(typeof search.q === 'string' ? search.q : '');
  useEffect(() => setQuery(typeof search.q === 'string' ? search.q : ''), [search.q]);
  const scope = { projectId: state.projectId, bundleId: state.bundleId, channel: state.channel };
  const [view, setView] = useState('source');
  const requestedSourceFocus = useRef<string | null>(null);
  const [wrap, setWrap] = useState(true);
  const inventory = useMemo(() => {
    const encoder = new TextEncoder();
    return state.payload.files.map((file) => ({
      file,
      bytes: encoder.encode(file.text).byteLength,
    }));
  }, [state.payload]);
  const searchTerm = String(search.q || '')
    .trim()
    .toLowerCase();
  const files = state.payload.files.filter(
    (file) =>
      !searchTerm ||
      file.path.toLowerCase().includes(searchTerm) ||
      file.text.toLowerCase().includes(searchTerm),
  );
  const filtered = Boolean(search.q);
  const requestedPath = typeof search.path === 'string' ? search.path : undefined;
  const selected = requestedPath ? files.find((file) => file.path === requestedPath) : files[0];
  const lineCount = useMemo(
    () => (selected ? sourceLines(selected.text).length : 0),
    [selected?.text],
  );
  const version = state.resolution.version;
  const selectedBytes = inventory.find((item) => item.file.path === selected?.path)?.bytes ?? 0;
  const fileReference = selected
    ? JSON.stringify(
        {
          projectId: scope.projectId,
          bundleId: scope.bundleId,
          versionId: version.id,
          versionDigest: version.digest,
          path: selected.path,
        },
        null,
        2,
      )
    : '';
  const link = (values: Record<string, string | undefined>) =>
    bundleHref(scope, 'content', {
      path: typeof search.path === 'string' ? search.path : undefined,
      q: typeof search.q === 'string' ? search.q : undefined,
      ...values,
    });
  function download() {
    if (!selected) return;
    const url = URL.createObjectURL(
      new Blob([selected.text], { type: 'text/plain;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = selected.path.split('/').at(-1)!;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="space-y-4">
      <section
        data-testid="file-browser"
        className="content-workspace file-explorer-workspace published-source-workspace"
      >
        <FileNavigator
          collapsible
          count={files.length}
          totalCount={state.payload.files.length}
          filtered={filtered}
          selectedPath={selected?.path}
        >
          <form
            className="file-navigator-controls"
            onSubmit={(event) => {
              event.preventDefault();
              void router.navigate({ href: link({ q: query || undefined }) });
            }}
          >
            <div className="file-navigator-heading">
              <span className="file-navigator-desktop-label text-sm font-medium">Files</span>
              <Label htmlFor="file-search" className="sr-only">
                Published content
              </Label>
            </div>
            <InputGroup className="content-search-group">
              <InputGroupInput
                id="file-search"
                type="search"
                className="content-search-input"
                placeholder="Search files…"
                aria-description="Search published paths or content"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <InputGroupAddon align="inline-end">
                <Tooltip>
                  <TooltipTrigger asChild data-slot="button">
                    <InputGroupButton
                      type="submit"
                      size="icon-sm"
                      className="file-search-submit"
                      aria-label="Search published paths or content"
                    >
                      <Search aria-hidden="true" />
                    </InputGroupButton>
                  </TooltipTrigger>
                  <TooltipContent>Search published paths or content</TooltipContent>
                </Tooltip>
              </InputGroupAddon>
            </InputGroup>
            {filtered && (
              <Button
                type="button"
                variant="ghost"
                onClick={async () => {
                  setQuery('');
                  await router.navigate({
                    href: link({ q: undefined, kind: undefined, path: undefined }),
                  });
                  requestAnimationFrame(() => document.getElementById('file-search')?.focus());
                }}
              >
                Clear filters
              </Button>
            )}
          </form>
          <FileTree
            items={files.map((file) => ({ id: file.path, path: file.path, kind: file.kind }))}
            selectedId={selected?.path}
            scopeKey={JSON.stringify([
              state.actorScope,
              state.projectId,
              state.bundleId,
              state.channel,
            ])}
            filtered={filtered}
            filterKey={String(search.q || '')}
            hrefForItem={(item) => link({ path: item.path })}
          />
          {!files.length && (
            <p className="p-4 text-sm text-muted-foreground">
              {filtered
                ? 'No matching entries. Clear filters to see all content.'
                : state.canEdit
                  ? 'No published entries. Create a draft to add content.'
                  : 'No published entries. Ask a workspace editor to add content.'}
            </p>
          )}
        </FileNavigator>
        <div className="content-detail">
          {selected ? (
            <>
              <header className="content-entry-heading compact-selected-file">
                <div className="flex min-w-0 items-start gap-3">
                  <FileGlyph kind={selected.kind} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h2 className="break-words text-sm font-semibold">{fileTitle(selected)}</h2>
                      <div className="content-entry-metadata flex flex-wrap items-center gap-2">
                        <a
                          className="published-revision-link text-sm text-muted-foreground"
                          href={
                            bundleHref(scope, 'releases') +
                            '#revision-' +
                            encodeURIComponent(state.resolution.revision)
                          }
                          aria-label={`Published · revision ${state.resolution.revision}, view release history`}
                        >
                          <span className="published-state-prefix">Published ·&nbsp;</span>revision{' '}
                          {state.resolution.revision}
                        </a>
                        <KindBadge kind={selected.kind} />
                        {!state.canEdit && <Badge variant="outline">Read only</Badge>}
                      </div>
                    </div>
                    {selected.path !== fileTitle(selected) && (
                      <p
                        tabIndex={0}
                        className="selected-file-path break-all font-mono text-sm text-muted-foreground"
                      >
                        <PathText value={selected.path} />
                      </p>
                    )}
                  </div>
                </div>
                <div className="content-entry-actions flex flex-wrap items-center gap-2">
                  {state.canEdit && (
                    <Button asChild>
                      <ConsoleLink
                        href={bundleHref(scope, 'changes', { draft: 'new', path: selected.path })}
                        aria-label="Edit entry"
                        title="Edit entry"
                      >
                        <Pencil aria-hidden="true" className="compact-source-action-icon" />
                        <span className="source-action-label">Edit entry</span>
                      </ConsoleLink>
                    </Button>
                  )}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        aria-label="Content actions"
                        title="Content actions"
                      >
                        <Ellipsis aria-hidden="true" className="compact-source-action-icon" />
                        <span className="source-action-label">Actions</span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      aria-label="Published entry actions"
                      className="published-file-actions w-52 max-w-[calc(100vw-2rem)] gap-1"
                    >
                      <div className="flex flex-col items-stretch gap-1 [&>span]:w-full">
                        <CopyButton
                          value={selected.text}
                          label="Copy content"
                          size="default"
                          className="w-full justify-between"
                        />
                        <CopyButton
                          value={selected.path}
                          label="Copy file path"
                          size="default"
                          className="w-full justify-between"
                        />
                        <Button
                          variant="outline"
                          className="justify-between"
                          aria-label="Download published entry"
                          onClick={download}
                        >
                          Download
                          <Download aria-hidden="true" />
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </header>
              <Tabs className="published-source-views" value={view} onValueChange={setView}>
                <div className="published-reading-tools">
                  <TabsList variant="line" aria-label="Published file view">
                    <TabsTrigger value="source">
                      <Code2 aria-hidden="true" />
                      Source
                    </TabsTrigger>
                    <TabsTrigger value="manifest">
                      <Braces aria-hidden="true" />
                      Manifest
                    </TabsTrigger>
                  </TabsList>
                  {view === 'source' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="published-wrap-control"
                      aria-pressed={wrap}
                      onClick={() => setWrap(!wrap)}
                    >
                      <WrapText aria-hidden="true" />
                      Wrap lines
                    </Button>
                  )}
                </div>
                <TabsContent value="source" className="content-editor-body">
                  <SyntaxCode
                    ref={(node) => {
                      if (node && requestedSourceFocus.current === selected.path) {
                        requestedSourceFocus.current = null;
                        node.focus({ preventScroll: true });
                      }
                    }}
                    lineNumbers
                    wrap={wrap}
                    code={selected.text}
                    path={selected.path}
                    data-testid="entry-content"
                    className="read-only-content text-sm leading-7"
                    tabIndex={0}
                    aria-label={`Content of ${selected.path}`}
                  />
                  <div className="published-source-status">
                    <span>
                      <ShieldCheck aria-hidden="true" />
                      Verified bundle
                    </span>
                    <span>
                      {lineCount} {lineCount === 1 ? 'line' : 'lines'}
                    </span>
                    <span>
                      {selectedBytes.toLocaleString()} UTF-8{' '}
                      {selectedBytes === 1 ? 'byte' : 'bytes'}
                    </span>
                  </div>
                </TabsContent>
                <TabsContent value="manifest" className="published-source-manifest">
                  <section className="published-manifest-provenance">
                    <header>
                      <h3>Published version</h3>
                      <span>
                        <ShieldCheck aria-hidden="true" />
                        Verified bundle
                      </span>
                    </header>
                    <dl>
                      <dt>Channel</dt>
                      <dd>
                        {scope.channel} · Revision {state.resolution.revision}
                      </dd>
                      <dt>Version ID</dt>
                      <dd>
                        <code>{version.id}</code>
                        <CopyButton value={version.id} label="Copy version ID" iconOnly />
                      </dd>
                      <dt>Bundle SHA-256</dt>
                      <dd>
                        <code>{version.digest}</code>
                        <CopyButton value={version.digest} label="Copy bundle digest" iconOnly />
                      </dd>
                      <dt>Origin</dt>
                      <dd>
                        {state.source.kind === 'imported'
                          ? 'Imported content'
                          : state.source.kind === 'seeded-example'
                            ? 'Seeded example'
                            : 'Stored bundle'}
                      </dd>
                    </dl>
                  </section>
                  <section className="published-manifest-inventory">
                    <header>
                      <h3>Files in revision {state.resolution.revision}</h3>
                      <span>
                        {inventory.length} {inventory.length === 1 ? 'file' : 'files'}
                      </span>
                    </header>
                    <div className="published-manifest-table-scroll">
                      <table aria-label="Published file inventory">
                        <thead>
                          <tr>
                            <th>Path</th>
                            <th>Kind</th>
                            <th>Bytes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {inventory.map(({ file, bytes }) => (
                            <tr
                              key={file.path}
                              data-selected={file.path === selected.path || undefined}
                            >
                              <td>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    requestedSourceFocus.current = file.path;
                                    if (file.path !== selected.path)
                                      await router.navigate({
                                        href: link({ path: file.path, q: undefined, kind: undefined }),
                                      });
                                    setView('source');
                                  }}
                                  aria-label={`Read source for ${file.path}`}
                                >
                                  <PathText value={file.path} />
                                </button>
                              </td>
                              <td>{file.kind}</td>
                              <td>{bytes.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="published-manifest-reference">
                    <header>
                      <h3>Selected file reference</h3>
                      <CopyButton value={fileReference} label="Copy file reference" />
                    </header>
                    <SyntaxCode
                      code={fileReference}
                      language="json"
                      aria-label="Immutable file reference"
                      className="published-reference-code"
                    />
                  </section>
                </TabsContent>
              </Tabs>
            </>
          ) : (
            <div className="space-y-3 p-4">
              <p className="break-words text-sm text-muted-foreground">
                {requestedPath
                  ? `“${requestedPath}” ${filtered ? 'isn’t in these search results' : 'isn’t available in this channel'}. Choose an entry from the list.`
                  : filtered
                    ? 'No entries match these filters.'
                    : state.canEdit
                      ? 'Add your first entry in a draft, then save and review its release.'
                      : 'Published content will appear here after an editor releases it.'}
              </p>
              {filtered && <p className="break-all text-sm">Search for “{String(search.q)}”</p>}
              {(filtered || requestedPath) && (
                <div className="flex flex-wrap gap-2">
                  {filtered && (
                    <Button variant="outline" asChild>
                      <ConsoleLink href={link({ q: undefined })}>Clear search</ConsoleLink>
                    </Button>
                  )}
                  {requestedPath && (
                    <Button variant="outline" asChild>
                      <ConsoleLink href={link({ path: undefined })}>Clear selection</ConsoleLink>
                    </Button>
                  )}
                </div>
              )}
              {!requestedPath && !filtered && state.canEdit && (
                <Button asChild>
                  <ConsoleLink href={bundleHref(scope, 'changes', { draft: 'new' })}>
                    New draft
                  </ConsoleLink>
                </Button>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
