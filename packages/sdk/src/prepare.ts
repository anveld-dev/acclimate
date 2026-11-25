/// <reference lib="esnext.disposable" preserve="true" />
import { AcclimateUsageError } from './errors.js';
import { lstat, mkdir, mkdtemp, open, realpath, rm, rmdir, chmod, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BundlePayload, VerifiedVersion, FileKind, DeliveryReceiptRequest } from './types.js';
import { validatePayload, DeliveryError, resolveAndCache } from './cache.js';
import type { Selection, CachePolicy } from './cache.js';
import type { AcclimateClient } from './client.js';
import type { DeliveryObserver } from './reporting.js';

export interface PreparedFile {
  path: string;
  kind: FileKind;
  absolutePath: string;
}
export interface PreparedFiles {
  files: PreparedFile[];
  cleanup(): Promise<void>;
}
export interface PrepareOptions {
  collision?: 'error';
}

export type PrepareDeliveryOptions = Selection &
  Omit<CachePolicy, 'cacheDir' | 'reporter'> & {
    cacheDir?: string;
    destination?: string;
    reporter?: DeliveryObserver & {
      reportPrepared?(version: VerifiedVersion): unknown;
      reportStarted?(version: VerifiedVersion): unknown;
      bindStartedReceipt?(version: VerifiedVersion): () => Readonly<DeliveryReceiptRequest> | null;
      reportStartedReceipt?(version: VerifiedVersion): Readonly<DeliveryReceiptRequest> | null;
    };
  };
