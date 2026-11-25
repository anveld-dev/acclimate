/**
 * Claude Agent SDK, end to end, in one application module.
 *
 * Delivery (a paid provider call):
 *   tsx examples/claude-agent.ts --live "Summarize the project guidance"
 *   client.prepare() -> prepare(delivery) -> query() -> reportStarted() at session init
 *   -> retain the result -> cleanup
 *
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { AcclimateClient, createReceiptReporter } from '@acclimate/sdk';
import type { PreparedDelivery, VerifiedVersion } from '@acclimate/sdk';
import { prepare } from '@acclimate/claude-plugin';
import { claudeSessionOptions } from '@acclimate/claude-plugin/native';

/** Explicit tool and sandbox policy. Record changes to it as a new runtime revision. */
const sessionPolicy = {
  permissionMode: 'dontAsk',
  allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
  disallowedTools: ['WebFetch', 'WebSearch'],
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
  persistSession: false,
} satisfies Options;

export interface ClaudeRun {
  output: string;
  status: 'completed' | 'task_failed';
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd: number } | undefined;
}

function requiredModel(): string {
  const model = process.env.CLAUDE_MODEL;
  if (!model) throw new Error('Set CLAUDE_MODEL to a Claude model your account can use.');
  return model;
}

/**
 * Run one fresh Claude session on a verified version. The prepared workspace is
 * removed only after the query finished; if its end is unknown the files stay for
 * inspection and the error propagates.
 */
export async function runClaude(
  input: VerifiedVersion | PreparedDelivery,
  { prompt, model, signal }: { prompt: string; model: string; signal?: AbortSignal },
): Promise<ClaudeRun> {
  const prepared = await prepare(input);
  const abortController = new AbortController();
  const onAbort = () => abortController.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let finished = false;
  try {
    let sessionId: string | null = null;
    let result: SDKResultMessage | undefined;
    const memory = prepared.memoryFiles.map((file) => file.absolutePath);
    for await (const message of query({
      prompt: memory.length ? `${prompt}\nApproved memory files:\n${memory.join('\n')}` : prompt,
      options: { ...claudeSessionOptions(prepared), ...sessionPolicy, model, abortController },
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        // The job really started: queue the delivery receipt (null when reporting is off).
        prepared.reportStarted();
      }
      if (message.type === 'result') result = message;
    }
    // The iterator completed, so the Claude Code process for this query has exited.
    finished = true;
    if (!result) return { output: '', status: 'task_failed', sessionId, usage: undefined };
    const usage = {
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      costUsd: result.total_cost_usd,
    };
    return result.subtype === 'success'
      ? { output: result.result, status: 'completed', sessionId, usage }
      : { output: result.errors.join('\n'), status: 'task_failed', sessionId, usage };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (finished) await prepared.cleanup();
    else console.error(`Claude session end is unknown; inputs kept at ${prepared.cwd}`);
  }
}

// ---- Delivery: run the current channel version for one real job. ----

async function main() {
  if (!process.argv.includes('--live'))
    throw new Error('Pass --live to request a paid Claude session.');
  const prompt = process.argv.slice(2).filter((argument) => argument !== '--live').join(' ').trim();
  const { ACCLIMATE_URL, ACCLIMATE_TOKEN, ACCLIMATE_SCOPE, ACCLIMATE_WORKSPACE, ACCLIMATE_BUNDLE } =
    process.env;
  const jobDirectory = process.env.ACCLIMATE_JOB_DIR;
  const connectionId = process.env.ACCLIMATE_CONNECTION;
  if (!ACCLIMATE_URL || !ACCLIMATE_TOKEN || !ACCLIMATE_SCOPE || !ACCLIMATE_WORKSPACE || !ACCLIMATE_BUNDLE || !connectionId || !jobDirectory || !prompt)
    throw new Error(
      'Set ACCLIMATE_URL, ACCLIMATE_TOKEN, ACCLIMATE_SCOPE, ACCLIMATE_WORKSPACE, ACCLIMATE_BUNDLE, ACCLIMATE_CONNECTION and ACCLIMATE_JOB_DIR, and pass a task.',
    );
  const client = new AcclimateClient({ baseUrl: ACCLIMATE_URL, token: ACCLIMATE_TOKEN, scope: ACCLIMATE_SCOPE, connectionId });
  const receiptToken = process.env.ACCLIMATE_RECEIPT_TOKEN;
  const reporter =
    receiptToken
      ? createReceiptReporter({
          workspaceId: ACCLIMATE_WORKSPACE,
          connectionId,
          client: new AcclimateClient({
            baseUrl: ACCLIMATE_URL,
            token: receiptToken,
            scope: `${ACCLIMATE_SCOPE}:receipts`,
            timeoutMs: 1000,
            retries: 0,
          }),
        })
      : undefined;
  // cacheDir defaults to defaultCacheDir(): ~/.cache/acclimate/typescript.
  const delivery = await client.prepare({
    workspaceId: ACCLIMATE_WORKSPACE,
    bundleId: ACCLIMATE_BUNDLE,
    channel: process.env.ACCLIMATE_CHANNEL ?? 'stable',
    cacheDir: process.env.ACCLIMATE_CACHE,
    reporter,
  });
  try {
    const run = await runClaude(delivery, { prompt, model: requiredModel() });
    // Retain the result outside the prepared workspace; never overwrite an earlier run.
    const retained = await open(join(jobDirectory, 'acclimate-agent-result.json'), 'wx', 0o600);
    try {
      await retained.writeFile(
        JSON.stringify({ versionId: delivery.version.version.id, digest: delivery.version.version.digest, ...run }) + '\n',
      );
      await retained.sync();
    } finally {
      await retained.close();
    }
    console.log({ versionId: delivery.version.version.id, digest: delivery.version.version.digest, status: run.status });
  } finally {
    await reporter?.flush();
    reporter?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
