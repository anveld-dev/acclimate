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

import { transcriptTail } from '../../sdk/src/native-files.js';
import type { LoopExecute } from '../../sdk/src/learning/define.js';
import { prepare } from './index.js';
import type { ClaudeLoopOptions } from './learning.js';
export { claude } from './learning.js';
export type { ClaudeLoopOptions, ClaudeNativeClient } from './learning.js';

export async function executeClaude<O>(
  { model, effort, parse, query }: ClaudeLoopOptions<O>,
  { version, input, signal }: Parameters<LoopExecute<unknown>>[0],
) {
  const native = query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
  const prepared = await prepare(version);
  const abortController = new AbortController();
  const abort = () => abortController.abort(signal.reason);
  try {
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    const trace = transcriptTail();
    let final: string | undefined;
    for await (const event of native({
      prompt: typeof input === 'string' ? input : JSON.stringify(input),
      options: { ...claudeSessionOptions(prepared), model, effort, persistSession: false, abortController },
    })) {
      trace.add(event);
      if (event.type === 'result') {
        if (event.subtype !== 'success' || event.is_error) throw trace.failure('The Claude session failed.');
        final = event.result;
      }
    }
    signal.throwIfAborted();
    if (final === undefined) throw trace.failure('Claude returned no final message.');
    return { output: parse ? await parse(final) : final as O, trace: trace.text() };
  } finally {
    signal.removeEventListener('abort', abort);
    await prepared.cleanup();
  }
}
