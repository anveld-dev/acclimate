import type { LoopAgent } from '../../sdk/src/learning/define.js';

interface CodexEvent {
  type: string;
  item?: { type: string; text?: string };
}
export interface CodexNativeClient {
  startThread(options: {
    model: string;
    modelReasoningEffort?: CodexEffort;
    workingDirectory: string;
    skipGitRepoCheck: boolean;
    approvalPolicy: 'never';
    sandboxMode: 'workspace-write';
  }): {
    runStreamed(prompt: string, options: { signal: AbortSignal }): Promise<{ events: AsyncIterable<CodexEvent> }>;
  };
}
type CodexEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'persistent';

export interface CodexLoopOptions<O = string> {
  model: string;
  effort?: CodexEffort;
  parse?: (message: string) => O | Promise<O>;
  client?: CodexNativeClient;
}

export function codex<O = string>(options: CodexLoopOptions<O>): LoopAgent<unknown, O> {
  return {
    model: options.model,
    async execute(input) {
      const { executeCodex } = await import('./native.js');
      return executeCodex(options, input);
    },
  };
}
