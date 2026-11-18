import './source-editor.css';
import './draft-studio.css';
import { artifactChanges } from '../lib/artifact-changes';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import { NativeSelect } from './ui/native-select';
import { Info, Plus, GitCompareArrows, GitBranch } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { CodeEditor, type CodeEditorHandle } from './code-editor';
import { SyntaxCode } from './syntax-code';
import { FileNavigator } from './file-navigator';
import { FileTree } from './file-tree';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import { FileGlyph, KindBadge, PathText, fileTitle } from './shared';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from './ui/dropdown-menu';
import { renameSkillPackage } from '../lib/rename-skill-package';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { compatibilityIssues, DeliveryError, validatePayload } from '@acclimate/sdk/validation';
import {
  freezePendingExact,
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
import { Input } from './ui/input';
import { Label } from './ui/label';
import { usePendingChanges } from './pending-changes';
import { runDraftCommand } from '../server/content-actions';
import type { DraftCommand } from '../server/drafts';
import { ContentDiff } from './diff-content';
import { ImportContent } from './import-content';
import { RelatedPendingNotice, useRelatedPending } from './related-pending';
import { DraftDiscardDialog } from './draft-discard-dialog';
function draftEntryIndex(payload: BundlePayload, path?: string) {
  return path ? payload.files.findIndex((file) => file.path === path) : 0;
}

export function DraftWorkspace({
  published,
  compatibilityTarget = 'generic',
  revision,
  versionId,
  scope,
  commandScope,
  actorScope,
  serviceIdentity,
  initialDraftId,
  initialPath,
  canEdit = true,
  detailOnly = false,
  onSaved,
  onSelectPath,
  focusOnOpen = false,
  onOpenFocusHandled,
}: {
  published: BundlePayload;
  compatibilityTarget?: CompatibilityTarget;
  revision: string;
  versionId: string;
  scope: string;
  commandScope: BundleScope;
  actorScope: string;
  serviceIdentity: string;
  initialDraftId?: string;
  initialPath?: string;
  canEdit?: boolean;
  detailOnly?: boolean;
  onSaved?: (draft: Draft, path?: string) => void | Promise<void>;
  onSelectPath?: (path: string) => void;
  focusOnOpen?: boolean;
  onOpenFocusHandled?: () => void;
}) {
  const router = useRouter();
  const recoveryScope: PendingScope = {
    ...commandScope,
    owner: 'draft',
    actorScope,
    serviceIdentity,
  };

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function invoke(data: DraftCommand) {
    return runDraftCommand({ data: { ...data, scope: commandScope } });
  }
  const { setPendingChanges, confirmDiscard, discardVersion } = usePendingChanges();
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [draft, setDraft] = useState<Draft | null>(null),
    [payload, setPayload] = useState(published),
    [saved, setSaved] = useState(published),
    [base, setBase] = useState(published);
  const requestedPath = useRef(initialPath);
  requestedPath.current = initialPath;
  const [index, setIndex] = useState(() => draftEntryIndex(published, initialPath)),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [reason, setReason] = useState(''),
    [comparison, setComparison] = useState(''),
    [diff, setDiff] = useState(false),
    [history, setHistory] = useState<string[]>([]);
  const [entryQuery, setEntryQuery] = useState('');
  const [reviewBase, setReviewBase] = useState<'creation' | 'saved'>('creation');
  const reviewScope = useRef<HTMLSelectElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const editorHandle = useRef<CodeEditorHandle>(null);
  const returnToEditor = useRef(false);
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const [packageName, setPackageName] = useState('');
  const [entryError, setEntryError] = useState('');
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [opening, setOpening] = useState(Boolean(initialDraftId));
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<{
    id: string;
    generation: number;
    key: string;
  } | null>(null);
  const [discardError, setDiscardError] = useState('');
  const discardTrigger = useRef<HTMLElement | null>(null);
  const draftHeading = useRef<HTMLHeadingElement>(null);
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
  const saveAction = useRef<HTMLButtonElement>(null);
  const toolbarActions = useRef<HTMLDivElement>(null);
  const saveOwnsFocus = useRef(false);
  const openFocusHandled = useRef(false);
  useEffect(() => {
    const releaseFocus = (event: Event) => {
      if (event.target !== saveAction.current && event.target !== document.body)
        saveOwnsFocus.current = false;
    };
    const releaseOnPointer = (event: PointerEvent) => {
      if (!saveAction.current?.contains(event.target as Node)) saveOwnsFocus.current = false;
    };
    document.addEventListener('focusin', releaseFocus);
    document.addEventListener('pointerdown', releaseOnPointer);
    return () => {
      document.removeEventListener('focusin', releaseFocus);
      document.removeEventListener('pointerdown', releaseOnPointer);
    };
  }, []);
  useLayoutEffect(() => {
    const opening = focusOnOpen && !openFocusHandled.current;
    if (busy || !draft || dirty || (!saveOwnsFocus.current && !opening)) return;
    const current = document.activeElement;
    if (
      current === saveAction.current ||
      current === document.body ||
      (opening && current?.id === 'main')
    ) {
      // Save becomes disabled (and is replaced on mobile). Only carry its own
      // focus to the next action; a user who moved elsewhere keeps that focus.
      toolbarActions.current?.querySelector<HTMLAnchorElement>('.draft-evaluation-action')?.focus();
    }
    saveOwnsFocus.current = false;
    if (opening) {
      openFocusHandled.current = true;
      onOpenFocusHandled?.();
    }
  }, [busy, dirty, draft, focusOnOpen, onOpenFocusHandled]);
  const lastDiscardVersion = useRef(discardVersion);
  useEffect(() => {
    if (lastDiscardVersion.current === discardVersion) return;
    lastDiscardVersion.current = discardVersion;
    hydratePayload(saved);
    setIndex(0);
  }, [discardVersion, saved]);
  useEffect(() => {
    // Reverting to the old baseline still carries local edit intent. In
    // particular, recovery can clear `pending` before its verified open returns.
    if (!draft && !dirty && !pending && !hasLocalPayloadEdits.current) {
      hydratePayload(published);
      setSaved(published);
      setBase(published);
      setNewBase({ versionId, revision });
      setIndex(draftEntryIndex(published, requestedPath.current));
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
      } else setPending(null);
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
        setIndex(draftEntryIndex(r.payload, requestedPath.current));
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
    setIndex(draftEntryIndex(payload, initialPath));
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
  function confirmSavedDiscard(target: Draft, trigger: HTMLElement) {
    discardTrigger.current = trigger;
    setDiscardError('');
    setDiscardTarget({ id: target.id, generation: target.generation, key: crypto.randomUUID() });
  }
  function discarded(result: Draft, preserveEdits = false) {
    setDraft(result);
    if (!preserveEdits) {
      hydratePayload(saved);
      setPendingChanges(false);
    }
    setMessage(
      `Discarded draft ${result.id}, generation ${result.generation}. The published release is unchanged.`,
    );
    toast.success('Saved draft discarded.');
  }
  async function command(data: DraftCommand): Promise<boolean> {
    const replayingUncertain = data.action === 'retry' || Boolean(pending);
    if (data.action === 'create' || data.action === 'save') {
      try {
        validatePayload(data.payload);
      } catch (error) {
        const message = error instanceof DeliveryError ? error.message : 'Check the draft content.';
        setMessage(message);
        toast.error('Draft could not be saved.', { description: message });
        return false;
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
          return false;
        }
      } catch {
        setMessage('Recovery data could not be read. Check the result before another write.');
        setBusy(false);
        return false;
      }
    }
    if ('key' in data) {
      try {
        const wire = data.action === 'retry' ? data : draftRequest(data, commandScope);
        const frozen = freezePendingExact(
          sessionStorage,
          recoveryScope,
          wire.operationPath,
          wire.body,
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
        const error =
          'Cannot persist the exact submitted request. Enable browser session storage and resolve any earlier operation before another write.';
        setMessage(error);
        if (data.action === 'discard') setDiscardError(error);
        setBusy(false);
        return false;
      }
    }
    try {
      const r = await invoke(data);
      if (r.ok && r.draft) {
        if (r.draft.status === 'discarded') {
          discarded(r.draft, data.action === 'retry' && hasLocalPayloadEdits.current);
          resolvePending(sessionStorage, recoveryScope);
          setPending(null);
          request.current = null;
          if (!detailOnly) await refresh();
          return true;
        }
        if (data.action === 'discard') {
          setDiscardError(
            'The service did not confirm the draft was discarded. Check the operation result before another write.',
          );
          return false;
        }
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
        return true;
      } else if (!r.ok) {
        setMessage(r.message);
        if (data.action === 'discard') setDiscardError(r.message);
        if (!replayingUncertain && !('uncertain' in r && r.uncertain)) {
          resolvePending(sessionStorage, recoveryScope);
          setPending(null);
          request.current = null;
        }
      }
    } catch {
      const error =
        'Outcome unknown. Recover the operation before another write. Your text remains in this tab.';
      setMessage(error);
      if (data.action === 'discard') setDiscardError(error);
    } finally {
      if (mounted.current && !handoff) setBusy(false);
    }
    return false;
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
          setPending(null);
          request.current = null;
          setMessage('Operation closed. Review your current edits before a new save.');
        }
        if (r.operation.status === 'committed') {
          resolvePending(sessionStorage, recoveryScope);
          setPending(null);
          request.current = null;
          if (!detailOnly) await refresh();
          if (
            'snapshotVersion' in r.operation.result &&
            r.operation.result.status === 'discarded'
          ) {
            discarded(r.operation.result as Draft, hasLocalPayloadEdits.current);
          } else if ('snapshotVersion' in r.operation.result) {
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
  const workingChanges = useMemo(() => artifactChanges(saved, payload), [saved, payload]);
  const draftChanges = useMemo(() => artifactChanges(base, payload), [base, payload]);
  const savedBaseline = Boolean(draft) && reviewBase === 'saved';
  const reviewChanges = savedBaseline ? workingChanges : draftChanges;
  const reviewChange =
    reviewPath === null ? undefined : reviewChanges.find((change) => change.path === reviewPath);
  const baselineName = savedBaseline
    ? `Generation ${draft!.generation}`
    : `Revision ${draft?.baseRevision ?? newBase.revision}`;
  const currentChange = file && workingChanges.find((change) => change.path === file.path);
  const workingOperations = useMemo(
    () => new Map(workingChanges.map((change) => [change.path, change.operation])),
    [workingChanges],
  );
  useLayoutEffect(() => {
    if (diff) reviewHeading.current?.focus();
    else if (returnToEditor.current) {
      returnToEditor.current = false;
      editorHandle.current?.focus();
    }
  }, [diff]);

  function toggleReview() {
    if (!diff) {
      setReviewPath(null);
      setReviewBase('creation');
    } else {
      if (reviewChange?.after && reviewChange.path !== file?.path) {
        setIndex(draftEntryIndex(payload, reviewChange.path));
        onSelectPath?.(reviewChange.path);
      }
      returnToEditor.current = active;
    }
    setDiff(!diff);
  }

  const visibleFiles = payload.files
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(({ entry }) => entry.path.toLowerCase().includes(entryQuery.toLowerCase()));
  useEffect(() => setPackageName(''), [index, file?.path]);
  if (initialDraftId && !draft)
    return (
      <section className="workspace-panel space-y-3 p-4">
        <p role="status">
          {opening ? 'Opening saved draft…' : message || 'This saved draft is unavailable.'}
        </p>
        {!opening && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setOpening(true);
                void open(initialDraftId);
              }}
            >
              Retry opening draft
            </Button>
            <Button asChild variant="ghost">
              <ConsoleLink href={bundleHref(commandScope, 'changes')}>View changes</ConsoleLink>
            </Button>
          </div>
        )}
      </section>
    );
  return (
    <section className="space-y-4">
      <DraftDiscardDialog
        target={discardTarget}
        error={discardError}
        busy={busy}
        pending={Boolean(pending)}
        returnFocusRef={discardTrigger}
        fallbackFocusRef={draftHeading}
        onClose={() => setDiscardTarget(null)}
        onDiscard={async () => {
          if (!discardTarget) return;
          setDiscardError('');
          const success = await command({
            action: 'discard',
            id: discardTarget.id,
            expectedGeneration: discardTarget.generation,
            key: discardTarget.key,
          });
          if (success) setDiscardTarget(null);
        }}
      />
      <RelatedPendingNotice recovery={related} scope={commandScope} canEdit={canEdit} />
      {!detailOnly && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">Durable drafts</h2>
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
          <Disclosure className="space-y-3">
            <DisclosureTrigger>Draft recovery details</DisclosureTrigger>
            <DisclosureContent className="space-y-3">
              <p className="break-all text-sm">
                Unresolved operation: {pending}. A missing outcome does not establish failure.
              </p>
              <p className="text-sm text-muted-foreground">
                Closing preserves a committed result. Forgetting submitted text does not cancel
                submission; another write remains blocked until the outcome is resolved or the
                operation is closed.
              </p>
              {request.current?.action === 'retry' && (
                <SyntaxCode
                  code={request.current.body}
                  language="json"
                  className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-sm"
                  aria-label="Exact submitted draft request"
                />
              )}
              {!request.current && (
                <p className="text-sm">
                  Submitted text is unavailable. Exact retry is unavailable.
                </p>
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
                      setPending(null);
                      request.current = null;
                      setMessage('Operation closed. Review a new request.');
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
            </DisclosureContent>
          </Disclosure>
        </div>
      )}
      <div className="draft-workbench file-editor-workbench draft-studio">
        <header className="draft-toolbar" data-dirty={dirty} data-new={!draft}>
          <div className="draft-status">
            <h2 ref={draftHeading} tabIndex={-1} className="text-sm font-semibold">
              {draft ? 'Draft' : 'New draft'}
              {!canEdit && ' · Read only'}
            </h2>
            <p className="text-sm text-muted-foreground" data-unsaved={dirty} role="status">
              {pending
                ? `Submission unconfirmed${draft ? ` · Generation ${draft.generation} saved` : ''}${dirty ? ' · Unsaved changes' : ''}. Check its result to continue.`
                : draft && draft.status !== 'open'
                  ? `Generation ${draft.generation} · ${draft.status}${dirty ? ' · Unsaved changes' : ''}`
                  : draft
                    ? `Generation ${draft.generation} saved${dirty ? ` · Unsaved changes. Evaluation uses saved generation ${draft.generation}.` : ' · Ready to evaluate'}`
                    : dirty
                      ? 'Unsaved changes · Save to create a draft'
                      : 'Edit your content, then save a draft'}
            </p>
          </div>
          <div ref={toolbarActions} className="draft-toolbar-actions">
            <Dialog>
              <Tooltip>
                <TooltipTrigger asChild data-slot="button">
                  <DialogTrigger asChild data-slot="button">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="file-icon-action draft-details-trigger"
                      aria-label="Draft details"
                    >
                      <Info aria-hidden="true" />
                    </Button>
                  </DialogTrigger>
                </TooltipTrigger>
                <TooltipContent>Draft details</TooltipContent>
              </Tooltip>
              <DialogContent className="draft-details-dialog sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>Draft details</DialogTitle>
                  <DialogDescription>
                    Saved state and the release this draft started from.
                  </DialogDescription>
                </DialogHeader>
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
                {draft && (
                  <section className="draft-snapshot-history space-y-3">
                    <h3 className="text-sm font-semibold">Saved snapshot history</h3>
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
                  </section>
                )}
              </DialogContent>
            </Dialog>
            <Button className="draft-review-action" variant="outline" onClick={toggleReview}>
              {diff ? 'Edit entries' : 'Review changes'}
            </Button>
            <Button
              ref={saveAction}
              className="draft-save-action"
              data-clean={Boolean(draft) && !dirty}
              variant={draft && !dirty ? 'outline' : 'default'}
              disabled={!busy && (!active || Boolean(pending) || (!dirty && Boolean(draft)))}
              aria-disabled={busy || undefined}
              onClick={(event) => {
                if (busy) return;
                saveOwnsFocus.current = document.activeElement === event.currentTarget;
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
                );
              }}
            >
              {busy ? 'Working…' : 'Save draft'}
            </Button>
            {draft && (
              <Button
                asChild
                className="draft-evaluation-action"
                data-primary={!dirty}
                variant={draft.status === 'open' && !dirty ? 'default' : 'outline'}
              >
                <ConsoleLink
                  aria-description={
                    draft.status === 'open' && !dirty
                      ? `Saved generation ${draft.generation}`
                      : undefined
                  }
                  href={bundleHref(commandScope, 'changes', {
                    draft: draft.id,
                    candidate: draft.snapshotVersion.id,
                    generation: draft.generation,
                    path: file?.path,
                  })}
                >
                  {draft.status === 'open'
                    ? dirty
                      ? `Evaluate saved generation ${draft.generation}`
                      : 'Continue to evaluation'
                    : 'View saved change'}
                </ConsoleLink>
              </Button>
            )}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="draft-mobile-actions">
                  Draft actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="draft-actions-menu">
                <DropdownMenuItem className="min-h-11 text-sm" onSelect={toggleReview}>
                  {diff ? 'Edit entries' : 'Review changes'}
                </DropdownMenuItem>
                {draft && dirty && (
                  <DropdownMenuItem asChild className="min-h-11 text-sm">
                    <ConsoleLink
                      href={bundleHref(commandScope, 'changes', {
                        draft: draft.id,
                        candidate: draft.snapshotVersion.id,
                        generation: draft.generation,
                        path: file?.path,
                      })}
                    >
                      {draft.status === 'open'
                        ? `Evaluate saved generation ${draft.generation}`
                        : 'View saved change'}
                    </ConsoleLink>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <div className="studio-context">
          <span>
            <GitBranch aria-hidden="true" />
            {commandScope.channel} · Revision {draft?.baseRevision ?? newBase.revision}
          </span>
          <span>
            {workingChanges.length} {workingChanges.length === 1 ? 'file' : 'files'} with unsaved
            edits
          </span>
          {active && <span>Save creates a draft snapshot for evaluation.</span>}
        </div>
        {message && (
          <p
            role="status"
            className={
              message === 'Opened verified saved snapshot.' ||
              /^Confirmed (create|save|retry)\. Generation/.test(message)
                ? 'sr-only'
                : 'break-words rounded-md border p-4'
            }
          >
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
        {diff && (
          <section
            className="draft-review"
            aria-label={
              savedBaseline
                ? 'Review changes since the last save'
                : 'Review changes from the creation base'
            }
          >
            <header className="studio-review-controls">
              <div>
                <h3 ref={reviewHeading} tabIndex={-1}>
                  Change review
                </h3>
                <p className="draft-review-baseline">
                  {baselineName} compared with current browser content
                  {dirty ? ' · unsaved edits' : ''}.
                </p>
              </div>
              {draft && (
                <label>
                  Compare against
                  <NativeSelect
                    value={reviewBase}
                    aria-label="Compare against"
                    onChange={(e) => setReviewBase(e.target.value as 'creation' | 'saved')}
                  >
                    <option value="creation">Creation base · revision {draft.baseRevision}</option>
                    <option value="saved">Last save · generation {draft.generation}</option>
                  </NativeSelect>
                </label>
              )}
              <label>
                Review scope
                <NativeSelect
                  ref={reviewScope}
                  aria-label="Review scope"
                  value={reviewChange ? 'path:' + reviewChange.path : 'all'}
                  onChange={(e) =>
                    setReviewPath(e.target.value === 'all' ? null : e.target.value.slice(5))
                  }
                >
                  <option value="all">All changed files ({reviewChanges.length})</option>
                  {reviewChanges.map((change) => (
                    <option key={change.path} value={'path:' + change.path}>
                      {change.operation} · {change.path || '(unnamed)'}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              {reviewChange && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setReviewPath(null);
                    reviewScope.current?.focus();
                  }}
                >
                  Show all file changes
                </Button>
              )}
            </header>
            <ContentDiff
              key={reviewBase}
              labels={[baselineName, 'Working copy']}
              selectedPath={reviewChange?.path}
              hideMap={Boolean(reviewChange)}
              onSelectPath={(path) => {
                setReviewPath(path);
                reviewScope.current?.focus();
              }}
              base={savedBaseline ? saved : base}
              current={payload}
              variant="workspace"
            />
          </section>
        )}
        <div
          className="content-workspace file-explorer-workspace"
          hidden={diff}
          data-testid="draft-file-browser"
        >
          <FileNavigator
            collapsible
            count={visibleFiles.length}
            totalCount={payload.files.length}
            filtered={Boolean(entryQuery)}
            selectedPath={file?.path}
          >
            <div className="file-navigator-controls">
              <div className="file-navigator-heading">
                <span className="file-navigator-desktop-label text-sm font-medium">Files</span>
                <div className="file-navigator-actions">
                  <DropdownMenu modal={false}>
                    <Tooltip>
                      <TooltipTrigger asChild data-slot="button">
                        <DropdownMenuTrigger asChild data-slot="button">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="file-icon-action"
                            aria-label="Add entry"
                            disabled={busy || !active}
                          >
                            <Plus aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent>Add entry</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        className="min-h-8 text-sm"
                        onSelect={() => {
                          setEntryQuery('');
                          add('instruction');
                        }}
                      >
                        Add instruction
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="min-h-8 text-sm"
                        onSelect={() => {
                          setEntryQuery('');
                          add('skill');
                        }}
                      >
                        Add skill package
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="min-h-8 text-sm"
                        onSelect={() => {
                          setEntryQuery('');
                          add('memory');
                        }}
                      >
                        Add shared memory
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <ImportContent
                    presentation="dialog"
                    iconOnly
                    compatibilityTarget={compatibilityTarget}
                    payload={payload}
                    onApply={(next) => {
                      setEntryQuery('');
                      editPayload(next);
                    }}
                    disabled={busy || !active}
                    commandScope={commandScope}
                  />
                </div>
              </div>

              <Label htmlFor="draft-search" className="sr-only">
                Find an entry
              </Label>
              <Input
                id="draft-search"
                ref={searchField}
                type="search"
                value={entryQuery}
                onChange={(e) => setEntryQuery(e.target.value)}
                placeholder="Search files…"
              />
              {entryQuery && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEntryQuery('');
                    searchField.current?.focus();
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
            <FileTree
              items={visibleFiles.map(({ entry, entryIndex }) => {
                const operation = workingOperations.get(entry.path);
                return {
                  changeDescription: operation === 'Removed' ? undefined : operation,
                  id: String(entryIndex),
                  path: entry.path,
                  kind: entry.kind,
                };
              })}
              selectedId={file ? String(index) : undefined}
              scopeKey={`${scope}:${draft?.id ?? initialDraftId ?? 'new'}`}
              filtered={Boolean(entryQuery)}
              filterKey={entryQuery}
              disabled={busy}
              onSelectItem={(item) => {
                setIndex(Number(item.id));
                onSelectPath?.(item.path);
              }}
            />
            {!visibleFiles.length && (
              <p className="p-4 text-sm text-muted-foreground">
                {payload.files.length
                  ? 'No matching entries. Clear filters to see all entries.'
                  : active
                    ? 'No entries yet. Use Add entry to begin.'
                    : 'This saved draft has no entries.'}
              </p>
            )}
          </FileNavigator>
          <div className="content-detail">
            {file ? (
              <>
                <header className="content-entry-heading compact-selected-file">
                  <div className="flex min-w-0 items-start gap-3">
                    <FileGlyph kind={file.kind} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-words text-sm font-semibold">
                          {fileTitle(file) || '(unnamed)'}
                        </h3>
                        <KindBadge kind={file.kind} />
                        {currentChange && (
                          <span className="studio-file-state">
                            {currentChange.operation} since {draft ? 'last save' : 'creation base'}
                          </span>
                        )}
                      </div>
                      {file.path !== fileTitle(file) && (
                        <p
                          tabIndex={0}
                          className="selected-file-path break-all font-mono text-sm text-muted-foreground"
                        >
                          <PathText value={file.path} />
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="selected-entry-actions flex flex-wrap items-center gap-2">
                    {(currentChange ||
                      draftChanges.some((change) => change.path === file.path)) && (
                      <Button
                        variant="outline"
                        aria-label="Compare file"
                        onClick={() => {
                          setReviewBase(draft && currentChange ? 'saved' : 'creation');
                          setReviewPath(file.path);
                          setDiff(true);
                        }}
                      >
                        <GitCompareArrows aria-hidden="true" /> Compare file
                      </Button>
                    )}
                    <Dialog
                      onOpenChange={(open) => {
                        if (open) setEntryError('');
                      }}
                    >
                      <DialogTrigger asChild>
                        <Button variant="outline" aria-label="Entry actions">
                          <span className="entry-actions-full-label">Entry actions</span>
                          <span className="entry-actions-short-label" aria-hidden="true">
                            Actions
                          </span>
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Entry actions</DialogTitle>
                          <DialogDescription>
                            Rename, change type, or remove this entry. Changes stay in this draft
                            until saved.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3">
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
                                  onChange={(e) => {
                                    setPackageName(e.target.value);
                                    setEntryError('');
                                  }}
                                  aria-invalid={Boolean(entryError)}
                                  aria-describedby={entryError ? 'skill-package-error' : undefined}
                                  disabled={busy || !active}
                                />
                                <Button
                                  variant="outline"
                                  disabled={busy || !active || !packageName.trim()}
                                  onClick={() => {
                                    try {
                                      editPayload(
                                        renameSkillPackage(
                                          payload,
                                          file.path.split('/')[1],
                                          packageName,
                                        ),
                                      );
                                      setPackageName('');
                                      setEntryError('');
                                    } catch (error) {
                                      setEntryError(
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
                              {entryError && (
                                <p
                                  id="skill-package-error"
                                  role="alert"
                                  className="text-sm text-destructive"
                                >
                                  {entryError}
                                </p>
                              )}
                              <p className="text-sm text-muted-foreground">
                                Applies the package path and manifest name to all its files in
                                browser edits.
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
                        </div>
                      </DialogContent>
                    </Dialog>
                  </div>
                </header>
                <div className="draft-editor-body">
                  <CodeEditor
                    ref={editorHandle}
                    key={`${index}:${payload.files.length}`}
                    lineNumbers
                    id="draft-text"
                    aria-label="Content"
                    path={file.path}
                    className="draft-source-textarea min-h-[360px] font-mono text-sm"
                    value={file.text}
                    disabled={busy || !active}
                    onChange={(value) => update('text', value)}
                  />
                </div>
              </>
            ) : (
              <div className="space-y-3 p-4 text-sm">
                {index < 0 && initialPath ? (
                  <>
                    <p role="status" className="break-words">
                      This draft has no entry at <code className="break-all">{initialPath}</code>.
                    </p>
                    {payload.files[0] && (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setIndex(0);
                          onSelectPath?.(payload.files[0].path);
                        }}
                      >
                        Open first entry
                      </Button>
                    )}
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    {active ? 'Add an entry to start editing.' : 'No entry selected.'}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
        {draft && (
          <footer className="draft-utility-footer">
            <div className="draft-footer-actions">
              <Button
                variant="ghost"
                disabled={busy || Boolean(pending) || related.blocked}
                onClick={() => confirmDiscard(() => void open(draft.id))}
              >
                Reload saved draft
              </Button>
            </div>
          </footer>
        )}
      </div>
      {draft && (
        <>
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
                onClick={(event) => confirmSavedDiscard(draft, event.currentTarget)}
              >
                Discard saved draft
              </Button>
            </div>
          )}
          {detailOnly && (
            <Disclosure className="text-sm">
              <DisclosureTrigger className="cursor-pointer text-muted-foreground">
                Discard draft
              </DisclosureTrigger>
              <DisclosureContent>
                <p className="my-3 text-muted-foreground">
                  Discard this saved draft and any browser edits. The published release stays as it
                  is.
                </p>
                {active && (
                  <Button
                    variant="outline"
                    disabled={busy || Boolean(pending)}
                    onClick={(event) => confirmSavedDiscard(draft, event.currentTarget)}
                  >
                    Discard saved draft
                  </Button>
                )}
              </DisclosureContent>
            </Disclosure>
          )}
        </>
      )}
    </section>
  );
}
