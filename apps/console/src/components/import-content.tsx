import type { BundleScope } from '../server/selection';
import { useEffect, useId, useRef, useState } from 'react';
import { compatibilityIssues, validatePayload } from '@acclimate/sdk/validation';
import type { CompatibilityTarget, BundleFile, BundlePayload } from '@acclimate/sdk';
import { runDraftCommand } from '../server/content-actions';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { FolderOpen, Files, Upload } from 'lucide-react';
import { NativeSelect } from './ui/native-select';
import { SyntaxCode } from './syntax-code';
import { FileGlyph } from './shared';
type ImportEntry = { file: File; path: string };
type Conflict = { path: string; reason: string };

class ImportCollision extends Error {
  constructor(
    readonly conflicts: Conflict[],
    readonly remaining: ImportEntry[],
  ) {
    super(`Path collision: ${conflicts[0].path}`);
  }
}

function planBatch(batch: readonly File[], directory: boolean): ImportEntry[] {
  const relativePath = (file: File) =>
    (file.webkitRelativePath || '').split('/').slice(1).join('/');
  const root = batch[0]?.webkitRelativePath?.split('/')[0];
  const isSkillFolder = directory && batch.some((file) => relativePath(file) === 'SKILL.md');
  const prefix = isSkillFolder
    ? `skills/${root}/`
    : directory && root === 'skills'
      ? 'skills/'
      : '';
  return batch.map((file) => ({ file, path: directory ? prefix + relativePath(file) : file.name }));
}

function overlapsPath(a: string, b: string) {
  const left = a.toLowerCase(),
    right = b.toLowerCase();
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
}

async function readPlannedBatch(
  entries: ImportEntry[],
  payload: BundlePayload,
): Promise<BundlePayload> {
  if (entries.length + payload.files.length > 128) throw Error('At most 128 entries are allowed.');
  if (
    entries.some(({ file }) => file.size > 256 * 1024) ||
    entries.reduce((n, { file }) => n + file.size, 0) > 1024 * 1024
  )
    throw Error('Import exceeds the file or batch byte limit.');
  const conflicts: Conflict[] = [],
    remaining: ImportEntry[] = [];
  for (const [i, entry] of entries.entries()) {
    const { path } = entry;
    if (
      !/^[-A-Za-z0-9._/]+$/.test(path) ||
      path.split('/').some((p) => !p || p === '.' || p === '..') ||
      path.length > 240
    )
      throw Error(`Invalid relative path: ${path}`);
    const existing = payload.files.find((f) => overlapsPath(f.path, path));
    const other = entries.find((f, j) => i !== j && overlapsPath(f.path, path));
    if (existing)
      conflicts.push({ path, reason: `Conflicts with existing entry “${existing.path}”.` });
    else if (other)
      conflicts.push({ path, reason: `Conflicts with “${other.path}” in the same selection.` });
    else remaining.push(entry);
  }
  if (conflicts.length) throw new ImportCollision(conflicts, remaining);
  const imported: BundleFile[] = [];
  for (const { path, file } of entries) {
    if (path === 'SKILL.md')
      throw Error(
        'Choose the bundle folder to preserve skills/<name>/SKILL.md and its supporting files.',
      );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw Error(`Cannot read “${path}” as UTF-8 text.`);
    }
    if (text.includes('\0')) throw Error(`Binary content: ${path}`);
    imported.push({
      path,
      text,
      kind: path.startsWith('skills/')
        ? 'skill'
        : path.startsWith('memory/')
          ? 'memory'
          : 'instruction',
    });
  }
  const combined = { ...payload, files: [...payload.files, ...imported] };
  validatePayload(combined);
  return combined;
}