export interface PreparedDelivery extends PreparedFiles {
  directory: string;
  /** The verified version this job runs. Its metadata is `version.version`. */
  version: VerifiedVersion;
  /** The instruction files' text, joined by a blank line. Skills and memory are not included. */
  instructions: string;
  /** The whole bundle as one system message, exactly as the learning loop sends it. See `systemPrompt`. */
  systemPrompt: string;
  skillFiles: PreparedFile[];
  /** Queue this job's start once. Retain its receipt with the job for field auditing. */
  reportStarted(): Readonly<DeliveryReceiptRequest> | null;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Render a bundle as the system message the learning loop's rollouts send: instruction files,
 * then skills, then memory, each as `# <path>` followed by its text, joined by a blank line.
 * Send this as your system message so production runs the prompt the loop scores.
 */
export function systemPrompt(payload: BundlePayload): string {
  return (['instruction', 'skill', 'memory'] as const)
    .flatMap((kind) => payload.files.filter((file) => file.kind === kind))
    .map((file) => `# ${file.path}\n${file.text}`)
    .join('\n\n');
}

/**
 * The SDK's default bundle cache, `~/.cache/acclimate/typescript` under the real
 * home directory. `client.prepare()` uses it when `cacheDir` is omitted; pass it
 * to `resolveAndCache` so every entry point shares one cache.
 */
export async function defaultCacheDir(): Promise<string> {
  return join(await realpath(homedir()), '.cache', 'acclimate', 'typescript');
}

export async function prepareDelivery(
  client: AcclimateClient,
  options: PrepareDeliveryOptions,
): Promise<PreparedDelivery> {
  const {
    workspaceId,
    bundleId,
    destination,
    cacheDir,
    reporter,
    offline,
    maxCacheBytes,
  } = options;
  const hasChannel = 'channel' in options;
  if (hasChannel === 'versionId' in options)
    throw new AcclimateUsageError('Select exactly one channel or versionId', 'selection');
  const selection = hasChannel
    ? { workspaceId, bundleId, channel: options.channel }
    : { workspaceId, bundleId, versionId: options.versionId };
  const verified = await resolveAndCache(client, selection, {
    cacheDir: cacheDir ?? (await defaultCacheDir()),
    reporter,
    offline,
    maxCacheBytes,
  });
  const directory =
    destination === undefined
      ? await mkdtemp(join(await realpath(tmpdir()), 'acclimate-job-'))
      : resolve(destination);
  async function removeOwnedDirectory() {
    if (destination !== undefined) return;
    try {
      await rmdir(directory);
    } catch (error: any) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
  let staged: PreparedFiles;
  try {
    staged = await prepareFiles(verified, directory);
  } catch (error) {
    await removeOwnedDirectory();
    throw error;
  }
  function observed(stage: 'reportPrepared' | 'reportStarted') {
    try {
      Promise.resolve(reporter?.[stage]?.(verified)).catch(() => {});
    } catch {}
  }
  observed('reportPrepared');
  let started = false;
  let queueBoundStart: (() => Readonly<DeliveryReceiptRequest> | null) | undefined;
  let startedReceipt: Readonly<DeliveryReceiptRequest> | null = null;
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    await staged.cleanup();
    await removeOwnedDirectory();
    cleaned = true;
  }
  return {
    directory,
    version: verified,
    files: staged.files,
    instructions: verified.payload.files
      .filter((file) => file.kind === 'instruction')
      .map((file) => file.text)
      .join('\n\n'),
    systemPrompt: systemPrompt(verified.payload),
    skillFiles: staged.files.filter((file) => file.kind === 'skill'),
    reportStarted() {
      if (!started) {
        started = true;
        try {
          queueBoundStart ??= reporter?.bindStartedReceipt?.(verified);
          if (queueBoundStart) {
            startedReceipt = queueBoundStart();
            // An explicit queue refusal can be retried. A thrown callback may have sent the event.
            started = startedReceipt !== null;
          } else if (reporter?.reportStartedReceipt) {
            startedReceipt = reporter.reportStartedReceipt(verified);
          } else {
            observed('reportStarted');
          }
        } catch {
          /* Optional reporting must not interrupt the job or duplicate an uncertain start. */
        }
      }
      return startedReceipt;
    },
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}

async function ensureSafeRoot(input: string): Promise<string> {
  if (process.platform === 'win32')
    throw new DeliveryError('unsupported_platform', 'Private filesystem helpers require POSIX');
  const root = resolve(input),
    parts = root.split('/').filter(Boolean);
  let cursor = '/';
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      const s = await lstat(cursor);
      if (s.isSymbolicLink() || !s.isDirectory())
        throw new DeliveryError(
          'unsafe_destination',
          'Destination contains a symlink or non-directory',
        );
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
      await mkdir(cursor, { mode: 0o700 });
      await chmod(cursor, 0o700);
    }
  }
  const real = await realpath(root);
  if (real !== root)
    throw new DeliveryError('unsafe_destination', 'Destination resolves through a symlink');
  const final = await lstat(root);
  if ((final.mode & 0o077) !== 0 || (process.getuid && final.uid !== process.getuid()))
    throw new DeliveryError(
      'unsafe_destination',
      'Existing directory must be private and owned by the current user',
    );
  return root;
}
export async function prepareFiles(
  version: VerifiedVersion,
  destination: string,
  options: PrepareOptions = {},
): Promise<PreparedFiles> {
  if (options.collision !== undefined && options.collision !== 'error')
    throw new AcclimateUsageError('Only collision="error" is supported', 'collision');
  validatePayload(version.payload);
  const root = await ensureSafeRoot(destination),
    rootReal = await realpath(root);
  const prepared: PreparedFile[] = [],
    createdFiles: string[] = [],
    createdDirs: string[] = [];
  try {
    for (const file of version.payload.files) {
      const target = resolve(root, ...file.path.split('/'));
      if (!target.startsWith(rootReal + '/'))
        throw new DeliveryError('unsafe_path', 'Bundle path escapes destination');
      const segments = file.path.split('/');
      let dir = root;
      for (const segment of segments.slice(0, -1)) {
        const existing = await readdir(dir);
        if (
          existing.some((name) => name.toLowerCase() === segment.toLowerCase() && name !== segment)
        )
          throw new DeliveryError('collision', 'Destination contains a case-colliding path');
        dir = join(dir, segment);
        try {
          const s = await lstat(dir);
          if (s.isSymbolicLink() || !s.isDirectory())
            throw new DeliveryError(
              'unsafe_destination',
              'Destination path contains a symlink or non-directory',
            );
        } catch (e: any) {
          if (e?.code !== 'ENOENT') throw e;
          await mkdir(dir, { mode: 0o700 });
          await chmod(dir, 0o700);
          createdDirs.push(dir);
        }
      }
      const filename = segments[segments.length - 1]!;
      const existing = await readdir(dir);
      if (
        existing.some((name) => name.toLowerCase() === filename.toLowerCase() && name !== filename)
      )
        throw new DeliveryError('collision', 'Destination contains a case-colliding path');
      const handle = await open(target, 'wx', 0o600);
      createdFiles.push(target);
      try {
        await handle.writeFile(file.text, 'utf8');
      } finally {
        await handle.close();
      }
      prepared.push({ path: file.path, kind: file.kind, absolutePath: target });
    }
  } catch (error) {
    for (const f of createdFiles.reverse()) await rm(f, { force: true }).catch(() => {});
    for (const d of createdDirs.reverse()) await rmdir(d).catch(() => {});
    throw error;
  }
  let cleaned = false;
  return {
    files: prepared,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      for (const f of [...createdFiles].reverse()) await rm(f, { force: true });
      for (const d of [...createdDirs].reverse()) await rmdir(d).catch(() => {});
    },
  };
}
