import { ReceiptTime } from './receipt-time';
import { StatusBadge } from './status-badge';
import { ReleaseComparison } from './release-comparison';
import './release-comparison.css';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { CircleCheck, GitCommitHorizontal } from 'lucide-react';
import { ChangeRecordDetails } from './change-record-details';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { VersionInspector } from './version-inspector';
import { ConsoleLink, consoleDestination } from './console-link';
import { bundleHref, releaseRevision } from '../navigation';
import { matchesRelease } from '../lib/release-search';
import { readReleaseHistory } from '../server/read-console';
import type { ConsoleState } from '../server/channel';

export function BundleReleases({ state }: { state: Extract<ConsoleState, { status: 'ready' }> }) {
  const router = useRouter();
  const scope = { workspaceId: state.workspaceId, bundleId: state.bundleId, channel: state.channel };
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [page, setPage] = useState(state.history);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [linkedRelease, setLinkedRelease] = useState<(typeof page.items)[number] | null>(null);
  const activeHash = useRouterState({ select: (state) => state.location.hash });
  const fragment = activeHash ? '#' + activeHash : '';
  useEffect(() => {
    let ignore = false;
    const revision = releaseRevision(/^#revision-(.+)$/.exec(fragment)?.[1]);
    if (
      !revision ||
      linkedRelease?.revision === revision ||
      page.items.some((item) => item.revision === revision)
    )
      return;
    if (!page.nextBeforeRevision || BigInt(revision) >= BigInt(page.nextBeforeRevision)) return;
    const beforeRevision = String(BigInt(revision) + 1n);
    async function readLinkedRelease() {
      try {
        const result = await readReleaseHistory({
          data: { scope, beforeRevision },
        });
        if (ignore) return;
        if (!result.ok) setError(result.message);
        else {
          const found = result.page.items.find((item) => item.revision === revision);
          if (found) setLinkedRelease(found);
          else setError('This revision could not be found in the channel history.');
        }
      } catch {
        if (!ignore) setError('Could not load the linked revision. Reload to retry.');
      }
    }
    void readLinkedRelease();
    return () => {
      ignore = true;
    };
  }, [fragment, linkedRelease, page, state.workspaceId, state.bundleId, state.channel]);
  useEffect(() => {
    if (linkedRelease && fragment === '#revision-' + linkedRelease.revision) {
      document.getElementById(fragment.slice(1))?.focus();
    }
  }, [linkedRelease, fragment]);
  const showLinked =
    linkedRelease &&
    fragment === '#revision-' + linkedRelease.revision &&
    !page.items.some((item) => item.id === linkedRelease.id);
  const loadedItems = showLinked ? [...page.items, linkedRelease] : page.items;
  // "Loaded" matters only while older releases remain unfetched or a linked one is appended.
  const partial = Boolean(page.nextBeforeRevision || showLinked);
  // Search earns its space once there are enough releases to scan.
  const searchable = Boolean(query) || partial || loadedItems.length > 5;
  const term = query.trim().toLowerCase();
  const matches = loadedItems.filter((item) => matchesRelease(item, term));
  const requestedRevision = releaseRevision(/^#revision-(.+)$/.exec(fragment)?.[1]);
  const selected =
    matches.find((item) => item.revision === requestedRevision) ??
    (term || !requestedRevision ? matches[0] : undefined);
  function chooseRevision(revision: string) {
    void router.navigate({
      ...consoleDestination(bundleHref(scope, 'releases') + '#revision-' + revision),
      hashScrollIntoView: false,
      resetScroll: false,
      replace: true,
    });
  }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  async function loadMore() {
    if (!page.nextBeforeRevision || loading) return;
    setLoading(true);
    setError('');
    try {
      const result = await readReleaseHistory({
        data: { beforeRevision: page.nextBeforeRevision, scope },
      });
      if (!result.ok) setError(result.message);
      else
        setPage((previous) => ({
          items: [
            ...previous.items,
            ...result.page.items.filter(
              (item) => !previous.items.some((existing) => existing.id === item.id),
            ),
          ],
          nextBeforeRevision: result.page.nextBeforeRevision,
        }));
    } catch {
      setError('Could not read release history. Check the connection and retry.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bundle-releases release-page-layout space-y-4">
      <section className="release-history release-history-layout">
        {/* The Releases tab names this view; the heading remains for assistive navigation. */}
        <h2 className="sr-only">Release history</h2>
        {!state.canEdit && (
          <div className="release-history-header">
            <span className="text-sm text-muted-foreground">Read only</span>
          </div>
        )}
        {loadedItems.length ? (
          <div className="release-workbench">
            <div className="release-picker" aria-label="Release revisions">
              <div className="release-picker-search">
                {searchable && (
                  <div className="grid w-full max-w-sm gap-1.5">
                    <Label htmlFor="release-search">Find a release</Label>
                    <Input
                      id="release-search"
                      ref={searchRef}
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Revision, version ID, or digest"
                    />
                  </div>
                )}
                {term && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setQuery('');
                      searchRef.current?.focus();
                    }}
                  >
                    Clear search
                  </Button>
                )}
                <span role="status" className="pb-1 text-xs text-muted-foreground">
                  {term
                    ? `${matches.length} of ${loadedItems.length} ${partial ? 'loaded ' : ''}releases`
                    : `${loadedItems.length} ${partial ? 'loaded ' : ''}${loadedItems.length === 1 ? 'release' : 'releases'}`}
                </span>
              </div>

              <div className="release-picker-scroll">
                {matches.map((item) => (
                  <article
                    data-testid="release-decision"
                    key={item.id}
                    id={`revision-${item.revision}`}
                    tabIndex={-1}
                    aria-label={`Revision ${item.revision}${item.revision === state.resolution.revision ? ' · Current' : ''}`}
                  >
                    <button
                      type="button"
                      className="release-picker-option"
                      disabled={!hydrated}
                      aria-pressed={selected?.id === item.id}
                      onClick={() => chooseRevision(item.revision)}
                    >
                      {item.revision === state.resolution.revision ? (
                        <CircleCheck aria-hidden="true" />
                      ) : (
                        <GitCommitHorizontal aria-hidden="true" />
                      )}
                      <strong>
                        <span className="sr-only">Compare </span>Revision {item.revision}
                      </strong>
                      {item.revision === state.resolution.revision && (
                        <StatusBadge tone="success">Current</StatusBadge>
                      )}
                      {showLinked && linkedRelease?.id === item.id && (
                        <StatusBadge tone="info">Linked revision</StatusBadge>
                      )}
                      <ReceiptTime value={item.createdAt} />
                      <code>{item.version.id.slice(0, 8)}</code>
                    </button>
                  </article>
                ))}
              </div>
            </div>
            {selected ? (
              <ReleaseComparison
                key={selected.id}
                scope={scope}
                release={selected}
                current={selected.revision === state.resolution.revision}
                actions={
                  <>
                    {selected.version.parentVersionId && (
                      <ConsoleLink
                        className="release-comparison-link"
                        href={bundleHref(scope, 'changes', {
                          history: 1,
                          fromRevision: selected.revision,
                          candidate: selected.version.id,
                          tab: 'files',
                        })}
                        aria-label={`Compare with creation base for revision ${selected.revision}`}
                      >
                        Compare with creation base
                      </ConsoleLink>
                    )}
                    <div className="release-actions">
                      <div className="release-inspection-actions">
                        <VersionInspector
                          scope={scope}
                          versionId={selected.version.id}
                          label="Inspect content"
                          contextLabel={`revision ${selected.revision}`}
                        />
                        <ChangeRecordDetails
                          title="Release details"
                          triggerLabel={`Release details for revision ${selected.revision}`}
                          description="The saved content, release decision and recorded evidence."
                          copyLabel="Copy release details"
                          value={JSON.stringify(selected, null, 2)}
                          fields={[
                            ['Revision', selected.revision],
                            ['Published', <ReceiptTime value={selected.createdAt} />],
                            ['Reviewer', selected.reviewer],
                            [
                              'Reason',
                              selected.policyOverride?.reason ||
                                selected.unevaluatedReason ||
                                (selected.comparisonId
                                  ? 'Recorded evaluation evidence.'
                                  : 'No release reason recorded.'),
                            ],
                            ...(selected.policyOverride?.receipts.map(
                              (receipt): [string, string] => [
                                'Overridden policy',
                                receipt.policyDigest + ' · comparison ' + receipt.comparisonId,
                              ],
                            ) ?? []),
                            ['Release ID', selected.id],
                            ['Version', selected.version.id],
                            ['Digest', selected.version.digest],
                            ['Previous version', selected.previousVersionId || 'None'],
                            ...(selected.comparisonId
                              ? [['Comparison', selected.comparisonId] as [string, string]]
                              : []),
                          ]}
                        />
                      </div>
                      {selected.comparisonId && (
                        <Button asChild variant="outline">
                          <ConsoleLink
                            aria-label={`Inspect evidence for revision ${selected.revision}`}
                            href={bundleHref(scope, 'changes', {
                              candidate: selected.version.id,
                              comparison: selected.comparisonId,
                              fromRevision: selected.revision,
                            })}
                          >
                            Inspect evidence
                          </ConsoleLink>
                        </Button>
                      )}

                    </div>
                  </>
                }
              />
            ) : !matches.length ? (
              <p className="p-4 text-sm text-muted-foreground">
                No loaded releases match your search.
              </p>
            ) : (
              <div className="space-y-3 p-4">
                <p role="status">
                  {page.nextBeforeRevision &&
                  requestedRevision &&
                  BigInt(requestedRevision) < BigInt(page.nextBeforeRevision) &&
                  !error
                    ? 'Loading linked revision…'
                    : 'This revision is unavailable in the channel history.'}
                </p>
                <Button variant="outline" onClick={() => chooseRevision(state.resolution.revision)}>
                  Show current revision
                </Button>
              </div>
            )}
          </div>
        ) : (
          <p className="px-4 py-5 text-sm text-muted-foreground">
            {term ? 'No loaded releases match your search.' : 'No release decisions yet.'}
          </p>
        )}
        {page.nextBeforeRevision && (
          <div className="border-t px-4 py-3">
            <Button
              variant="outline"
              disabled={!hydrated || loading}
              onClick={() => void loadMore()}
            >
              {loading ? 'Loading…' : 'Load older releases'}
            </Button>
          </div>
        )}
      </section>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
