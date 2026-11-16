import type { VerifiedBundle } from '../../sdk/src/types.js';
import { prepareNativeFiles } from '../../sdk/src/internal/native-files.js';

export interface PreparedClaudeBundle {
  cwd: string;
  versionId: string;
  digest: string;
  /** Pass to Claude Agent SDK options; selects project resources in this workspace. */
  settingSources: ['project'];
  instructionPath: string | null;
  skillPaths: string[];
  /** Memory remains explicit host context; it is not claimed as an SDK memory option. */
  memoryFiles: Array<{ path: string; text: string; absolutePath: string }>;
  cleanup(): Promise<void>;
}

/** Stage instructions and skills for a fresh Claude project workspace. */
export async function prepare(bundle: VerifiedBundle): Promise<PreparedClaudeBundle> {
  const staged = await prepareNativeFiles(
    bundle,
    {
      instructionPath: 'CLAUDE.md',
      skillRoot: '.claude/skills',
      memoryRoot: '.acclimate/memory',
    },
    'acclimate-claude-',
    'claude',
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
