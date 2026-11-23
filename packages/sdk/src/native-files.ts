import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  BundleFile,
  CompatibilityTarget,
  DeliveryReceiptRequest,
  VerifiedVersion,
} from './types.js';
import { validatePayload, DeliveryError } from './cache.js';
import { compatibilityIssues } from './compatibility.js';
import { AcclimateUsageError } from './errors.js';

export interface NativeFile {
  sourcePath: string;
  path: string;
  kind: BundleFile['kind'];
  absolutePath: string;
  text: string;
}
export interface NativePreparation {
  cwd: string;
  files: NativeFile[];
  cleanup(): Promise<void>;
}
/** Where a harness discovers each kind of bundle file, relative to the prepared directory. */
export interface NativePathMapping {
  instructionPath: string;
  skillRoot: string;
  memoryRoot: string;
}
export type NativeTarget = Exclude<CompatibilityTarget, 'generic'>;
/**
 * Copy selected project files (for example `.claude/settings.json` or `.mcp.json`)
 * from an existing checkout before the bundle is staged. Directories are copied
 * recursively. Missing paths are skipped; symlinks and special files are rejected.
 */
export interface NativeOverlay {
  baseDir: string;
  paths: readonly string[];
}
export interface PrepareNativeFilesOptions {
  mapping: NativePathMapping;
  /** mkdtemp prefix for the private directory created under `os.tmpdir()`. */
  prefix?: string;
  /** Compatibility rules to enforce before staging. Defaults to `codex`. */
  target?: NativeTarget;
  overlay?: NativeOverlay;
}
export interface PreparedNativeFiles extends NativePreparation {
  instructionPath: string | null;
  skillPaths: string[];
  memoryFiles: Array<{ path: string; text: string; absolutePath: string }>;
  /** Files copied from `overlay.baseDir`, with digests to record in your runtime identity. */
  overlayFiles: Array<{ path: string; sha256: string; bytes: number }>;
}
/**
 * The result of `client.prepare()`. Native plugins accept it in place of a
 * verified version so `reportStarted()` receipts survive native preparation.
 */
export interface DeliveredVersion {
  version: VerifiedVersion;
  reportStarted(): Readonly<DeliveryReceiptRequest> | null;
  cleanup(): Promise<void>;
}
export type NativeInput = VerifiedVersion | DeliveredVersion;

/** Split plugin input into the verified version plus its optional delivery receipt hooks. */
export function nativeSource(input: NativeInput): {
  version: VerifiedVersion;
  reportStarted(): Readonly<DeliveryReceiptRequest> | null;
  release(): Promise<void>;
} {
  // A VerifiedVersion also has a `version` field (its metadata), so a delivered
  // input is recognised by its receipt hook rather than by that key.
  if (typeof (input as Partial<DeliveredVersion>).reportStarted === 'function') {
    const delivery = input as DeliveredVersion;
    return {
      version: delivery.version,
      reportStarted: () => delivery.reportStarted(),
      release: () => delivery.cleanup(),
    };
  }
  return { version: input as VerifiedVersion, reportStarted: () => null, release: async () => {} };
}

const OVERLAY_FILES = 256;
const OVERLAY_FILE_BYTES = 1024 * 1024;

