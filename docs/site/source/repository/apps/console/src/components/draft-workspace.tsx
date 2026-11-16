import { NativeSelect } from './ui/native-select';
import { FileGlyph, KindBadge, fileDirectory, fileTitle } from './shared';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './ui/dropdown-menu';
import { renameSkillPackage } from '../lib/rename-skill-package';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { compatibilityIssues, DeliveryError, validatePayload } from '@acclimate/sdk/validation';
import {
  freezePending,
  loadPending,
  resolvePending,
  forgetPending,
  type PendingScope,
} from '../lib/pending-operation';
import { draftRequest } from '../lib/content-operation';
import { uniqueSkillName } from '../lib/unique-skill-name';
import type { CompatibilityTarget, BundlePayload, Draft, FileKind } from '@acclimate/sdk';
import type { BundleScope } from '../server/selection';
import { bundleHref } from '../navigation';
import { ConsoleLink } from './console-link';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { usePendingChanges } from './pending-changes';
import { runDraftCommand } from '../server/content-actions';
import type { DraftCommand } from '../server/drafts';
import { ContentDiff } from './diff-content';
import { ImportContent } from './import-content';
import { RelatedPendingNotice, useRelatedPending } from './related-pending';
export function DraftWorkspace({
  published,
  compatibilityTarget = 'generic',
  revision,
  versionId,
  scope,
  commandScope,
  initialDraftId,
  initialPath,
  canEdit = true,
  detailOnly = false,
  onSaved,
  onSelectPath,
}: {
  published: BundlePayload;
  compatibilityTarget?: CompatibilityTarget;
  revision: string;
  versionId: string;
  scope: string;
  commandScope?: BundleScope;
  initialDraftId?: string;
  initialPath?: string;
  canEdit?: boolean;
  detailOnly?: boolean;
  onSaved?: (draft: Draft, path?: string) => void | Promise<void>;
  onSelectPath?: (path: string) => void;
}) {
  const router = useRouter();
  const recoveryScope: PendingScope = {
    actorScope: scope.split(':')[0],
    serviceIdentity: scope.split(':')[0],
    projectId: commandScope?.projectId || '',
    bundleId: commandScope?.bundleId,
    channel: commandScope?.channel,
  };

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function invoke(data: DraftCommand) {
    if (!commandScope) throw new Error('Explicit draft scope is required.');
    return runDraftCommand({ data: { ...data, scope: commandScope } });
  }
  const { setPendingChanges, confirmDiscard, discardVersion } = usePendingChanges();
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [draft, setDraft] = useState<Draft | null>(null),
    [payload, setPayload] = useState(published),
    [saved, setSaved] = useState(published),
    [base, setBase] = useState(published);
  const [index, setIndex] = useState(
      Math.max(
        0,
        published.files.findIndex((file) => file.path === initialPath),
      ),
    ),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [reason, setReason] = useState(''),
    [comparison, setComparison] = useState(''),
    [diff, setDiff] = useState(false),
    [history, setHistory] = useState<string[]>([]);
  const [entryQuery, setEntryQuery] = useState('');
  const [entryKind, setEntryKind] = useState('');
  const [packageName, setPackageName] = useState('');
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [opening, setOpening] = useState(Boolean(initialDraftId));
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // A reload hydrates the published/saved baseline, which can differ from a
  // pending snapshot without being a browser edit. Track user mutation intent
  // separately so deliberately reverting to that baseline still counts.
  const hasLocalPayloadEdits = useRef(false);
  function hydratePayload(next: BundlePayload) {
    hasLocalPayloadEdits.current = false;
    setPayload(next);
  }
  function editPayload(next: BundlePayload) {
    hasLocalPayloadEdits.current = true;
    setPayload(next);
  }
  const related = useRelatedPending(recoveryScope, pending);
  const request = useRef<DraftCommand | null>(null);
  const [newBase, setNewBase] = useState({ versionId, revision });
  const diagnostics = compatibilityIssues(payload, compatibilityTarget);
  const dirty = JSON.stringify(payload) !== JSON.stringify(saved);
  const lastDiscardVersion = useRef(discardVersion);
  useEffect(() => {
    if (lastDiscardVersion.current === discardVersion) return;
    lastDiscardVersion.current = discardVersion;
    hydratePayload(saved);
    setIndex(0);
  }, [discardVersion, saved]);
  useEffect(() => {
    if (!draft && !dirty && !pending) {
      hydratePayload(published);
      setSaved(published);
      setBase(published);
      setNewBase({ versionId, revision });
      setIndex(
        Math.max(
          0,
          published.files.findIndex((file) => file.path === initialPath),
        ),
      );
    }
  }, [published, versionId, revision, draft, dirty, pending]);
  const active = canEdit && !related.blocked && (!draft || draft.status === 'open');
  const refresh = useCallback(async (next?: string) => {
    try {
      const r = await invoke({ action: 'list', cursor: next });
      if (r.ok && r.page) {
        setDrafts((previous) => (next ? [...previous, ...r.page!.items] : r.page!.items));
        setCursor(r.page.nextCursor);
      } else if (!r.ok) setMessage(r.message);
    } catch {
      setMessage('Could not list saved drafts. Retry when the connection is available.');
    }
  }, []);
  useEffect(() => {
    if (!detailOnly) void refresh();
    try {
      const stored = loadPending(sessionStorage, recoveryScope);
      if (stored) {
        setPending(stored.key);
        request.current = stored.body
          ? { action: 'retry', key: stored.key, operationPath: stored.action, body: stored.body }
          : null;
      } else setPending(localStorage.getItem('acclimate:pending:' + scope));
    } catch {}
  }, [scope, refresh]);
  useEffect(() => {
    setPendingChanges(dirty);
    return () => setPendingChanges(false);
  }, [dirty, setPendingChanges]);
  async function open(id: string) {
    setBusy(true);
    try {
      const r = await invoke({ action: 'open', id });
      if (r.ok && r.payload && r.draft && r.base) {
        setDraft(r.draft);
        hydratePayload(r.payload);
        setSaved(r.payload);
        setBase(r.base);
        setIndex(
          Math.max(
            0,
            r.payload.files.findIndex((file) => file.path === initialPath),
          ),
        );
        setMessage('Opened verified saved snapshot.');
        const h = await invoke({ action: 'history', id });
        if (h.ok && h.history) {
          setHistory(h.history.items.map((s) => `Generation ${s.generation}: ${s.version.id}`));
          setHistoryCursor(h.history.nextCursor);
        }
      } else if (!r.ok) setMessage(r.message);
    } catch {
      setMessage('Could not open draft. Your current edits are still here.');
    } finally {
      setBusy(false);
      setOpening(false);
    }
  }
  useEffect(() => {
    if (initialDraftId && initialDraftId !== draft?.id) {
      setOpening(true);
      void open(initialDraftId);
    }
  }, [initialDraftId]);
  useEffect(() => {
    if (initialPath) {
      const selected = payload.files.findIndex((file) => file.path === initialPath);
      if (selected >= 0) setIndex(selected);
    }
  }, [initialPath]);
  async function savedNavigation(savedDraft: Draft, path?: string): Promise<boolean> {
    if (!onSaved || !mounted.current) return false;
    try {
      await onSaved(savedDraft, path);
      // A new identity remounts this editor. Never re-enable the old text area
      // between navigation completion and React committing that replacement.
      return (
        savedDraft.id !== initialDraftId &&
        (router.state.location.search as Record<string, unknown>).draft === savedDraft.id
      );
    } catch {
      setMessage(
        'Save confirmed, but its page could not open. Reopen the saved draft from Changes.',
      );
      return false;
    }
  }
  async function command(data: DraftCommand) {
    const replayingUncertain = data.action === 'retry' || Boolean(pending);
    if (data.action === 'create' || data.action === 'save') {
      try {
        validatePayload(data.payload);
      } catch (error) {
        const message = error instanceof DeliveryError ? error.message : 'Check the draft content.';
        setMessage(message);
        toast.error('Draft could not be saved.', { description: message });
        return;
      }
    }
    let handoff = false;
    setBusy(true);
    setMessage('');
    if (data.action === 'retry') {
      try {
        const stored = loadPending(sessionStorage, recoveryScope);
        if (!stored?.body) {
          request.current = null;
          setMessage(
            'Submitted text was forgotten or expired. Check the result or close this operation before another write.',
          );
          setBusy(false);
          return;
        }
      } catch {
        setMessage('Recovery data could not be read. Check the result before another write.');
        setBusy(false);
        return;
      }
    }
    if ('key' in data && data.action !== 'discard') {
      try {
        if (!commandScope) throw Error('Explicit scope required.');
        const wire = data.action === 'retry' ? data : draftRequest(data, commandScope);
        const frozen = freezePending(
          sessionStorage,
          recoveryScope,
          wire.operationPath,
          JSON.parse(wire.body),
          data.key,
        );
        request.current = {
          action: 'retry',
          key: frozen.key,
          operationPath: frozen.action,
          body: frozen.body!,
        };
        setPending(data.key);
        // Keep fresh submissions distinguishable from recovery replays. The
        // frozen exact bytes are still retained for an unknown outcome.
        if (data.action === 'retry') data = request.current;
      } catch {
        setMessage(
          'Cannot persist the exact submitted request. Enable browser session storage and resolve any earlier operation before saving.',
        );
        setBusy(false);
        return;
      }
    }
    try {
      const r = await invoke(data);
      if (r.ok && r.draft) {
        setDraft(r.draft);
        const submitted =
          data.action === 'retry'
            ? (JSON.parse(data.body).payload as BundlePayload | undefined)
            : 'payload' in data
              ? data.payload
              : undefined;
        const laterEdits = Boolean(
          hasLocalPayloadEdits.current &&
            submitted &&
            JSON.stringify(payload) !== JSON.stringify(submitted),
        );
        if (submitted) {
          setSaved(submitted);
          if (!laterEdits) hydratePayload(submitted);
        }
        setHistory((previous) => [
          ...previous,
          `Generation ${r.draft.generation}: ${r.draft.snapshotVersion.id}`,
        ]);
        setMessage(
          `Confirmed ${data.action}. Generation ${r.draft.generation}, snapshot ${r.draft.snapshotVersion.id}.`,
        );
        resolvePending(sessionStorage, recoveryScope);
        localStorage.removeItem('acclimate:pending:' + scope);
        setPending(null);
        request.current = null;
        if (!detailOnly) await refresh();
        if (data.action === 'retry' || data.action === 'create' || data.action === 'save')
          toast.success('Draft snapshot saved.', {
            description: `Generation ${r.draft.generation}`,
          });
        if (mounted.current && !laterEdits)
          handoff = await savedNavigation(r.draft, payload.files[index]?.path);
        if (laterEdits) setMessage('Save confirmed. Your later browser edits are preserved.');
        if (r.draft.status === 'published') await router.invalidate();
      } else if (!r.ok) {
        setMessage(r.message);
        if (!replayingUncertain && !('uncertain' in r && r.uncertain)) {
          resolvePending(sessionStorage, recoveryScope);
          localStorage.removeItem('acclimate:pending:' + scope);
          setPending(null);
          request.current = null;
        }
      }
    } catch {
      setMessage(
        'Outcome unknown. Recover the operation before another write. Your text remains in this tab.',
      );
    } finally {
      if (mounted.current && !handoff) setBusy(false);
    }
  }
  async function recover(): Promise<boolean> {
    if (!pending) return false;
    let handoff = false;
    setBusy(true);
    try {
      const r = await invoke({
        action: 'recover',
        key: pending,
        operationPath:
          request.current?.action === 'retry'
            ? request.current.operationPath
            : loadPending(sessionStorage, recoveryScope)?.action,
      });
      if (r.ok && r.operation) {
        setMessage(
          r.operation.status === 'not_observed'
            ? 'No committed result observed yet. Keep this operation pending; check again or retry the exact submitted request when its text is available.'
            : 'Operation result confirmed.',
        );
        if (r.operation.status === 'closed') {
          resolvePending(sessionStorage, recoveryScope);
          localStorage.removeItem('acclimate:pending:' + scope);
          setPending(null);
          request.current = null;
          setMessage('Operation closed. Review your current edits before a new save.');
        }
        if (r.operation.status === 'committed') {
          resolvePending(sessionStorage, recoveryScope);
          localStorage.removeItem('acclimate:pending:' + scope);
          setPending(null);
          request.current = null;
          if (!detailOnly) await refresh();
          if ('snapshotVersion' in r.operation.result) {
            const recovered = await invoke({ action: 'open', id: String(r.operation.result.id) });
            if (recovered.ok && recovered.draft && recovered.payload && recovered.base) {
              setDraft(recovered.draft);
              setSaved(recovered.payload);
              setBase(recovered.base);
              // Only actual browser edits can supersede the committed text.
              // This includes deliberate reversion, even when `dirty` is false.
              const laterEdits =
                hasLocalPayloadEdits.current &&
                JSON.stringify(payload) !== JSON.stringify(recovered.payload);
              if (!laterEdits) hydratePayload(recovered.payload);
              if (!laterEdits)
                if (mounted.current)
                  handoff = await savedNavigation(
                    recovered.draft,
                    recovered.payload.files[index]?.path,
                  );
              setMessage(
                laterEdits
                  ? 'Save confirmed. Your later browser edits are preserved.'
                  : 'Save confirmed and saved snapshot reopened.',
              );
            } else if (!recovered.ok) setMessage(recovered.message);
          }
        }
      } else if (!r.ok) setMessage(r.message);
    } catch {
      setMessage('Recovery unavailable. Keep the operation ID and retry later.');
    } finally {
      if (mounted.current && !handoff) setBusy(false);
    }
    return handoff;
  }
  function update(field: 'path' | 'text' | 'kind', value: string) {
    editPayload({
      ...payload,
      files: payload.files.map((f, i) => (i === index ? { ...f, [field]: value } : f)),
    });
  }
  function add(kind: FileKind) {
    const name =
      kind === 'skill' ? uniqueSkillName(payload.files) : `new-${payload.files.length + 1}`;
    const file =
      kind === 'skill'
        ? {
            kind,
            path: `skills/${name}/SKILL.md`,
            text: `---\nname: ${name}\ndescription: Describe when to use this skill.\n---\n\n# ${name}\n`,
          }
        : { kind, path: `${kind === 'memory' ? 'memory' : 'instructions'}/${name}.md`, text: '' };
    editPayload({ ...payload, files: [...payload.files, file] });
    setIndex(payload.files.length);
  }
  const file = payload.files[index];
  const visibleFiles = payload.files
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(
      ({ entry }) =>
        (!entryKind || entry.kind === entryKind) &&
        entry.path.toLowerCase().includes(entryQuery.toLowerCase()),
    );
  useEffect(() => setPackageName(''), [index, file?.path]);
  if (initialDraftId && !draft)
    return (
      <section className="workspace-panel p-4" role="status">
        {opening
          ? 'Opening saved draft…'
          : message || 'Draft unavailable. Refresh or return to Changes.'}
      </section>
    );
  return (
    <section className="space-y-4">
      {commandScope && (
        <RelatedPendingNotice recovery={related} scope={commandScope} canEdit={canEdit} />
      )}
      {!detailOnly && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">Durable drafts</h2>
            <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
              Refresh drafts
            </Button>
            {cursor && (
              <Button variant="outline" disabled={busy} onClick={() => void refresh(cursor)}>
                Load more drafts
              </Button>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                confirmDiscard(() => {
                  setDraft(null);
                  setNewBase({ versionId, revision });
                  hydratePayload(published);
                  setSaved(published);
                  setBase(published);
                  setHistory([]);
                  setIndex(0);
                })
              }
            >
              New draft from current release
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {drafts.map((d) => (
              <Button
                key={d.id}
                variant={draft?.id === d.id ? 'default' : 'outline'}
                disabled={busy}
                onClick={() => confirmDiscard(() => void open(d.id))}
              >
                Open {d.id.slice(0, 8)} · generation {d.generation} · {d.status}
              </Button>
            ))}
            {!drafts.length && (
              <p className="text-muted-foreground">No saved drafts in this channel.</p>
            )}
          </div>
        </>
      )}
      {pending && (
        <div
          role="status"
          className="space-y-3 rounded-md border border-amber-500/50 bg-amber-500/5 p-4"
        >
          <h2 className="font-semibold">
            {busy ? 'Waiting for submission confirmation…' : 'Submission needs confirmation'}
          </h2>
          <p className="text-muted-foreground">
            Check the result before submitting again. Your browser edits are preserved.
          </p>
          <Button disabled={busy} onClick={() => void recover()}>
            Check result
          </Button>
          <details className="space-y-3">
            <summary>Draft recovery details</summary>
            <p className="break-all text-sm">
              Unresolved operation: {pending}. A missing outcome does not establish failure.
            </p>
            <p className="text-sm text-muted-foreground">
              Closing preserves a committed result. Forgetting submitted text does not cancel
              submission; another write remains blocked until the outcome is resolved or the
              operation is closed.
            </p>
            {request.current?.action === 'retry' && (
              <pre
                className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-sm"
                aria-label="Exact submitted draft request"
              >
                {request.current.body}
              </pre>
            )}
            {!request.current && (
              <p className="text-sm">Submitted text is unavailable. Exact retry is unavailable.</p>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                let handoff = false;
                setBusy(true);
                try {
                  const record = loadPending(sessionStorage, recoveryScope);
                  const result = await invoke({
                    action: 'close',
                    key: pending,
                    operationPath: record?.action,
                  });
                  if (result.ok && result.operation?.status === 'committed') {
                    handoff = await recover();
                  } else if (result.ok && result.operation?.status === 'closed') {
                    resolvePending(sessionStorage, recoveryScope);
                    localStorage.removeItem('acclimate:pending:' + scope);
                    setPending(null);
                    request.current = null;
                    setMessage(
                      'Operation closed. Older expired legacy writes may remain unprovable. Review a new request.',
                    );
                  } else if (!result.ok) setMessage(result.message);
                } catch {
                  setMessage(
                    'Close outcome unknown. Keep this operation pending and retry reconciliation.',
                  );
                } finally {
                  if (mounted.current && !handoff) setBusy(false);
                }
              }}
            >
              Close unresolved operation
            </Button>
            {request.current && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  forgetPending(sessionStorage, recoveryScope);
                  request.current = null;
                  setMessage(
                    'Submitted text forgotten. Close or reconcile the operation before another write.',
                  );
                }}
              >
                Forget submitted text
              </Button>
            )}
            {request.current && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void command(request.current!)}
              >
                Retry exact request
              </Button>
            )}
          </details>
        </div>
      )}
      <header className="workspace-panel space-y-4 p-4">
        <ol
          aria-label="Change workflow"
          className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
        >
          <li aria-current="step">
            <Badge>1. Edit draft</Badge>
          </li>
          <li aria-hidden="true">→</li>
          <li>2. Evaluate</li>
          <li aria-hidden="true">→</li>
          <li>3. Publish</li>
        </ol>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h2 className="text-lg font-semibold">
              {draft ? 'Edit draft' : 'New draft'}
              {!canEdit && ' · Read only'}
            </h2>
            <p className="text-sm text-muted-foreground" role="status">
              {pending
                ? 'Submission unconfirmed. Check its result to continue.'
                : draft && draft.status !== 'open'
                  ? `This draft is ${draft.status}.`
                  : dirty
                    ? 'Unsaved changes. Save before evaluating or publishing.'
                    : draft
                      ? `Generation ${draft.generation} saved. Ready to evaluate.`
                      : 'Edit your content, then save a draft.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={draft && !dirty ? 'outline' : 'default'}
              disabled={busy || !active || Boolean(pending) || (!dirty && Boolean(draft))}
              onClick={() =>
                void command(
                  draft
                    ? {
                        action: 'save',
                        id: draft.id,
                        expectedGeneration: draft.generation,
                        payload,
                        key: crypto.randomUUID(),
                      }
                    : {
                        action: 'create',
                        baseVersionId: newBase.versionId,
                        baseRevision: newBase.revision,
                        payload,
                        key: crypto.randomUUID(),
                      },
                )
              }
            >
              {busy ? 'Working…' : 'Save draft'}
            </Button>
            {draft && (
              <Button
                variant="ghost"
                disabled={busy || Boolean(pending) || related.blocked}
                onClick={() => confirmDiscard(() => void open(draft.id))}
              >
                Reload saved draft
              </Button>
            )}
            {draft && commandScope && !pending && (
              <Button asChild variant={draft.status === 'open' ? 'default' : 'outline'}>
                <ConsoleLink
                  href={bundleHref(commandScope, 'changes', {
                    draft: draft.id,
                    candidate: draft.snapshotVersion.id,
                    generation: draft.generation,
                    path: file?.path,
                  })}
                >
                  {draft.status === 'open' ? 'Continue to evaluation' : 'View saved change'}
                </ConsoleLink>
              </Button>
            )}
          </div>
        </div>
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Draft details</summary>
          <dl className="mt-3 space-y-2 break-all">
            {draft && (
              <div>
                <dt>Draft</dt>
                <dd>
                  {draft.id} · {draft.status} · generation {draft.generation}
                </dd>
              </div>
            )}
            <div>
              <dt>Base revision</dt>
              <dd>{draft?.baseRevision || newBase.revision}</dd>
            </div>
            {draft && (
              <div>
                <dt>Saved snapshot</dt>
                <dd>{draft.snapshotVersion.id}</dd>
              </div>
            )}
            <div>
              <dt>Compatibility target</dt>
              <dd>
                {compatibilityTarget}
                {compatibilityTarget === 'generic' ? ' · Native compatibility unchecked' : ''}
              </dd>
            </div>
          </dl>
          <p className="mt-2">Saving keeps work separate from the published release.</p>
        </details>
      </header>
      {message && (
        <p role="status" className="break-words rounded-md border p-4">
          {message}
        </p>
      )}
      {diagnostics.length > 0 && (
        <div role="status">
          <p>
            Native compatibility needs repair before publication. Draft snapshots can still be
            saved.
          </p>
          <ul>
            {diagnostics.map((issue, i) => (
              <li key={i}>
                {issue.path || issue.package || issue.code}: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!draft && newBase.revision !== revision && (
        <p role="alert">
          The release changed while you were editing. Your edits still belong to revision{' '}
          {newBase.revision}. Start from the current release and reapply them before saving.
        </p>
      )}
      {draft && draft.baseRevision !== revision && (
        <p role="alert">
          The published channel changed. This draft is preserved, but cannot be published against
          its old base.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" disabled={busy || !active}>
              Add entry
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              className="min-h-8 text-sm"
              onSelect={() => {
                setEntryQuery('');
                setEntryKind('');
                add('instruction');
              }}
            >
              Add instruction
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-8 text-sm"
              onSelect={() => {
                setEntryQuery('');
                setEntryKind('');
                add('skill');
              }}
            >
              Add skill package
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-8 text-sm"
              onSelect={() => {
                setEntryQuery('');
                setEntryKind('');
                add('memory');
              }}
            >
              Add shared memory
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" onClick={() => setDiff(!diff)}>
          {diff ? 'Edit entries' : 'Review changes'}
        </Button>
      </div>
      {diff ? (
        <ContentDiff base={base} current={payload} />
      ) : (
        <div className="content-workspace" data-testid="draft-file-browser">
          <aside className="content-file-sidebar">
            <div className="space-y-3 p-4">
              <Label htmlFor="draft-search">Find an entry</Label>
              <Input
                id="draft-search"
                type="search"
                value={entryQuery}
                onChange={(e) => setEntryQuery(e.target.value)}
                placeholder="Search files…"
              />
              <Label htmlFor="draft-entry-filter">Entry type</Label>
              <NativeSelect
                id="draft-entry-filter"
                value={entryKind}
                onChange={(e) => setEntryKind(e.target.value)}
              >
                <option value="">All types</option>
                <option value="instruction">Instructions</option>
                <option value="skill">Skills</option>
                <option value="memory">Memory</option>
              </NativeSelect>
              {(entryQuery || entryKind) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEntryQuery('');
                    setEntryKind('');
                  }}
                >
                  Clear filters
                </Button>
              )}
              <p className="text-sm text-muted-foreground">
                {visibleFiles.length} {visibleFiles.length === 1 ? 'entry' : 'entries'}
              </p>
            </div>
            <div className="content-file-buttons">
              {visibleFiles.map(({ entry, entryIndex }) => (
                <Button
                  className={`content-file-button ${entryIndex === index ? 'is-selected' : ''}`}
                  variant="ghost"
                  key={entryIndex}
                  disabled={busy}
                  aria-label={`Open ${entry.path || '(unnamed)'}`}
                  aria-pressed={entryIndex === index}
                  onClick={() => {
                    setIndex(entryIndex);
                    onSelectPath?.(entry.path);
                  }}
                >
                  <FileGlyph kind={entry.kind} />
                  <span className="min-w-0 flex-1">
                    <strong className="block break-words text-sm font-medium">
                      {fileTitle(entry) || '(unnamed)'}
                    </strong>
                    <span className="block break-all text-sm text-muted-foreground">
                      {fileDirectory(entry)}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
            {!visibleFiles.length && (
              <p className="p-4 text-sm text-muted-foreground">
                {payload.files.length
                  ? 'No matching entries. Clear filters to see all entries.'
                  : active
                    ? 'No entries yet. Use Add entry to begin.'
                    : 'This saved draft has no entries.'}
              </p>
            )}
          </aside>
          <div className="content-detail">
            {file ? (
              <>
                <header className="content-entry-heading">
                  <div className="flex min-w-0 items-start gap-3">
                    <FileGlyph kind={file.kind} />
                    <div className="min-w-0">
                      <h3 className="break-words text-lg font-semibold">
                        {fileTitle(file) || '(unnamed)'}
                      </h3>
                      <p className="break-all font-mono text-sm text-muted-foreground">
                        {file.path}
                      </p>
                    </div>
                  </div>
                  <KindBadge kind={file.kind} />
                </header>
                <div className="space-y-3 p-4">
                  <details className="space-y-3">
                    <summary className="text-sm font-medium">
                      Entry settings · Rename or remove
                    </summary>
                    <Label htmlFor="draft-path">Entry path (rename)</Label>
                    <Input
                      id="draft-path"
                      value={file.path}
                      disabled={busy || !active}
                      onChange={(e) => update('path', e.target.value)}
                    />
                    <Label htmlFor="draft-kind">Entry kind</Label>
                    <NativeSelect
                      id="draft-kind"
                      className="w-full"
                      value={file.kind}
                      disabled={busy || !active}
                      onChange={(e) => update('kind', e.target.value)}
                    >
                      <option value="instruction">Instruction</option>
                      <option value="skill">Skill</option>
                      <option value="memory">Shared memory</option>
                    </NativeSelect>
                    {file.kind === 'skill' && (
                      <>
                        <Button
                          variant="outline"
                          disabled={busy || !active}
                          onClick={() => {
                            editPayload({
                              ...payload,
                              files: [
                                ...payload.files,
                                {
                                  kind: 'skill',
                                  path: `skills/${file.path.split('/')[1]}/references/new-${payload.files.length}.md`,
                                  text: '',
                                },
                              ],
                            });
                            setIndex(payload.files.length);
                          }}
                        >
                          Add skill support file
                        </Button>
                        <Label htmlFor="skill-name">Rename entire skill package</Label>
                        <div className="flex flex-wrap gap-2">
                          <Input
                            id="skill-name"
                            className="min-w-0 flex-1"
                            placeholder="new-skill-name"
                            value={packageName}
                            onChange={(e) => setPackageName(e.target.value)}
                            disabled={busy || !active}
                          />
                          <Button
                            variant="outline"
                            disabled={busy || !active || !packageName.trim()}
                            onClick={() => {
                              try {
                                editPayload(
                                  renameSkillPackage(payload, file.path.split('/')[1], packageName),
                                );
                                setPackageName('');
                              } catch (error) {
                                setMessage(
                                  error instanceof Error
                                    ? error.message
                                    : 'Could not rename skill package.',
                                );
                              }
                            }}
                          >
                            Apply package rename
                          </Button>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Applies the package path and manifest name to all its files in browser
                          edits.
                        </p>
                      </>
                    )}
                    <Button
                      variant="outline"
                      disabled={busy || !active}
                      onClick={() => {
                        const prefix =
                          file.kind === 'skill'
                            ? file.path.split('/').slice(0, 2).join('/') + '/'
                            : null;
                        editPayload({
                          ...payload,
                          files: payload.files.filter((f, i) =>
                            prefix ? !f.path.startsWith(prefix) : i !== index,
                          ),
                        });
                        setIndex(0);
                      }}
                    >
                      Remove {file.kind === 'skill' ? 'skill package' : 'entry'}
                    </Button>
                  </details>
                  <Label htmlFor="draft-text" className="block">
                    Content
                  </Label>
                  <Textarea
                    id="draft-text"
                    className="min-h-[360px] font-mono"
                    value={file.text}
                    disabled={busy || !active}
                    onChange={(e) => update('text', e.target.value)}
                  />
                </div>
              </>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                {active ? 'Add an entry to start editing.' : 'No entry selected.'}
              </p>
            )}
          </div>
        </div>
      )}
      <details className="workspace-panel p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Import files into this draft
        </summary>
        <div className="mt-4">
          <ImportContent
            compatibilityTarget={compatibilityTarget}
            payload={payload}
            onApply={editPayload}
            disabled={busy || !active}
            commandScope={commandScope}
          />
        </div>
      </details>
      {draft && (
        <>
          <details>
            <summary>Saved snapshot history</summary>
            <ul>
              {history.map((h) => (
                <li className="break-all" key={h}>
                  {h}
                </li>
              ))}
            </ul>
            {historyCursor && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await invoke({
                      action: 'history',
                      id: draft.id,
                      cursor: historyCursor,
                    });
                    if (result.ok && result.history) {
                      setHistory((previous) => [
                        ...previous,
                        ...result.history!.items.map(
                          (item) => `Generation ${item.generation}: ${item.version.id}`,
                        ),
                      ]);
                      setHistoryCursor(result.history.nextCursor);
                    } else if (!result.ok) setMessage(result.message);
                  } catch {
                    setMessage('Could not read older saved snapshots.');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Load more snapshots
              </Button>
            )}
          </details>
          {!detailOnly && (
            <div className="space-y-3 rounded-md border p-4">
              <h3 className="font-medium">Publish reviewed snapshot</h3>
              <p>
                Publishing updates this channel. Memory still requires explicit approval at
                delivery.
              </p>
              <Label htmlFor="draft-reason">
                Manual publication reason (no evaluation claimed)
              </Label>
              <Input
                id="draft-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
              />
              <Label htmlFor="draft-comparison">Or matching comparison ID</Label>
              <Input
                id="draft-comparison"
                value={comparison}
                onChange={(e) => setComparison(e.target.value)}
                disabled={busy}
              />
              <Button
                disabled={
                  busy ||
                  dirty ||
                  Boolean(pending) ||
                  !active ||
                  (!reason.trim() && !comparison.trim()) ||
                  diagnostics.length > 0 ||
                  draft.baseRevision !== revision
                }
                onClick={() =>
                  void command({
                    action: 'publish',
                    id: draft.id,
                    expectedGeneration: draft.generation,
                    expectedRevision: revision,
                    key: crypto.randomUUID(),
                    ...(comparison.trim()
                      ? { comparisonId: comparison.trim() }
                      : { unevaluatedReason: reason.trim() }),
                  })
                }
              >
                Publish saved snapshot
              </Button>
              <Button
                variant="outline"
                disabled={busy || Boolean(pending) || !active}
                onClick={() =>
                  confirmDiscard(
                    () =>
                      void command({
                        action: 'discard',
                        id: draft.id,
                        expectedGeneration: draft.generation,
                        key: crypto.randomUUID(),
                      }),
                  )
                }
              >
                Discard saved draft
              </Button>
            </div>
          )}
          {detailOnly && commandScope && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Discard draft</summary>
              <p className="my-3 text-muted-foreground">
                Discard this saved draft and any browser edits. The published release stays as it
                is.
              </p>
              {active && (
                <Button
                  variant="outline"
                  disabled={busy || Boolean(pending)}
                  onClick={() =>
                    confirmDiscard(
                      () =>
                        void command({
                          action: 'discard',
                          id: draft.id,
                          expectedGeneration: draft.generation,
                          key: crypto.randomUUID(),
                        }),
                    )
                  }
                >
                  Discard saved draft
                </Button>
              )}
            </details>
          )}
        </>
      )}
    </section>
  );
}
