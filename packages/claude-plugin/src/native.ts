import type { PreparedClaudeVersion } from './index.js';

/**
 * Options for a fresh Claude Agent SDK session. The host supplies model, prompt and
 * permissions. `skills` is omitted when the bundle has none: an empty list would
 * disable every skill in the Agent SDK.
 */
export function claudeSessionOptions(
  prepared: Pick<PreparedClaudeVersion, 'cwd' | 'settingSources' | 'skillPaths'>,
) {
  const skills = prepared.skillPaths.map((file) => file.split(/[\\/]/).at(-2)!);
  return {
    cwd: prepared.cwd,
    settingSources: prepared.settingSources,
    ...(skills.length ? { skills } : {}),
  };
}
