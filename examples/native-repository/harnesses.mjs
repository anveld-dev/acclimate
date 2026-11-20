import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const STARTER = path.dirname(HERE);

/** Harnesses that ship with this starter. `replay` is the offline fake: no SDK, no model. */
export const BUILT_IN_HARNESSES = Object.freeze(['codex', 'claude', 'pi', 'cursor', 'replay']);

/**
 * Explicit sandbox and tool defaults for each built-in adapter. They are part of
 * the runtime identity.
 */
export const HARNESS_POLICIES = Object.freeze({
  codex: Object.freeze({
    sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled',
  }),
  claude: Object.freeze({
    permissionMode: 'dontAsk',
    allowedTools: Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']),
    disallowedTools: Object.freeze(['WebFetch', 'WebSearch']),
    sandbox: Object.freeze({ enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false }),
  }),
  cursor: Object.freeze({ sandboxOptions: Object.freeze({ enabled: true }) }),
  pi: Object.freeze({ tools: Object.freeze(['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls']) }),
  replay: Object.freeze({}),
});

/** Credential variables each adapter may receive. Values never enter the runtime identity. */
export const CREDENTIAL_ENV = Object.freeze({
  codex: Object.freeze(['OPENAI_API_KEY', 'CODEX_API_KEY']),
  claude: Object.freeze(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']),
  cursor: Object.freeze(['CURSOR_API_KEY']),
  pi: Object.freeze(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']),
  replay: Object.freeze([]),
});

/**
 * Public harness adapter contract. `prepare(version, { approvedMemoryPaths })`
 * stages the verified version in a new private directory directly under the
 * worker's TMPDIR and returns `{ cwd, versionId, digest, instructionPath,
 * skillPaths, memoryFiles, cleanup }` (see `prepareNativeFiles` in
 * `@acclimate/sdk/native-files`). `run(task)` runs one fresh turn in `task.context.cwd`
 * inside its own process group and resolves the `runRepositoryJob` result shape.
 * `identity` is JSON describing everything else that changes behavior.
 */
export function defineHarness({ name, prepare, run, identity = {} }) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name))
    throw new TypeError('defineHarness: name must be a lowercase identifier such as my-agent');
  if (typeof prepare !== 'function') throw new TypeError('defineHarness: prepare(version, options) is required');
  if (typeof run !== 'function') throw new TypeError('defineHarness: run(task) is required');
  return Object.freeze({ name, prepare, run, identity: JSON.parse(JSON.stringify(identity)) });
}

async function prepareReplay(version) {
  const { prepareNativeFiles } = await import('@acclimate/sdk/native-files');
  const staged = await prepareNativeFiles(version, {
    mapping: { instructionPath: 'AGENTS.md', skillRoot: '.agents/skills', memoryRoot: '.acclimate/memory' },
    prefix: 'acclimate-replay-',
    target: 'codex',
  });
  return { ...staged, versionId: version.version.id, digest: version.version.digest };
}

/** Registry of harnesses available to the application. */
export async function installedHarness(name) {
  const run = (exportName) => ({ module: HERE, exportName });
  switch (name) {
    case 'codex':
      return { name, prepare: (await import('@acclimate/codex-plugin')).prepare, run: run('runCodexTask') };
    case 'claude':
      return { name, prepare: (await import('@acclimate/claude-plugin')).prepare, run: run('runClaudeTask') };
    case 'pi':
      return { name, prepare: (await import('@acclimate/pi-plugin')).prepare, run: run('runPiTask') };
    case 'cursor':
      return { name, prepare: (await import('@acclimate/cursor-plugin')).prepare, run: run('runCursorTask') };
    case 'replay':
      // The replay fake needs only @acclimate/sdk: AGENTS.md/.agents/skills layout, no provider SDK.
      return { name, prepare: prepareReplay, run: run('runReplayTask') };
    default:
      throw new Error(`native.unsupported_harness: ${JSON.stringify(String(name))} (use one of ${BUILT_IN_HARNESSES.join(', ')} or { "name", "module" })`);
  }
}

/**
 * Resolve a native.json harness entry: a built-in name, or
 * `{ "name": "my-agent", "module": "./my-harness.mjs", "export": "harness" }` for an
 * application module inside this starter that exports `defineHarness(...)`.
 */
