import type { DeliveryReceiptRequest } from '../../sdk/src/types.js';
import { nativeSource, prepareNativeFiles } from '../../sdk/src/native-files.js';
import type { NativeInput } from '../../sdk/src/native-files.js';

export interface PreparedPiVersion {
  cwd: string;
  versionId: string;
  digest: string;
  instructionPath: string | null;
  skillPaths: string[];
  /** The host passes these as selected context to its session; Pi has no assumed memory option here. */
  memoryFiles: Array<{ path: string; text: string; absolutePath: string }>;
  /** The host builds a ResourceLoader from these paths using the installed Pi SDK types. */
  resources: Array<{
    path: string;
    kind: 'instruction' | 'skill' | 'memory';
    absolutePath: string;
  }>;
  /** Queue the delivery's start receipt when `prepare` received `client.prepare()` output; otherwise null. */
  reportStarted(): Readonly<DeliveryReceiptRequest> | null;
  /** Remove the prepared workspace, then release the delivery it came from. */
  cleanup(): Promise<void>;
}

/** Stage verified files in a private workspace for a host-owned Pi ResourceLoader/session. */
export async function prepare(
  input: NativeInput,
  _options: { approvedMemoryPaths?: string[] } = {},
): Promise<PreparedPiVersion> {
  const { bundle, reportStarted, release } = nativeSource(input);
  const staged = await prepareNativeFiles(bundle, {
    mapping: {
      instructionPath: 'AGENTS.md',
      skillRoot: '.agents/skills',
      memoryRoot: '.acclimate/memory',
    },
    prefix: 'acclimate-pi-',
    target: 'pi',
  });
  const resources = staged.files.map(({ sourcePath, kind, absolutePath }) => ({
    path: sourcePath,
    kind,
    absolutePath,
  }));
  return {
    cwd: staged.cwd,
    versionId: bundle.version.id,
    digest: bundle.version.digest,
    instructionPath: staged.instructionPath,
    skillPaths: staged.skillPaths,
    memoryFiles: staged.memoryFiles,
    resources,
    reportStarted,
    async cleanup() {
      await staged.cleanup();
      await release();
    },
  };
}

/** @deprecated Use PreparedPiVersion. */
export type PreparedPiBundle = PreparedPiVersion;