/** Read one atomic batch without publishing or requiring an existing bundle. */
export function readImportBatch(
  batch: readonly File[],
  payload: BundlePayload,
  directory = false,
): Promise<BundlePayload> {
  return readPlannedBatch(planBatch(batch, directory), payload);
}
export function ImportContent({
  payload,
  onApply,
  embedded = false,
  disabled,
  commandScope,
  compatibilityTarget = 'generic',
  purpose = 'draft',
  onReadingChange,
  presentation = 'inline',
  iconOnly = false,
}: {
  payload: BundlePayload;
  onApply: (p: BundlePayload) => void;
  embedded?: boolean;
  disabled: boolean;
  commandScope?: BundleScope;
  compatibilityTarget?: CompatibilityTarget;
  purpose?: 'draft' | 'creation';
  onReadingChange?: (reading: boolean) => void;
  presentation?: 'inline' | 'dialog';
  iconOnly?: boolean;
}) {
  const [preview, setPreview] = useState<BundleFile[] | null>(null),
    [error, setError] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [showPickers, setShowPickers] = useState(false);
  const pickerId = useId();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [collision, setCollision] = useState<ImportCollision | null>(null);
  const pickerType = useRef(false);
  const previewId = useId();
  const selectedFile = preview?.find((file) => file.path === selectedPath) ?? preview?.[0];
  const [reading, setReading] = useState(false);
  const [open, setOpen] = useState(false);
  const importTrigger = useRef<HTMLButtonElement>(null);
  const readSequence = useRef(0);
  useEffect(() => {
    readSequence.current++;
    setPreview(null);
    setSelectedPath('');
    setError('');
    setCollision(null);
    setReading(false);
    onReadingChange?.(false);
    return () => {
      readSequence.current++;
    };
  }, [payload, commandScope?.projectId, commandScope?.bundleId, commandScope?.channel]);
  useEffect(() => () => onReadingChange?.(false), [onReadingChange]);
  async function read(entries: ImportEntry[], recoveryTrigger?: HTMLElement) {
    const originDialog = recoveryTrigger?.closest('[role="dialog"]');
    const sequence = ++readSequence.current;
    setShowPickers(false);
    setPreview(null);
    setSelectedPath('');
    setCollision(null);
    setError('');
    setReading(true);
    onReadingChange?.(true);
    try {
      const combined = await readPlannedBatch(entries, payload);
      // New bundles have no bundle scope yet. The creation endpoint revalidates this
      // same payload under workspace permissions before publishing it atomically.
      if (purpose === 'draft') {
        if (!commandScope) throw Error('Explicit import scope is required.');
        const result = await runDraftCommand({
          data: { action: 'validate', scope: commandScope, payload: combined },
        });
        if (!result.ok) throw Error(result.message);
      }
      if (readSequence.current === sequence) {
        if (purpose === 'creation') onApply(combined);
        else {
          setPreview(combined.files.slice(payload.files.length));
          requestAnimationFrame(() => {
            if (readSequence.current !== sequence || (originDialog && !originDialog.isConnected))
              return;
            const active = document.activeElement;
            if (recoveryTrigger) {
              if (active !== document.body && active !== originDialog && active !== recoveryTrigger)
                return;
              const review = reviewHeading.current?.closest('.import-review');
              const controls = review?.querySelectorAll<HTMLElement>(
                'button[aria-pressed=true],select',
              );
              Array.from(controls ?? [])
                .find((control) => control.getClientRects().length)
                ?.focus();
            } else if (
              active === document.body ||
              (active instanceof HTMLInputElement && active.type === 'file')
            ) {
              reviewHeading.current?.focus();
            }
          });
        }
      }
    } catch (e) {
      if (readSequence.current === sequence) {
        if (e instanceof ImportCollision) setCollision(e);
        else setError(e instanceof Error ? e.message : 'Could not read import.');
      }
    } finally {
      if (readSequence.current === sequence) {
        setReading(false);
        onReadingChange?.(false);
      }
    }
  }
  function choose(input: HTMLInputElement, directory = false) {
    if (!input.files?.length) return;
    pickerType.current = directory;
    void read(planBatch(Array.from(input.files), directory));
    input.value = '';
  }
  function returnToPicker() {
    const id = pickerType.current ? 'import-directory' : 'import-files';
    document.getElementById(id)?.focus();
  }
  const dialog = presentation === 'dialog' && purpose === 'draft';
  const Container = purpose === 'creation' || embedded ? 'section' : Disclosure;
  const Body = purpose === 'creation' || embedded || dialog ? 'div' : DisclosureContent;
  const description = (
    <>
      Bring in your existing instructions or skills. Choose a folder to keep nested paths, or add
      individual text files.{' '}
      {purpose === 'creation'
        ? 'Review their content below before publishing your bundle.'
        : 'You’ll review them before adding to this draft.'}
    </>
  );
  const body = (
    <Body
      className={
        dialog
          ? 'content-import import-dialog-body space-y-4'
          : embedded
            ? 'space-y-4'
            : 'space-y-4 border-t p-4'
      }
    >
      {preview && (
        <Button
          size="sm"
          variant="ghost"
          type="button"
          aria-controls={pickerId}
          aria-expanded={showPickers}
          onClick={() => setShowPickers((v) => !v)}
        >
          {showPickers ? 'Hide file pickers' : 'Choose different files'}
        </Button>
      )}
      <div id={pickerId} hidden={Boolean(preview) && !showPickers} className="space-y-3">
        {!dialog && <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2 rounded-lg border p-3">
            <Label htmlFor="import-directory" className="flex items-center gap-2">
              <FolderOpen className="size-4" aria-hidden="true" />
              Bundle folder
            </Label>
            <p className="text-xs text-muted-foreground">
              Choose a bundle folder or a single skill folder.
            </p>
            <Input
              id="import-directory"
              type="file"
              {...{ webkitdirectory: '', directory: '' }}
              multiple
              disabled={disabled || reading}
              onChange={(e) => choose(e.currentTarget, true)}
            />
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <Label htmlFor="import-files" className="flex items-center gap-2">
              <Files className="size-4" aria-hidden="true" />
              Individual files
            </Label>
            <p className="text-xs text-muted-foreground">
              Adds files at the top level of your bundle.
            </p>
            <Input
              id="import-files"
              type="file"
              multiple
              disabled={disabled || reading}
              onChange={(e) => choose(e.currentTarget)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          UTF-8 text · 256 KB per file · 1 MB per import · 128 entries per bundle
        </p>
      </div>
      {reading && (
        <p role="status" className="text-sm text-muted-foreground">
          Reading and checking your files…
        </p>
      )}
      {error && (
        <p role="alert" className="import-problem">
          {error} Nothing was imported.
        </p>
      )}
      {collision && (
        <section className="import-conflict">
          <div role="alert">
            <h3>Path collision: {collision.conflicts[0].path}</h3>
            <p>
              Nothing was imported. Rename the conflicting paths or choose a different selection.
            </p>
          </div>
          <ul>
            {collision.conflicts.map((item, index) => (
              <li key={index}>
                <code>{item.path}</code>
                <span>{item.reason}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || reading}
              onClick={() => {
                const input = document.getElementById(
                  pickerType.current ? 'import-directory' : 'import-files',
                ) as HTMLInputElement | null;
                input?.click();
              }}
            >
              Choose {pickerType.current ? 'folder' : 'files'} again
            </Button>
            {purpose === 'draft' && collision.remaining.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || reading}
                onClick={(e) =>
                  void read(collision.remaining, e.detail === 0 ? e.currentTarget : undefined)
                }
              >
                Review {collision.remaining.length} nonconflicting{' '}
                {collision.remaining.length === 1 ? 'file' : 'files'}
              </Button>
            )}
          </div>
        </section>
      )}
      {preview && selectedFile && (
        <>
          <section className="import-review" aria-label="Import preview">
            <header>
              <h3 ref={reviewHeading} tabIndex={-1}>
                Ready to add · {preview.length} {preview.length === 1 ? 'file' : 'files'}
              </h3>
              <span>Draft preview</span>
            </header>
            <div className="import-review-layout" data-many={preview.length > 6 || undefined}>
              {preview.length > 6 && (
                <NativeSelect
                  className="import-compact-file-select"
                  aria-label="File to preview"
                  value={selectedFile.path}
                  onChange={(e) => setSelectedPath(e.target.value)}
                >
                  {preview.map((file) => (
                    <option key={file.path} value={file.path}>
                      {file.path} · {file.kind}
                    </option>
                  ))}
                </NativeSelect>
              )}
              <ul aria-label="Files to add">
                {preview.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      aria-pressed={selectedFile.path === file.path}
                      aria-controls={previewId}
                      onClick={() => setSelectedPath(file.path)}
                    >
                      <FileGlyph kind={file.kind} />
                      <span>
                        <strong>{file.path}</strong>
                        <small>{file.kind}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <section
                className="import-source"
                id={previewId}
                aria-label={'Preview of ' + selectedFile.path}
              >
                <header>
                  <strong>Preview · {selectedFile.path}</strong>
                  <span>
                    {new TextEncoder().encode(selectedFile.text).length.toLocaleString()} bytes
                  </span>
                </header>
                {selectedFile.text ? (
                  <SyntaxCode
                    code={selectedFile.text}
                    path={selectedFile.path}
                    lineNumbers={selectedFile.text.length < 24_000}
                    wrap
                    aria-label={'Contents of ' + selectedFile.path}
                  />
                ) : (
                  <p>Empty file</p>
                )}
              </section>
            </div>
          </section>
          {compatibilityIssues(
            { ...payload, files: [...payload.files, ...preview] },
            compatibilityTarget,
          ).map((issue, index) => (
            <p role="status" key={index}>
              {issue.path || issue.package || issue.code}: {issue.message}. Import can be saved as
              an incomplete draft.
            </p>
          ))}
          <div className="import-review-actions">
            <Button
              type="button"
              variant="outline"
              disabled={disabled || reading}
              onClick={() => {
                setPreview(null);
                setSelectedPath('');
                requestAnimationFrame(returnToPicker);
              }}
            >
              Discard preview
            </Button>
            <Button
              type="button"
              disabled={disabled || reading}
              onClick={() => {
                onApply({ ...payload, files: [...payload.files, ...preview] });
                setPreview(null);
                if (dialog) setOpen(false);
              }}
            >
              <Upload aria-hidden="true" /> Add {preview.length}{' '}
              {preview.length === 1 ? 'file' : 'files'} to draft
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Adds to your browser edits. Save the draft when you’re ready.
          </p>
        </>
      )}
    </Body>
  );
  // Keep this stateful component mounted while the dialog's portal comes and goes.
  // Closing the dialog preserves a pending read, preview, and validation errors.
  if (dialog) {
    const trigger = (
      <DialogTrigger asChild data-slot="button">
        <Button
          ref={importTrigger}
          type="button"
          variant="ghost"
          size={iconOnly ? 'icon' : 'sm'}
          className={
            iconOnly
              ? 'file-icon-action import-dialog-trigger'
              : 'draft-utility-disclosure import-dialog-trigger cursor-pointer text-left text-sm font-medium'
          }
          aria-label="Import files into this draft"
          disabled={disabled}
        >
          {iconOnly ? <Upload aria-hidden="true" /> : 'Import files into this draft'}
        </Button>
      </DialogTrigger>
    );
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        {iconOnly ? (
          <Tooltip>
            <TooltipTrigger asChild data-slot="button">
              {trigger}
            </TooltipTrigger>
            <TooltipContent>Import files into this draft</TooltipContent>
          </Tooltip>
        ) : (
          trigger
        )}
        <DialogContent className="import-dialog sm:max-w-[54rem]" returnFocusRef={importTrigger}>
          <DialogHeader>
            <DialogTitle>Import files into this draft</DialogTitle>
            <DialogDescription>
              {preview
                ? 'Select a file to inspect its source before adding it to your browser edits.'
                : description}
            </DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Container className={embedded ? 'content-import' : 'content-import rounded-lg border bg-card'}>
      {embedded ? null : purpose === 'draft' ? (
        <DisclosureTrigger className="px-4 py-3 text-sm font-medium">
          Import files
        </DisclosureTrigger>
      ) : (
        <h3 className="px-4 py-3 text-sm font-medium">Choose files to import</h3>
      )}
      {body}
    </Container>
  );
}