export async function loadHarness(spec, directory = STARTER) {
  if (typeof spec === 'string') {
    const installed = await installedHarness(spec);
    return { ...installed, kind: spec, identity: { harness: spec, policy: HARNESS_POLICIES[spec] } };
  }
  if (!spec || typeof spec !== 'object' || typeof spec.module !== 'string')
    throw new Error('native.harness_spec: use a built-in name or { "name", "module", "export"? }');
  const root = await realpath(directory);
  const file = await realpath(path.resolve(root, spec.module)).catch(() => {
    throw new Error(`native.harness_module: ${JSON.stringify(spec.module)} (not found beside application.mjs)`);
  });
  if (!file.startsWith(root + path.sep))
    throw new Error(`native.harness_module: ${JSON.stringify(spec.module)} (must be inside the starter directory)`);
  const exportName = spec.export ?? 'harness';
  const loaded = (await import(pathToFileURL(file).href))[exportName];
  if (!loaded || typeof loaded.prepare !== 'function' || typeof loaded.run !== 'function')
    throw new Error(`native.harness_module: ${JSON.stringify(spec.module)} (export ${exportName} = defineHarness({ name, prepare, run }))`);
  if (spec.name !== undefined && spec.name !== loaded.name)
    throw new Error(`native.harness_module: ${JSON.stringify(spec.module)} (declares name ${loaded.name}, native.json says ${spec.name})`);
  return {
    name: loaded.name,
    kind: 'custom',
    prepare: loaded.prepare,
    run: { module: file, exportName },
    moduleFile: path.relative(root, file),
    identity: { harness: loaded.name, custom: loaded.identity },
  };
}

const exists = (file) => readFile(file).then((bytes) => bytes, (error) => {
  if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
  throw error;
});

/** Host-level configuration each SDK still reads after HOME isolation. */
function ambientFiles(harness, home, inheritHome) {
  const files = {
    codex: ['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml'],
    claude: [
      '/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-mcp.json',
      '/Library/Application Support/ClaudeCode/managed-settings.json',
      '/Library/Application Support/ClaudeCode/managed-mcp.json',
    ],
    cursor: [],
    pi: [],
    replay: [],
  }[harness] ?? [];
  if (inheritHome) {
    const user = {
      codex: ['.codex/config.toml', '.codex/AGENTS.md'],
      claude: ['.claude/settings.json', '.claude/CLAUDE.md', '.claude.json'],
      cursor: ['.cursor/cli-config.json', '.cursor/mcp.json'],
      pi: ['.pi/agent/settings.json', '.pi/agent/AGENTS.md'],
    }[harness] ?? [];
    files.push(...user.map((name) => path.join(home, name)));
  }
  return files;
}

