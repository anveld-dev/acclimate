import type { PreparedClaudeBundle } from './index.js';

/** Options for a fresh Claude Agent SDK session. The host supplies model, prompt and permissions. */
export function claudeSessionOptions(
  prepared: PreparedClaudeBundle,
): Pick<import('@anthropic-ai/claude-agent-sdk').Options, 'cwd' | 'settingSources' | 'skills'> {
  return {
    cwd: prepared.cwd,
    settingSources: prepared.settingSources,
    skills: prepared.skillPaths.map((file) => file.split(/[\\/]/).at(-2)!),
  };
}
