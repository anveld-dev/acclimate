import { useEffect, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { Download, Search } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { NativeSelect } from './ui/native-select';
import { FileGlyph, KindBadge, fileDirectory, fileTitle } from './shared';
import type { ConsoleState } from '../server/channel';
import { bundleHref } from '../navigation';
import { ConsoleLink } from './console-link';
import { CopyButton } from './copy-button';

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
  const kind = ['instruction', 'skill', 'memory'].includes(String(search.kind))
    ? String(search.kind)
    : '';
  const scope = { projectId: state.projectId, bundleId: state.bundleId, channel: state.channel };
  const searchTerm = String(search.q || '')
    .trim()
    .toLowerCase();
  const files = state.payload.files.filter(
    (file) =>
      (!kind || file.kind === kind) &&
      (!searchTerm ||
        file.path.toLowerCase().includes(searchTerm) ||
        file.text.toLowerCase().includes(searchTerm)),
  );
  const filtered = Boolean(kind || search.q);
  const requestedPath = typeof search.path === 'string' ? search.path : undefined;
  const selected = requestedPath ? files.find((file) => file.path === requestedPath) : files[0];
  const link = (values: Record<string, string | undefined>) =>
    bundleHref(scope, 'content', {
      path: typeof search.path === 'string' ? search.path : undefined,
      kind: kind || undefined,
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
      <section data-testid="file-browser" className="content-workspace">
        <aside className="content-file-sidebar">
          <form
            className="space-y-3 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void router.navigate({ href: link({ q: query || undefined }) });
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="file-search">Published content</Label>
              <span className="text-xs text-muted-foreground" role="status">
                {filtered ? `${files.length} of ${state.payload.files.length}` : files.length}{' '}
                {files.length === 1 ? 'entry' : 'entries'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="file-search"
                  type="search"
                  className="content-search-input"
                  placeholder="Search paths or content…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Button type="submit" variant="outline" size="sm">
                Search
              </Button>
            </div>
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
            <label className="block space-y-1 text-sm">
              Entry type
              <NativeSelect
                aria-label="Entry type"
                className="w-full"
                value={kind}
                onChange={(event) =>
                  void router.navigate({
                    href: link({ kind: event.target.value || undefined, path: undefined }),
                  })
                }
              >
                <option value="">All types</option>
                <option value="instruction">Instructions</option>
                <option value="skill">Skills</option>
                <option value="memory">Memory</option>
              </NativeSelect>
            </label>
          </form>
          <div className="content-file-buttons">
            {files.map((file) => (
              <Button
                key={file.path}
                asChild
                variant="ghost"
                className={`content-file-button ${selected?.path === file.path ? 'is-selected' : ''}`}
              >
                <ConsoleLink
                  href={link({ path: file.path })}
                  aria-label={`Open ${file.path}`}
                  aria-current={selected?.path === file.path ? 'true' : undefined}
                >
                  <FileGlyph kind={file.kind} />
                  <span className="min-w-0 flex-1">
                    <strong className="block break-words text-sm font-medium">
                      {fileTitle(file)}
                    </strong>
                    <span className="block break-all text-xs text-muted-foreground">
                      {fileDirectory(file) === '/'
                        ? file.kind === 'instruction'
                          ? 'Instructions'
                          : file.kind === 'skill'
                            ? 'Skill'
                            : 'Memory'
                        : fileDirectory(file)}
                    </span>
                  </span>
                </ConsoleLink>
              </Button>
            ))}
          </div>
          {!files.length && (
            <p className="p-4 text-sm text-muted-foreground">
              {filtered
                ? 'No matching entries. Clear filters to see all content.'
                : state.canEdit
                  ? 'No published entries. Create a draft to add content.'
                  : 'No published entries. Ask a workspace editor to add content.'}
            </p>
          )}
        </aside>
        <div className="content-detail">
          {selected ? (
            <>
              <header className="content-entry-heading">
                <div className="flex min-w-0 items-start gap-3">
                  <FileGlyph kind={selected.kind} />
                  <div className="min-w-0">
                    <h2 className="break-words text-lg font-semibold">{fileTitle(selected)}</h2>
                    <p className="break-all font-mono text-sm text-muted-foreground">
                      {selected.path}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <KindBadge kind={selected.kind} />
                  {!state.canEdit && <Badge variant="outline">Read only</Badge>}
                  <CopyButton value={selected.text} label="Copy content" />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Download published entry"
                    onClick={download}
                  >
                    <Download aria-hidden="true" />
                  </Button>
                  {state.canEdit && (
                    <Button asChild>
                      <ConsoleLink
                        href={bundleHref(scope, 'changes', { draft: 'new', path: selected.path })}
                      >
                        Edit entry
                      </ConsoleLink>
                    </Button>
                  )}
                </div>
              </header>
              <div className="content-editor-body">
                <pre
                  data-testid="entry-content"
                  className="read-only-content text-sm leading-7"
                  tabIndex={0}
                  aria-label={`Content of ${selected.path}`}
                >
                  <code>{selected.text}</code>
                </pre>
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