/** Digest of ambient configuration that isolation cannot remove. Part of the runtime identity. */
export async function ambientConfigDigest(harness, { home = os.homedir(), inheritHome = false } = {}) {
  const entries = [];
  for (const file of ambientFiles(harness, home, inheritHome)) {
    const bytes = await exists(file);
    entries.push([file, bytes ? createHash('sha256').update(bytes).digest('hex') : null]);
  }
  return 'sha256:' + createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/**
 * Build a per-job HOME containing only authentication. Global config.toml, MCP
 * servers, user AGENTS.md/CLAUDE.md and settings stay out of both arms. The home
 * lives in the job workspace, so it is quarantined and cleaned with it.
 */
export async function isolatedEnvironment({ harness, cwd, sourceEnv = process.env, passEnv = [], inheritHome = false }) {
  const home = path.join(cwd, '.acclimate', 'home');
  await mkdir(path.join(home, 'tmp'), { recursive: true, mode: 0o700 });
  const realHome = sourceEnv.HOME ?? os.homedir();
  const env = { PATH: sourceEnv.PATH ?? '/usr/bin:/bin', HOME: inheritHome ? realHome : home, TMPDIR: path.join(home, 'tmp') };
  const authFiles = [];
  const copyAuth = async (from, to) => {
    if (inheritHome || !(await exists(from))) return;
    await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
    await copyFile(from, to);
    authFiles.push(path.basename(from));
  };
  if (harness === 'codex') {
    const original = sourceEnv.CODEX_HOME ?? path.join(realHome, '.codex');
    env.CODEX_HOME = inheritHome ? original : path.join(home, '.codex');
    await copyAuth(path.join(original, 'auth.json'), path.join(env.CODEX_HOME, 'auth.json'));
  } else if (harness === 'claude') {
    const original = sourceEnv.CLAUDE_CONFIG_DIR ?? path.join(realHome, '.claude');
    env.CLAUDE_CONFIG_DIR = inheritHome ? original : path.join(home, '.claude');
    await copyAuth(path.join(original, '.credentials.json'), path.join(env.CLAUDE_CONFIG_DIR, '.credentials.json'));
  } else if (harness === 'pi') {
    await copyAuth(path.join(realHome, '.pi', 'agent', 'auth.json'), path.join(home, '.pi', 'agent', 'auth.json'));
  }
  const secrets = [];
  for (const name of [...(CREDENTIAL_ENV[harness] ?? []), ...passEnv]) {
    if (typeof sourceEnv[name] !== 'string') continue;
    env[name] = sourceEnv[name];
    if (CREDENTIAL_ENV[harness]?.includes(name)) secrets.push(sourceEnv[name]);
  }
  return { env, home, authFiles, secrets };
}

/** Fresh-session options only. The app still supplies authentication, model and tools. */
export async function freshSessionInputs(name, effectiveContext) {
  switch (name) {
    case 'codex':
      return {
        sessionOptions: { workingDirectory: effectiveContext.cwd, skipGitRepoCheck: true },
        memoryFiles: effectiveContext.memoryFiles,
      };
    case 'claude':
      return {
        sessionOptions: (await import('@acclimate/claude-plugin/native')).claudeSessionOptions(
          effectiveContext,
        ),
        memoryFiles: effectiveContext.memoryFiles,
      };
    case 'cursor':
      return {
        sessionOptions: (await import('@acclimate/cursor-plugin/native')).cursorLocalOptions(
          effectiveContext,
        ),
        memoryFiles: effectiveContext.memoryFiles,
      };
    case 'pi':
      return {
        resourceLoader: await (
          await import('@acclimate/pi-plugin/native')
        ).createPiResourceLoader(
          effectiveContext,
          effectiveContext.memoryFiles.map((file) => file.path),
        ),
        memoryFiles: effectiveContext.memoryFiles,
      };
    default:
      throw new Error('native.unsupported_harness');
  }
}

function withMemory(prompt, context) {
  const memory = context.memoryFiles.map((file) => file.absolutePath);
  return memory.length ? prompt + '\nApproved memory files:\n' + memory.join('\n') : prompt;
}
function requirePrompt(prompt, harness) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(`${harness}.task_prompt_required`);
}
function requireModel(policy, harness) {
  if (typeof policy?.model !== 'string' || !policy.model.trim()) throw new Error(`${harness}.explicit_model_required`);
}
function providerError(code, message) {
  return Object.assign(new Error(String(message ?? code)), { code });
}

/** Explicit application policy for the optional official Codex SDK 0.169.0. No session starts here. */
export function codexRuntimeInputs(effectiveContext, { env, model, config = {}, configOverrides = [] } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env) ||
      Object.values(env).some(value => typeof value !== 'string'))
    throw new Error('codex.explicit_environment_required');
  if (typeof model !== 'string' || !model.trim()) throw new Error('codex.explicit_model_required');
  if (!Array.isArray(configOverrides) || configOverrides.some(value => typeof value !== 'string'))
    throw new Error('codex.invalid_config_overrides');
  return {
    constructorOptions: { env: { ...env }, config: structuredClone(config), configOverrides: [...configOverrides] },
    threadOptions: {
      workingDirectory: effectiveContext.cwd, skipGitRepoCheck: true, model,
      ...HARNESS_POLICIES.codex,
    },
    memoryFiles: effectiveContext.memoryFiles,
  };
}

