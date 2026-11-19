import type { DeliveryReceiptRequest } from '../../sdk/src/types.js';
import { nativeSource, prepareNativeFiles } from '../../sdk/src/native-files.js';
import type { NativeInput } from '../../sdk/src/native-files.js';

export interface PreparedCodexVersion {
  cwd: string;
  versionId: string;
  digest: string;
  instructionPath: string | null;
  skillPaths: string[];
  memoryFiles: Array<{ path: string; text: string; absolutePath: string }>;
  /** Queue the delivery's start receipt when `prepare` received `client.prepare()` output; otherwise null. */
  reportStarted(): Readonly<DeliveryReceiptRequest> | null;
  /** Remove the prepared workspace, then release the delivery it came from. */
  cleanup(): Promise<void>;
}

/** Stage verified bundle resources where Codex natively discovers repository instructions and skills. */
export async function prepare(
  input: NativeInput,
  _options: { approvedMemoryPaths?: string[] } = {},
): Promise<PreparedCodexVersion> {
  const { bundle, reportStarted, release } = nativeSource(input);
  const staged = await prepareNativeFiles(bundle, {
    mapping: {
      instructionPath: 'AGENTS.md',
      skillRoot: '.agents/skills',
      memoryRoot: '.acclimate/memory',
    },
    prefix: 'acclimate-codex-',
    target: 'codex',
  });
  return {
    cwd: staged.cwd,
    versionId: bundle.version.id,
    digest: bundle.version.digest,
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

/** @deprecated Use PreparedCodexVersion. */
export type PreparedCodexBundle = PreparedCodexVersion;
