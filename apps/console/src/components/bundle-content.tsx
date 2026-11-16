import './source-editor.css';
import { useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Download, Search } from 'lucide-react';
import { Button } from './ui/button';
import { InputGroup, InputGroupInput, InputGroupAddon, InputGroupButton } from './ui/input-group';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Label } from './ui/label';
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
      <section data-testid="file-browser" className="content-workspace file-explorer-workspace">
        <FileNavigator
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
                onClick={() => {
                  setQuery('');
                  void router.navigate({
                    href: link({ q: undefined, kind: undefined, path: undefined }),
                  });
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
                        <span className="text-xs text-muted-foreground">Published</span>
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
                      >
                        Edit entry
                      </ConsoleLink>
                    </Button>
                  )}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" aria-label="Content actions">
                        Actions
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="end"
                      aria-label="Published entry actions"
                      className="w-60 max-w-[calc(100vw-2rem)] gap-2"
                    >
                      <div className="flex flex-col items-stretch gap-2 [&>span]:w-full">
                        <CopyButton
                          value={selected.text}
                          label="Copy content"
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
              <div className="content-editor-body">
                <SyntaxCode
                  code={selected.text}
                  path={selected.path}
                  data-testid="entry-content"
                  className="read-only-content text-sm leading-7"
                  tabIndex={0}
                  aria-label={`Content of ${selected.path}`}
                />
              </div>
            </>
          ) : (
            <div className="space-y-3 p-4">
              <p className="text-sm text-muted-foreground">
                {requestedPath
                  ? `“${requestedPath}” ${filtered ? 'isn’t in these search results' : 'isn’t available in this channel'}. Choose an entry from the list.`
                  : filtered
                    ? 'No entries match these filters.'
                    : state.canEdit
                      ? 'Add your first entry in a draft, then save and review its release.'
                      : 'Published content will appear here after an editor releases it.'}
              </p>
              {requestedPath && (
                <Button variant="outline" asChild>
                  <ConsoleLink href={link({ path: undefined })}>Clear selection</ConsoleLink>
                </Button>
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
