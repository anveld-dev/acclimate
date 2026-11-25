import type { DeliveryReceiptRequest } from '../../sdk/src/types.js';
import { nativeSource, prepareNativeFiles } from '../../sdk/src/native-files.js';
import type { NativeInput } from '../../sdk/src/native-files.js';

/**
 * Project-scoped Claude settings copied from `baseDir` when you pass it. The
 * bundle still owns instructions and skills: `CLAUDE.md`, `CLAUDE.local.md`,
 * `.claude/skills/` and `.claude/settings.local.json` are never copied.
 */
export const CLAUDE_PROJECT_OVERLAY = Object.freeze([
  '.claude/settings.json',
  '.claude/agents',
  '.claude/commands',
  '.claude/hooks',
  '.claude/output-styles',
  '.mcp.json',
]);

export interface PrepareClaudeOptions {
  /** Accepted for parity with other plugins; filter memory in your application. */
  approvedMemoryPaths?: string[];
  /**
   * An existing checkout whose project settings, MCP servers, hooks and subagents
   * (see CLAUDE_PROJECT_OVERLAY) should apply to this session. Omit for a
   * workspace containing only the bundle.
   */
  baseDir?: string;
}

export interface PreparedClaudeVersion {
  cwd: string;
  versionId: string;
  digest: string;
  /** Pass to Claude Agent SDK options; selects project resources in this workspace. */
  settingSources: ['project'];
  instructionPath: string | null;
  skillPaths: string[];
  /** Memory remains explicit host context; it is not claimed as an SDK memory option. */
  memoryFiles: Array<{ path: string; text: string; absolutePath: string }>;
  /** Project files copied from `baseDir`, with digests for your runtime identity. */
  overlayFiles: Array<{ path: string; sha256: string; bytes: number }>;
  /** Queue the delivery's start receipt when `prepare` received `client.prepare()` output; otherwise null. */
  reportStarted(): Readonly<DeliveryReceiptRequest> | null;
  /** Remove the prepared workspace, then release the delivery it came from. */
  cleanup(): Promise<void>;
}

/** Stage instructions and skills for a fresh Claude project workspace. */
export async function prepare(
  version: NativeInput,
  options: PrepareClaudeOptions = {},
): Promise<PreparedClaudeVersion> {
  const { version: verified, reportStarted, release } = nativeSource(version);
  const staged = await prepareNativeFiles(verified, {
    mapping: {
      instructionPath: 'CLAUDE.md',
      skillRoot: '.claude/skills',
      memoryRoot: '.acclimate/memory',
    },
    prefix: 'acclimate-claude-',
    target: 'claude',
    ...(options.baseDir ? { overlay: { baseDir: options.baseDir, paths: CLAUDE_PROJECT_OVERLAY } } : {}),
  });
  return {
    cwd: staged.cwd,
    versionId: verified.version.id,
    digest: verified.version.digest,
    settingSources: ['project'],
    instructionPath: staged.instructionPath,
    skillPaths: staged.skillPaths,
    memoryFiles: staged.memoryFiles,
    overlayFiles: staged.overlayFiles,
    reportStarted,
    async cleanup() {
      await staged.cleanup();
      await release();
    },
  };
}
