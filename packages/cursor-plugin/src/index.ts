import type { DeliveryReceiptRequest, VerifiedVersion } from '../../sdk/src/types.js';
import { DeliveryError, validatePayload } from '../../sdk/src/cache.js';
import { nativeSource, prepareNativeFiles } from '../../sdk/src/native-files.js';
import type { NativeInput } from '../../sdk/src/native-files.js';

export interface PreparedCursorVersion {
  cwd: string;
  versionId: string;
  digest: string;
  settingSources: ['project'];
  instructionPath: string | null;
  skillPaths: string[];
  /** Available to the host for explicit selection; never automatically added to a prompt. */
  memoryFiles: Array<{ path: string; text: string; absolutePath: string }>;
  /** Queue the delivery's start receipt when `prepare` received `client.prepare()` output; otherwise null. */
  reportStarted(): Readonly<DeliveryReceiptRequest> | null;
  /** Remove the prepared workspace, then release the delivery it came from. */
  cleanup(): Promise<void>;
}

/** Prepare native project resources in a private, owned workspace for a fresh local agent. */
export async function prepare(
  input: NativeInput,
  options: { approvedMemoryPaths?: string[] } = {},
): Promise<PreparedCursorVersion> {
  const { bundle, reportStarted, release } = nativeSource(input);
  validatePayload(bundle.payload);
  const approved = new Set(options.approvedMemoryPaths ?? []);
  for (const selected of approved) {
    if (!bundle.payload.files.some((file) => file.kind === 'memory' && file.path === selected))
      throw new DeliveryError('invalid_payload', `Approved memory not found: ${selected}`);
  }
  const selectedBundle: VerifiedVersion = {
    ...bundle,
    payload: {
      ...bundle.payload,
      files: bundle.payload.files.filter(
        (file) => file.kind !== 'memory' || approved.has(file.path),
      ),
    },
  };
  const staged = await prepareNativeFiles(selectedBundle, {
    mapping: {
      instructionPath: 'AGENTS.md',
      skillRoot: '.cursor/skills',
      memoryRoot: '.acclimate/memory',
    },
    prefix: 'acclimate-cursor-',
    target: 'cursor',
  });
  return {
    cwd: staged.cwd,
    versionId: bundle.version.id,
    digest: bundle.version.digest,
    settingSources: ['project'],
    instructionPath: staged.instructionPath,
    skillPaths: staged.skillPaths,
    memoryFiles: staged.memoryFiles,
    reportStarted,
    async cleanup() {
      await staged.cleanup();
      await release();
    },
  };
}

/** @deprecated Use PreparedCursorVersion. */
export type PreparedCursorBundle = PreparedCursorVersion;
