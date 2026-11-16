import type { VerifiedBundle } from '../../sdk/src/types.js';
import { prepareNativeFiles } from '../../sdk/src/internal/native-files.js';

export interface PreparedPiBundle {
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
  cleanup(): Promise<void>;
}

/** Stage verified files in a private workspace for a host-owned Pi ResourceLoader/session. */
export async function prepare(bundle: VerifiedBundle): Promise<PreparedPiBundle> {
  const staged = await prepareNativeFiles(
    bundle,
    {
      instructionPath: 'AGENTS.md',
      skillRoot: '.agents/skills',
      memoryRoot: '.acclimate/memory',
    },
    'acclimate-pi-',
    'pi',
  );
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
    cleanup: staged.cleanup,
  };
}
