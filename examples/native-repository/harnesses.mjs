/** Application-owned allowlist: no handoff/configuration value resolves executable code. */
export async function installedHarness(name) {
  switch (name) {
    case 'codex':
      return { name, prepare: (await import('@acclimate/codex-plugin')).prepare };
    case 'claude':
      return { name, prepare: (await import('@acclimate/claude-plugin')).prepare };
    case 'pi':
      return { name, prepare: (await import('@acclimate/pi-plugin')).prepare };
    case 'cursor':
      return { name, prepare: (await import('@acclimate/cursor-plugin')).prepare };
    default:
      throw new Error('native.unsupported_harness');
  }
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
      sandboxMode: 'workspace-write', approvalPolicy: 'never',
      networkAccessEnabled: false, webSearchMode: 'disabled',
    },
    memoryFiles: effectiveContext.memoryFiles,
  };
}

/** Run one real turn with the installed Codex SDK. Drain the stream before confirming stop. */
export async function runCodexTask({ context, signal, acknowledge, prompt, policy }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('codex.task_prompt_required');
  const inputs = codexRuntimeInputs(context, policy);
  const { Codex } = await import('@openai/codex-sdk');
  const thread = new Codex(inputs.constructorOptions).startThread(inputs.threadOptions);
  const memory = inputs.memoryFiles.map(file => file.absolutePath);
  const instructions = memory.length ? prompt + '\nApproved memory files:\n' + memory.join('\n') : prompt;
  const turn = await thread.runStreamed(instructions, { signal });
  let terminalEvent;
  let output = '';
  let usage = null;
  for await (const event of turn.events) {
    if (event.type === 'thread.started')
      await acknowledge({ kind: 'codex-thread', value: event.thread_id });
    if (event.type === 'item.completed' && event.item.type === 'agent_message') output = event.item.text;
    if (event.type === 'turn.completed') {
      terminalEvent = event.type;
      usage = { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens };
    }
    if (event.type === 'turn.failed') terminalEvent = event.type;
    if (event.type === 'error') throw new Error('codex.stream_error');
  }
  return { stopped: terminalEvent !== undefined, infrastructureFailure: terminalEvent === 'turn.failed', output, usage };
}