/** Run one real turn with the installed Codex SDK. Drain the stream before confirming stop. */
export async function runCodexTask({ context, signal, acknowledge, prompt, policy, progress }) {
  requirePrompt(prompt, 'codex');
  const inputs = codexRuntimeInputs(context, policy);
  const { Codex } = await import('@openai/codex-sdk');
  const thread = new Codex(inputs.constructorOptions).startThread(inputs.threadOptions);
  const turn = await thread.runStreamed(withMemory(prompt, context), { signal });
  let terminalEvent;
  let output = '';
  let usage = null;
  let failure;
  for await (const event of turn.events) {
    if (event.type === 'thread.started')
      await acknowledge({ kind: 'codex-thread', value: event.thread_id });
    if (event.type === 'item.completed' && event.item.type === 'agent_message') {
      output = event.item.text;
      progress?.(output);
    }
    if (event.type === 'turn.completed') {
      terminalEvent = event.type;
      usage = { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens };
    }
    if (event.type === 'turn.failed') {
      terminalEvent = event.type;
      failure = { code: 'codex.turn_failed', message: event.error?.message ?? 'Codex reported turn.failed' };
    }
    // Keep the provider's message; it is written to the job's private failure.json.
    if (event.type === 'error') throw providerError('codex.stream_error', event.message);
  }
  return {
    stopped: terminalEvent !== undefined,
    infrastructureFailure: terminalEvent === 'turn.failed',
    output,
    usage,
    ...(failure ? { error: failure } : {}),
  };
}

