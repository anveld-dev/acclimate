import { transcriptTail } from '../../sdk/src/native-files.js';
import type { LoopExecute } from '../../sdk/src/learning/define.js';
import { prepare } from './index.js';
import type { CodexLoopOptions } from './learning.js';
export { codex } from './learning.js';
export type { CodexLoopOptions, CodexNativeClient } from './learning.js';

export async function executeCodex<O>(
  { model, effort, parse, client }: CodexLoopOptions<O>,
  { version, input, signal }: Parameters<LoopExecute<unknown>>[0],
) {
  const native = client ?? new (await import('@openai/codex-sdk')).Codex();
  const prepared = await prepare(version);
  try {
    signal.throwIfAborted();
    const thread = native.startThread({
      model, modelReasoningEffort: effort, workingDirectory: prepared.cwd,
      skipGitRepoCheck: true, approvalPolicy: 'never', sandboxMode: 'workspace-write',
    });
    const { events } = await thread.runStreamed(typeof input === 'string' ? input : JSON.stringify(input), { signal });
    const trace = transcriptTail();
    let final: string | undefined;
    for await (const event of events) {
      trace.add(event);
      if (event.type === 'turn.failed') throw trace.failure('The Codex turn failed.');
      if (event.type === 'item.completed' && event.item?.type === 'agent_message')
        final = event.item.text;
    }
    signal.throwIfAborted();
    if (final === undefined) throw trace.failure('Codex returned no final message.');
    return { output: parse ? await parse(final) : final as O, trace: trace.text() };
  } finally {
    await prepared.cleanup();
  }
}
