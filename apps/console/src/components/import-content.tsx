import type { BundleScope } from '../server/selection';
import { useEffect, useRef, useState } from 'react';
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
import { FileGlyph } from './shared';
/** Read one atomic batch without publishing or requiring an existing bundle. */
export async function readImportBatch(
  batch: readonly File[],
  payload: BundlePayload,
  directory = false,
): Promise<BundlePayload> {
  if (batch.length + payload.files.length > 128) throw Error('At most 128 entries are allowed.');
  if (batch.some((f) => f.size > 256 * 1024) || batch.reduce((n, f) => n + f.size, 0) > 1024 * 1024)
    throw Error('Import exceeds the file or batch byte limit.');
  const seen = new Set(payload.files.map((f) => f.path.toLowerCase()));
  const imported: BundleFile[] = [];
  const root = batch[0]?.webkitRelativePath?.split('/')[0];
  const isSkillFolder =
    directory &&
    batch.some((file) => file.webkitRelativePath.split('/').slice(1).join('/') === 'SKILL.md');
  const prefix = isSkillFolder
    ? `skills/${root}/`
    : directory && root === 'skills'
      ? 'skills/'
      : '';
  for (const file of batch) {
    // Keep a bundle's relative paths; wrap a selected skill folder in skills/<name>/.
    const path = directory
      ? prefix + file.webkitRelativePath.split('/').slice(1).join('/')
      : file.name;
    if (
      !/^[-A-Za-z0-9._/]+$/.test(path) ||
      path.split('/').some((p) => !p || p === '.' || p === '..') ||
      path.length > 240
    )
      throw Error(`Invalid relative path: ${path}`);
    if (seen.has(path.toLowerCase()))
      throw Error(`Path collision: ${path}. Rename or remove the existing entry first.`);
    seen.add(path.toLowerCase());
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
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
  const paths = [...payload.files, ...imported].map((f) => f.path.toLowerCase());
  if (paths.some((p) => paths.some((q) => q !== p && q.startsWith(p + '/'))))
    throw Error('A file conflicts with a directory.');
  if (!directory && imported.some((f) => f.path === 'SKILL.md'))
    throw Error(
      'Choose the bundle folder to preserve skills/<name>/SKILL.md and its supporting files.',
    );
  const combined = { ...payload, files: [...payload.files, ...imported] };
  validatePayload(combined);
  return combined;
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
  const [reading, setReading] = useState(false);
  const [open, setOpen] = useState(false);
  const importTrigger = useRef<HTMLButtonElement>(null);
  const readSequence = useRef(0);
  useEffect(() => {
    readSequence.current++;
    setPreview(null);
    setReading(false);
    onReadingChange?.(false);
    return () => {
      readSequence.current++;
    };
  }, [payload, commandScope?.projectId, commandScope?.bundleId, commandScope?.channel]);
  useEffect(() => () => onReadingChange?.(false), [onReadingChange]);
  async function read(files: FileList | null, directory = false) {
    const sequence = ++readSequence.current;
    setPreview(null);
    setError('');
    if (!files?.length) {
      setReading(false);
      onReadingChange?.(false);
      return;
    }
    setReading(true);
    onReadingChange?.(true);
    try {
      const combined = await readImportBatch(Array.from(files), payload, directory);
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
        else setPreview(combined.files.slice(payload.files.length));
      }
    } catch (e) {
      if (readSequence.current === sequence)
        setError(e instanceof Error ? e.message : 'Could not read import.');
    } finally {
      if (readSequence.current === sequence) {
        setReading(false);
        onReadingChange?.(false);
      }
    }
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
            onChange={(e) => {
              void read(e.target.files, true);
              e.target.value = '';
            }}
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
            onChange={(e) => {
              void read(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        UTF-8 text · 256 KB per file · 1 MB per import · 128 entries per bundle
      </p>
      {reading && (
        <p role="status" className="text-sm text-muted-foreground">
          Reading and checking your files…
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error} Nothing was imported.
        </p>
      )}
      {preview && (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">
              Ready to add · {preview.length} {preview.length === 1 ? 'file' : 'files'}
            </h3>
            <ul
              className={
                dialog
                  ? 'divide-y rounded-lg border'
                  : 'max-h-52 divide-y overflow-auto rounded-lg border'
              }
            >
              {preview.map((f) => (
                <li key={f.path} className="flex items-center gap-3 px-3 py-2">
                  <FileGlyph kind={f.kind} />
                  <span className="min-w-0 flex-1 break-all text-sm">{f.path}</span>
                  <span className="text-xs text-muted-foreground">{f.kind}</span>
                </li>
              ))}
            </ul>
          </div>
          {compatibilityIssues(
            { ...payload, files: [...payload.files, ...preview] },
            compatibilityTarget,
          ).map((issue, index) => (
            <p role="status" key={index}>
              {issue.path || issue.package || issue.code}: {issue.message}. Import can be saved as
              an incomplete draft.
            </p>
          ))}
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
        <DialogContent className="import-dialog sm:max-w-[40rem]" returnFocusRef={importTrigger}>
          <DialogHeader>
            <DialogTitle>Import files into this draft</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
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