/** Run one fresh Claude Agent SDK query in the prepared project workspace. */
export async function runClaudeTask({ context, signal, acknowledge, prompt, policy, progress }) {
  requirePrompt(prompt, 'claude');
  requireModel(policy, 'claude');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { claudeSessionOptions } = await import('@acclimate/claude-plugin/native');
  const abortController = new AbortController();
  const onAbort = () => abortController.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const defaults = HARNESS_POLICIES.claude;
  let output = '';
  let result;
  try {
    const session = query({
      prompt: withMemory(prompt, context),
      options: {
        ...claudeSessionOptions(context),
        model: policy.model,
        abortController,
        env: { ...policy.env },
        permissionMode: defaults.permissionMode,
        allowedTools: [...defaults.allowedTools],
        disallowedTools: [...defaults.disallowedTools],
        sandbox: { ...defaults.sandbox },
        persistSession: false,
        ...(policy.maxTurns ? { maxTurns: policy.maxTurns } : {}),
      },
    });
    for await (const message of session) {
      if (message.type === 'system' && message.subtype === 'init')
        await acknowledge({ kind: 'claude-session', value: message.session_id });
      if (message.type === 'assistant') {
        const textBlocks = message.message.content.filter((block) => block.type === 'text');
        if (textBlocks.length) progress?.((output = textBlocks.map((block) => block.text).join('\n')));
      }
      if (message.type === 'result') result = message;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (!result) return { stopped: false, output };
  const usage = {
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    costUsd: result.total_cost_usd,
  };
  if (result.subtype === 'success') return { stopped: true, output: result.result ?? output, usage };
  if (result.subtype === 'error_max_turns' || result.subtype === 'error_max_budget_usd')
    return { stopped: true, executionStatus: 'task_failed', reason: result.subtype, output, usage, error: { code: `claude.${result.subtype}`, message: result.subtype } };
  return {
    stopped: true, infrastructureFailure: true, output, usage,
    error: { code: `claude.${result.subtype}`, message: (result.errors ?? []).join('\n') || result.subtype },
  };
}

/** Run one fresh local Cursor agent in the prepared workspace with the sandbox enabled. */
export async function runCursorTask({ context, signal, acknowledge, prompt, policy, progress }) {
  requirePrompt(prompt, 'cursor');
  requireModel(policy, 'cursor');
  if (!policy.env?.CURSOR_API_KEY) throw new Error('cursor.api_key_required');
  const { Agent } = await import('@cursor/sdk');
  const { cursorLocalOptions } = await import('@acclimate/cursor-plugin/native');
  const agent = await Agent.create({
    apiKey: policy.env.CURSOR_API_KEY,
    model: { id: policy.model },
    local: { ...cursorLocalOptions(context).local, sandboxOptions: { ...HARNESS_POLICIES.cursor.sandboxOptions } },
  });
  try {
    const run = await agent.send(withMemory(prompt, context));
    await acknowledge({ kind: 'cursor-run', value: run.id });
    const onAbort = () => void run.cancel().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const event of run.stream()) {
        if (event.type !== 'assistant') continue;
        const text = event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
        if (text) progress?.(text);
      }
      const result = await run.wait();
      const usage = result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens } : undefined;
      if (result.status === 'FINISHED') return { stopped: true, output: result.result ?? '', ...(usage ? { usage } : {}) };
      if (result.status === 'CANCELLED') return { stopped: true, cancelled: true, output: result.result ?? '' };
      return {
        stopped: true, infrastructureFailure: true, output: result.result ?? '', ...(usage ? { usage } : {}),
        error: { code: `cursor.${String(result.status).toLowerCase()}`, message: result.error?.message ?? String(result.status) },
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

/** Run one fresh in-process Pi session. `policy.model` is `provider/model-id`. */
export async function runPiTask({ context, signal, acknowledge, prompt, policy }) {
  requirePrompt(prompt, 'pi');
  requireModel(policy, 'pi');
  const pi = await import('@earendil-works/pi-coding-agent');
  const { createPiResourceLoader } = await import('@acclimate/pi-plugin/native');
  const slash = policy.model.indexOf('/');
  if (slash < 1) throw new Error('pi.model_format: use provider/model-id');
  const modelRuntime = await pi.ModelRuntime.create({
    ...(policy.authPath ? { authPath: policy.authPath } : {}), allowModelNetwork: false,
  });
  const model = modelRuntime.getModel(policy.model.slice(0, slash), policy.model.slice(slash + 1));
  if (!model) throw new Error(`pi.unknown_model: ${policy.model}`);
  const { session } = await pi.createAgentSession({
    cwd: context.cwd,
    agentDir: path.join(context.cwd, '.acclimate', 'pi-agent'),
    modelRuntime,
    model,
    tools: [...HARNESS_POLICIES.pi.tools],
    resourceLoader: await createPiResourceLoader(context, context.memoryFiles.map((file) => file.path)),
    sessionManager: pi.SessionManager.inMemory(context.cwd),
    settingsManager: pi.SettingsManager.inMemory(),
  });
  await acknowledge({ kind: 'pi-session', value: session.sessionId });
  const onAbort = () => void session.abort().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await session.prompt(prompt);
    const stats = session.getSessionStats();
    return {
      stopped: true,
      output: session.getLastAssistantText() ?? '',
      usage: { inputTokens: stats.tokens.input, outputTokens: stats.tokens.output, costUsd: stats.cost },
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    session.dispose();
  }
}

/**
 * Offline fake harness. It replays recorded edits from `policy.replay` (a JSON
 * file) instead of calling a model. The first entry whose `caseId` matches and
 * whose optional `when.instructionIncludes` appears in the staged instruction is
 * applied. `outcome` may be `completed`, `task_failed`, `timeout` (hang until the
 * watchdog stops it), `crash` (exit without a result) or `provider_error`.
 */
export async function runReplayTask({ context, signal, acknowledge, caseId, policy, progress }) {
  const recording = JSON.parse(await readFile(policy.replay, 'utf8'));
  if (recording?.schemaVersion !== 1 || !Array.isArray(recording.entries))
    throw new Error('replay.invalid_file: expected { "schemaVersion": 1, "entries": [...] }');
  await acknowledge({ kind: 'replay', value: `pid:${process.pid}` });
  const instruction = context.instructionPath ? await readFile(context.instructionPath, 'utf8') : '';
  const entry = recording.entries.find((candidate) =>
    candidate.caseId === caseId &&
    (candidate.when?.instructionIncludes === undefined || instruction.includes(candidate.when.instructionIncludes)));
  if (!entry) return { stopped: true, executionStatus: 'task_failed', reason: 'no_replay', output: null, error: { code: 'replay.no_entry', message: `no replay entry for ${caseId}` } };
  for (const [name, content] of Object.entries(entry.files ?? {})) {
    const target = path.resolve(context.cwd, name);
    if (!target.startsWith(context.cwd + path.sep)) throw new Error(`replay.unsafe_path: ${name}`);
    if (content === null) await rm(target, { force: true });
    else {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { mode: 0o600 });
    }
  }
  if (entry.output !== undefined) progress?.(entry.output);
  switch (entry.outcome ?? 'completed') {
    case 'timeout':
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await new Promise(() => {}); // Ignore cooperative cancellation; the watchdog must kill the group.
      break;
    case 'crash':
      process.exit(70);
      break;
    case 'provider_error':
      throw providerError('replay.provider_error', entry.error ?? 'recorded provider error');
    case 'task_failed':
      return { stopped: true, executionStatus: 'task_failed', output: entry.output ?? null };
    default:
      return { stopped: true, output: entry.output ?? null, usage: entry.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}
