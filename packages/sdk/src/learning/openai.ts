import { setTimeout as delay } from 'node:timers/promises';
import { withVersionHelpers } from '../evaluation/definition.js';
import type { VerifiedVersion } from '../types.js';
import type { LoopExecute } from './define.js';
import { TranscriptError } from './trace.js';

export interface OpenAIOptions<O = string> {
  model: string;
  baseURL?: string;
  apiKey?: string;
  effort?: string;
  parse?: (text: string) => O | Promise<O>;
  render?: (version: VerifiedVersion) => string | Promise<string>;
}

export class OpenAIHttpError extends TranscriptError {
  override name = 'OpenAIHttpError';

  constructor(readonly status: number, trace: string) {
    super(`OpenAI-compatible endpoint returned HTTP ${status}.`, trace);
  }
}

function renderBundle(version: VerifiedVersion): string {
  const { instructionFiles, skillFiles, memoryFiles } = withVersionHelpers({ version });
  return [...instructionFiles, ...skillFiles, ...memoryFiles]
    .map(file => `# ${file.path}\n${file.text}`)
    .join('\n\n');
}

function retryDelay(header: string | null, attempt: number): number {
  if (header && /^\d+$/.test(header)) return Number(header) * 1000;
  const date = header ? Date.parse(header) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 250 * 2 ** attempt;
}

function redact(value: unknown, apiKey: string): unknown {
  if (typeof value === 'string') return value.replaceAll(apiKey, '[redacted]');
  if (Array.isArray(value)) return value.map(item => redact(item, apiKey));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key.replaceAll(apiKey, '[redacted]'), redact(item, apiKey)]));
  return value;
}

function completionTrace(fields: Record<string, unknown>, apiKey: string | undefined): string {
  return JSON.stringify(apiKey
    ? Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redact(value, apiKey)]))
    : fields);
}

type LoopInput = Parameters<LoopExecute<unknown>>[0];
type RolloutInput = Pick<LoopInput, 'version' | 'input' | 'signal'> & Partial<LoopInput>;

export function openai<O = string>(options: OpenAIOptions<O>) {
  const { model, effort, parse, render = renderBundle } = options;
  const baseURL = options.baseURL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions';

  return {
    model,
    async execute({ version, input, signal }: RolloutInput) {
      const body = JSON.stringify({
        model,
        reasoning_effort: effort,
        messages: [
          { role: 'system', content: await render(version) },
          { role: 'user', content: typeof input === 'string' ? input : JSON.stringify(input) },
        ],
      });
      const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };

      for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, { method: 'POST', headers, body, signal, redirect: 'manual' });
        const raw = await response.text();
        if (!response.ok) {
          if (attempt < 2 && (response.status === 429 || (response.status >= 500 && response.status <= 599))) {
            const wait = retryDelay(response.headers.get('retry-after'), attempt);
            if (wait <= 5000) {
              await delay(wait, undefined, { signal });
              continue;
            }
          }
          let error: unknown = raw;
          try { error = JSON.parse(raw); } catch { /* Keep plain-text errors as sent. */ }
          throw new OpenAIHttpError(response.status, completionTrace({ error }, apiKey));
        }

        let result: {
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: unknown;
        } | null;
        try {
          result = JSON.parse(raw);
        } catch {
          throw new TranscriptError('OpenAI-compatible endpoint returned invalid JSON.', completionTrace({ error: raw }, apiKey));
        }
        const choice = result?.choices?.[0];
        const text = choice?.message?.content;
        const trace = completionTrace({ text: text ?? null, finish_reason: choice?.finish_reason ?? null, usage: result?.usage ?? null }, apiKey);
        if (typeof text !== 'string') throw new TranscriptError('OpenAI-compatible endpoint returned no assistant text.', trace);
        try {
          return { output: parse ? await parse(text) : text as O, trace };
        } catch {
          throw new TranscriptError('Could not parse assistant text.', trace);
        }
      }
    },
  };
}
