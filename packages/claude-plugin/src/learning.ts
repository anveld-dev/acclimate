import type { LoopAgent } from '../../sdk/src/learning/define.js';

interface ClaudeEvent {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
}
type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ClaudeNativeClient = (request: {
  prompt: string;
  options: {
    model: string;
    effort?: ClaudeEffort;
    cwd: string;
    settingSources: ['project'];
    skills?: string[];
    persistSession: false;
    abortController: AbortController;
  };
}) => AsyncIterable<ClaudeEvent>;

export interface ClaudeLoopOptions<O = string> {
  model: string;
  effort?: ClaudeEffort;
  parse?: (message: string) => O | Promise<O>;
  query?: ClaudeNativeClient;
}

export function claude<O = string>(options: ClaudeLoopOptions<O>): LoopAgent<unknown, O> {
  return {
    model: options.model,
    async execute(input) {
      const { executeClaude } = await import('./native.js');
      return executeClaude(options, input);
    },
  };
}
