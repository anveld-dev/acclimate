import { useEffect, useRef, useState } from 'react';
import { fileKindForPath, validatePayload } from '@anveld/acclimate-sdk/validation';
import type { BundleFile, BundlePayload } from '@anveld/acclimate-sdk';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { FolderOpen, Files } from 'lucide-react';
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
    imported.push({ path, text, kind: fileKindForPath(path) });
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
  disabled,
  onReadingChange,
}: {
  payload: BundlePayload;
  onApply: (payload: BundlePayload) => void;
  disabled: boolean;
  onReadingChange: (reading: boolean) => void;
}) {
  const [error, setError] = useState('');
  const [collision, setCollision] = useState<ImportCollision | null>(null);
  const pickerType = useRef(false);
  const [reading, setReading] = useState(false);
  const readSequence = useRef(0);
  useEffect(() => {
    readSequence.current++;
    setError('');
    setCollision(null);
    setReading(false);
    onReadingChange?.(false);
    return () => {
      readSequence.current++;
    };
  }, [payload, onReadingChange]);
  useEffect(() => () => onReadingChange?.(false), [onReadingChange]);
  async function read(entries: ImportEntry[]) {
    const sequence = ++readSequence.current;
    setCollision(null);
    setError('');
    setReading(true);
    onReadingChange?.(true);
    try {
      const combined = await readPlannedBatch(entries, payload);
      // New bundles have no bundle scope yet. The creation endpoint revalidates this
      // same payload under workspace permissions before publishing it atomically.
      if (readSequence.current === sequence) onApply(combined);
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
  return (
    <section className="content-import rounded-lg border bg-card">
      <h3 className="px-4 py-3 text-sm font-medium">Choose files to import</h3>
      <div className="space-y-4 border-t p-4">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Choose a folder to keep nested paths, or add individual text files. Review their content
          before publishing your bundle.
        </p>
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
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