async function copyOverlay(
  root: string,
  overlay: NativeOverlay,
): Promise<PreparedNativeFiles['overlayFiles']> {
  if (!path.isAbsolute(overlay.baseDir))
    throw new DeliveryError('invalid_overlay', `baseDir must be absolute: ${overlay.baseDir}`);
  const copied: PreparedNativeFiles['overlayFiles'] = [];
  const copy = async (relative: string): Promise<void> => {
    const source = path.join(overlay.baseDir, ...relative.split('/'));
    const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new DeliveryError('invalid_overlay', `Overlay path is a symlink or special file: ${relative}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(source)).sort()) await copy(`${relative}/${entry}`);
      return;
    }
    if (info.size > OVERLAY_FILE_BYTES || copied.length >= OVERLAY_FILES)
      throw new DeliveryError('invalid_overlay', `Overlay exceeds its file or size limit at ${relative}`);
    const bytes = await readFile(source);
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target, 'wx', 0o600 | (info.mode & 0o100));
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    copied.push({
      path: relative,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  };
  for (const relative of overlay.paths) {
    const parts = relative.split('/');
    if (!relative || path.isAbsolute(relative) || parts.some((part) => !part || part === '..' || part === '.'))
      throw new DeliveryError('invalid_overlay', `Overlay paths must be relative: ${relative}`);
    await copy(relative);
  }
  return copied;
}

/**
 * Validate bundle content, then stage mapped native inputs in a new private (0700)
 * directory under `os.tmpdir()`. Instructions go to `mapping.instructionPath`,
 * `skills/<name>/...` to `mapping.skillRoot/<name>/...` and memory to
 * `mapping.memoryRoot/<path>`. Returns paths for the harness plus an idempotent
 * `cleanup()` that removes the directory, including anything the agent wrote.
 *
 * This is the public building block for custom harness adapters; the Codex,
 * Claude, Pi and Cursor plugins are thin wrappers around it.
 */
export async function prepareNativeFiles(
  version: VerifiedVersion,
  options: PrepareNativeFilesOptions,
): Promise<PreparedNativeFiles> {
  if (typeof options !== 'object' || options === null || !('mapping' in options))
    throw new AcclimateUsageError(
      'prepareNativeFiles(version, { mapping, prefix, target }) takes an options object',
      'options',
    );
  const { mapping, prefix = 'acclimate-native-', target = 'codex', overlay } = options;
  if (process.platform === 'win32')
    throw new DeliveryError('unsupported_platform', 'Private filesystem helpers require POSIX');
  validatePayload(version.payload);
  const issues = compatibilityIssues(version.payload, target);
  if (issues.length)
    throw Object.assign(
      new DeliveryError(
        'invalid_payload',
        issues.map((issue) => `${issue.path ?? target}: [${issue.code}] ${issue.message}`).join('; '),
      ),
      { issues },
    );

  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const files: NativeFile[] = [];
  let overlayFiles: PreparedNativeFiles['overlayFiles'] = [];
  try {
    if (overlay) overlayFiles = await copyOverlay(root, overlay);
    for (const source of version.payload.files) {
      let mappedPath: string;
      if (source.kind === 'instruction') mappedPath = mapping.instructionPath;
      else if (source.kind === 'skill') {
        const relative = source.path.split('/').slice(1);
        mappedPath = path.posix.join(mapping.skillRoot, ...relative);
      } else mappedPath = path.posix.join(mapping.memoryRoot, ...source.path.split('/'));
      const segments = mappedPath.split('/');
      if (
        path.isAbsolute(mappedPath) ||
        segments.some((part) => !part || part === '.' || part === '..')
      )
        throw new DeliveryError('invalid_payload', `Invalid mapped native path: ${mappedPath}`);
      const absolutePath = path.join(root, ...segments);
      await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = await open(absolutePath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new DeliveryError(
            'invalid_payload',
            `Bundle file ${source.path} collides with overlay file ${mappedPath}`,
          );
        throw error;
      }
      try {
        await handle.writeFile(source.text, 'utf8');
      } finally {
        await handle.close();
      }
      files.push({
        sourcePath: source.path,
        path: mappedPath,
        kind: source.kind,
        absolutePath,
        text: source.text,
      });
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  let cleaned = false;
  return {
    cwd: root,
    files,
    overlayFiles,
    instructionPath: files.find((file) => file.kind === 'instruction')?.absolutePath ?? null,
    skillPaths: files
      .filter((file) => file.kind === 'skill' && file.path.endsWith('/SKILL.md'))
      .map((file) => file.absolutePath),
    memoryFiles: files
      .filter((file) => file.kind === 'memory')
      .map((file) => ({ path: file.sourcePath, text: file.text, absolutePath: file.absolutePath })),
    async cleanup() {
      if (cleaned) return;
      await rm(root, { recursive: true, force: true });
      cleaned = true;
    },
  };
}

export { transcriptTail } from './trace.js';
