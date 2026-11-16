import type { VerifiedBundle } from '../../sdk/src/types.js';
import { DeliveryError, validatePayload } from '../../sdk/src/cache.js';
import { prepareNativeFiles } from '../../sdk/src/internal/native-files.js';

export interface PreparedCursorBundle {
  cwd: string;
  versionId: string;
  digest: string;
  settingSources: ['project'];
  instructionPath: string | null;
  skillPaths: string[];
  /** Available to the host for explicit selection; never automatically added to a prompt. */
  memoryFiles: Array<{ path: string; text: string; absolutePath: string }>;
  cleanup(): Promise<void>;
}

/** Prepare native project resources in a private, owned workspace for a fresh local agent. */
export async function prepare(
  bundle: VerifiedBundle,
  options: { approvedMemoryPaths?: string[] } = {},
): Promise<PreparedCursorBundle> {
  validatePayload(bundle.payload);
  const approved = new Set(options.approvedMemoryPaths ?? []);
  for (const selected of approved) {
    if (!bundle.payload.files.some((file) => file.kind === 'memory' && file.path === selected))
      throw new DeliveryError('invalid_payload', `Approved memory not found: ${selected}`);
  }
  const selectedBundle: VerifiedBundle = {
    ...bundle,
    payload: {
      ...bundle.payload,
      files: bundle.payload.files.filter(
        (file) => file.kind !== 'memory' || approved.has(file.path),
      ),
    },
  };
  const staged = await prepareNativeFiles(
    selectedBundle,
    {
      instructionPath: 'AGENTS.md',
      skillRoot: '.cursor/skills',
      memoryRoot: '.acclimate/memory',
    },
    'acclimate-cursor-',
    'cursor',
  );
  return {
    cwd: staged.cwd,
    versionId: bundle.version.id,
    digest: bundle.version.digest,
    settingSources: ['project'],
    instructionPath: staged.files.find((f) => f.kind === 'instruction')?.absolutePath ?? null,
    skillPaths: staged.files
      .filter((f) => f.kind === 'skill' && f.path.endsWith('/SKILL.md'))
      .map((f) => f.absolutePath),
    memoryFiles: staged.files
      .filter((f) => f.kind === 'memory')
      .map((f) => ({ path: f.sourcePath, text: f.text, absolutePath: f.absolutePath })),
    cleanup: staged.cleanup,
  };
}
