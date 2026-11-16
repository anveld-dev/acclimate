import type { VerifiedBundle } from '../../sdk/src/types.js';
import { prepareNativeFiles } from '../../sdk/src/internal/native-files.js';

export interface PreparedCodexBundle {
  cwd: string;
  versionId: string;
  digest: string;
  instructionPath: string | null;
  skillPaths: string[];
  memoryFiles: Array<{ path: string; text: string; absolutePath: string }>;
  cleanup(): Promise<void>;
}

/** Stage verified bundle resources where Codex natively discovers repository instructions and skills. */
export async function prepare(bundle: VerifiedBundle): Promise<PreparedCodexBundle> {
  const staged = await prepareNativeFiles(
    bundle,
    {
      instructionPath: 'AGENTS.md',
      skillRoot: '.agents/skills',
      memoryRoot: '.acclimate/memory',
    },
    'acclimate-codex-',
    'codex',
  );
  return {
    cwd: staged.cwd,
    versionId: bundle.version.id,
    digest: bundle.version.digest,
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
