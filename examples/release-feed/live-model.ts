import type { ThreadEvent, Usage } from '@openai/codex-sdk';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const liveModels = {
  proposer: 'gpt-6.2-sol',
  harness: 'gpt-6-luna',
} as const;
export type LiveModelRole = keyof typeof liveModels;
export const defaultLiveModelTimeoutMs = 110_000;
export const liveModelMaximumCalls = 39;
export const liveModelBudgetProfiles = {
  'repair-qualification-v1': 112,
} as const;
export type LiveModelBudgetProfile = keyof typeof liveModelBudgetProfiles;

export type LiveModelOptions = {
  appRoot: string;
  artifactRoot: string;
  callId: string;
  prompt: string;
  schema?: unknown;
  role: LiveModelRole;
  maxCalls: number;
  budgetProfile?: LiveModelBudgetProfile;
  timeoutMs?: number;
  reconcileOnly?: boolean;
};

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
};

export type LiveModelResult = {
  text: string;
  usage: ModelUsage;
  threadId: string;
  elapsedMs: number;
  model: string;
  artifactPath: string;
};

function existsError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
}

async function writeEvidence(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
    flush: true,
  });
}

async function reserveTurn(root: string, maxCalls: number, callId: string) {
  const slots = path.join(root, 'slots');
  await mkdir(slots, { recursive: true, mode: 0o700 });
  for (let slot = 1; slot <= maxCalls; slot++) {
    try {
      await writeEvidence(path.join(slots, String(slot) + '.json'), { callId, slot });
      return slot;
    } catch (error) {
      if (!existsError(error, 'EEXIST')) throw error;
    }
  }
  throw new Error('Live model call budget exhausted');
}

function runCodex(
  appRoot: string,
  model: string,
  prompt: string,
  timeoutMs: number,
  schema?: string,
) {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--model',
    model,
    '--config',
    'approval_policy="never"',
    '--config',
    'web_search="disabled"',
    '--config',
    'model_reasoning_effort="low"',
    '--config',
    'features.shell_tool=false',
    '--config',
    'features.multi_agent_v2=false',
    '--config',
    'agents.enabled=false',
    '--config',
    'features.plugins=false',
    '--config',
    'features.remote_plugin=false',
    '--config',
    'features.enable_mcp_apps=false',
    '--config',
    'features.skip_host_skill_discovery=true',
    '--config',
    'mcp_servers={}',
    '--config',
    'project_doc_max_bytes=0',
  ];
  if (schema) args.push('--output-schema', schema);
  args.push('-');
  const env = {
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot,
  };
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'codex',
      args,
      {
        cwd: appRoot,
        env,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(error.killed ? 'Codex call exceeded its time limit' : 'Codex call failed'),
          );
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
  });
}

function parseTurn(stdout: string) {
  let threadId: string | undefined;
  let usage: Usage | undefined;
  let text: string | undefined;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line) as ThreadEvent;
    switch (event.type) {
      case 'thread.started':
        threadId = event.thread_id;
        break;
      case 'turn.completed':
        usage = event.usage;
        break;
      case 'turn.failed':
      case 'error':
        throw new Error('Codex reported a failed turn');
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        if (!['agent_message', 'reasoning', 'error'].includes(event.item.type)) {
          throw new Error('Codex attempted a tool action during a prompt-only turn');
        }
        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          text = event.item.text;
        }
        break;
    }
  }
  if (!threadId || !text?.trim() || !usage) {
    throw new Error('Codex returned incomplete response evidence');
  }
  const tokenCounts: ModelUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    cacheWriteInputTokens: usage.cache_write_input_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
  for (const count of [tokenCounts.inputTokens, tokenCounts.outputTokens]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Codex returned invalid usage');
  }
  return { threadId, usage: tokenCounts, text };
}

/** A reserved call with no retained result is ambiguous and is never retried automatically. */
export function callLiveModel(
  options: LiveModelOptions & { reconcileOnly?: false },
): Promise<LiveModelResult>;
export function callLiveModel(options: LiveModelOptions): Promise<LiveModelResult | undefined>;
export async function callLiveModel(
  options: LiveModelOptions,
): Promise<LiveModelResult | undefined> {
  const { callId, prompt, schema, role, maxCalls, timeoutMs = defaultLiveModelTimeoutMs } = options;
  const model = liveModels[role];
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(callId)) throw new Error('Invalid live model call ID');
  const maximum = options.budgetProfile === undefined
    ? liveModelMaximumCalls
    : liveModelBudgetProfiles[options.budgetProfile];
  if (
    !Number.isSafeInteger(maxCalls) || !maximum || maxCalls < 1 || maxCalls > maximum ||
    (options.budgetProfile !== undefined && maxCalls !== maximum)
  ) {
    throw new Error('Invalid live model call budget');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultLiveModelTimeoutMs) {
    throw new Error('Invalid live model timeout');
  }
  const appRoot = await realpath(options.appRoot);
  const ledger = path.join(options.artifactRoot, 'model-calls');
  await mkdir(ledger, { recursive: true, mode: 0o700 });
  const root = await realpath(ledger);
  if (within(appRoot, root) || within(root, appRoot)) {
    throw new Error('Model workspace and call evidence directories must be disjoint');
  }
  const calls = path.join(root, 'calls');
  await mkdir(calls, { recursive: true, mode: 0o700 });
  const call = path.join(calls, callId);
  const artifactPath = path.join(call, 'result.json');
  const requestDigest = createHash('sha256')
    .update(JSON.stringify({ prompt, schema, role, model }))
    .digest('hex');
  const readRetained = async () => {
    const retained = await readFile(artifactPath, 'utf8').catch((readError: unknown) => {
      if (!existsError(readError, 'ENOENT')) throw readError;
      throw new Error('Live model call has no retained result and cannot be replayed');
    });
    const result = JSON.parse(retained) as LiveModelResult & {
      requestDigest: string;
      role: LiveModelRole;
    };
    if (result.requestDigest !== requestDigest || result.role !== role || result.model !== model)
      throw new Error('Live model call ID reused');
    return { ...result, artifactPath };
  };
  if (options.reconcileOnly) {
    const present = await realpath(call).catch((error: unknown) => {
      if (!existsError(error, 'ENOENT')) throw error;
      return undefined;
    });
    return present ? readRetained() : undefined;
  }
  try {
    await mkdir(call, { mode: 0o700 });
  } catch (error) {
    if (!existsError(error, 'EEXIST')) throw error;
    return readRetained();
  }

  const slot = await reserveTurn(root, maxCalls, callId);
  await writeEvidence(path.join(call, 'request.json'), {
    requestDigest,
    role,
    model,
    slot,
    ...(options.budgetProfile && { budgetProfile: options.budgetProfile, maxCalls }),
  });
  let schemaFile: string | undefined;
  if (schema !== undefined) {
    schemaFile = path.join(call, 'schema.json');
    await writeEvidence(schemaFile, schema);
  }
  const started = Date.now();
  try {
    const response = parseTurn(await runCodex(appRoot, model, prompt, timeoutMs, schemaFile));
    const result = { ...response, model, elapsedMs: Date.now() - started, artifactPath };
    const pending = path.join(call, 'result.pending.json');
    await writeEvidence(pending, { ...result, requestDigest, role, slot });
    await rename(pending, artifactPath);
    return result;
  } catch (error) {
    const message =
      error instanceof Error && !(error instanceof SyntaxError)
        ? error.message
        : 'Codex returned malformed response evidence';
    await writeEvidence(path.join(call, 'failure.json'), {
      message,
      elapsedMs: Date.now() - started,
    });
    throw new Error(message);
  }
}
