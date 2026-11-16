import { mkdtemp, mkdir, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BundleFile, VerifiedBundle, CompatibilityTarget } from '../types.js';
import { validatePayload, DeliveryError } from '../cache.js';
import { compatibilityIssues } from '../compatibility.js';

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
export interface NativePathMapping {
  instructionPath: string;
  skillRoot: string;
  memoryRoot: string;
}

/** Validate bundle content, then stage mapped native inputs in an owned private temp directory. */
export async function prepareNativeFiles(
  bundle: VerifiedBundle,
  mapping: NativePathMapping,
  prefix: string,
  target: Exclude<CompatibilityTarget, 'generic'> = 'codex',
): Promise<
  NativePreparation & {
    instructionPath: string | null;
    skillPaths: string[];
    memoryFiles: Array<{ path: string; text: string; absolutePath: string }>;
  }
> {
  if (process.platform === 'win32')
    throw new DeliveryError('unsupported_platform', 'Private filesystem helpers require POSIX');
  validatePayload(bundle.payload);
  const issues = compatibilityIssues(bundle.payload, target);
  if (issues.length)
    throw Object.assign(
      new DeliveryError(
        'invalid_payload',
        issues.map((issue) => `${issue.path ?? target}: ${issue.message}`).join('; '),
      ),
      { issues },
    );

  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const files: NativeFile[] = [];
  try {
    for (const source of bundle.payload.files) {
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
      const handle = await open(absolutePath, 'wx', 0o600);
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
