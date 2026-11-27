import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { HARNESS_POLICIES, runClaudeTask, runCursorTask, runPiTask } from '../harnesses.mjs';

// Fake provider SDKs: the adapters' option mapping and result handling are checked offline.
const modules = {
  '@anthropic-ai/claude-agent-sdk': `export function query({ prompt, options }) {
    globalThis.calls.claude.push({ prompt, options });
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'claude-session-1' };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } };
      if (prompt.startsWith('fail')) {
        yield { type: 'result', subtype: 'error_during_execution', errors: ['model overloaded'], usage: { input_tokens: 1, output_tokens: 0 }, total_cost_usd: 0 };
        return;
      }
      if (prompt.startsWith('turns')) {
        yield { type: 'result', subtype: 'error_max_turns', errors: [], usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 };
        return;
      }
      if (prompt.startsWith('cut')) return;
      yield { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.01 };
    })();
  }`,
  '@cursor/sdk': `export const Agent = { async create(options) {
    globalThis.calls.cursor.push(options);
    return {
      async send(prompt) {
        return {
          id: 'cursor-run-1',
          async *stream() { yield { type: 'assistant', message: { content: [{ type: 'text', text: 'editing' }] } }; },
          async wait() {
            return prompt.startsWith('fail')
              ? { status: 'ERROR', error: { message: 'rate limited' } }
              : { status: 'FINISHED', result: 'ok', usage: { inputTokens: 5, outputTokens: 1 } };
          },
          async cancel() {},
        };
      },
      async [Symbol.asyncDispose]() { globalThis.calls.cursorDisposed++; },
    };
  } };`,
  '@earendil-works/pi-coding-agent': `export const ModelRuntime = { async create(options) { globalThis.calls.piRuntime.push(options); return { getModel: (provider, id) => (provider === 'anthropic' ? { provider, id } : undefined) }; } };
  export const SessionManager = { inMemory: cwd => ({ memory: cwd }) };
  export const SettingsManager = { inMemory: () => ({ settings: 'memory' }) };
  export async function createAgentSession(options) {
    globalThis.calls.pi.push(options);
    return { session: {
      sessionId: 'pi-session-1', async prompt() {}, async abort() {}, dispose() { globalThis.calls.piDisposed++; },
      getSessionStats: () => ({ tokens: { input: 7, output: 3 }, cost: 0.02 }), getLastAssistantText: () => 'pi done',
    } };
  }`,
  '@anveld/acclimate-pi-plugin/native': `export async function createPiResourceLoader(context, memory) { return { loader: true, memory }; }`,
};

globalThis.calls = { claude: [], cursor: [], cursorDisposed: 0, pi: [], piRuntime: [], piDisposed: 0 };
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (modules[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true };
    return next(specifier, context);
  },
});
test.after(() => hook.deregister());

const context = {
  cwd: '/private/workspace', instructionPath: '/private/workspace/CLAUDE.md', skillPaths: [],
  memoryFiles: [{ path: 'memory/a.md', absolutePath: '/private/workspace/.acclimate/memory/memory/a.md', text: 'A' }],
  settingSources: ['project'],
};
const handles = [];
const acknowledge = async (handle) => handles.push(handle);

test('Claude adapter applies explicit sandbox, tool and permission defaults', async () => {
  const result = await runClaudeTask({
    context, acknowledge, prompt: 'Fix it', signal: new AbortController().signal,
    policy: { model: 'claude-model', env: { HOME: '/private/home' } },
  });
  assert.deepEqual(result, { stopped: true, output: 'done', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 } });
  const [{ prompt, options }] = globalThis.calls.claude;
  assert.match(prompt, /Fix it\nApproved memory files:\n\/private\/workspace\/.acclimate\/memory\/memory\/a.md/);
  assert.equal(options.cwd, context.cwd);
  assert.deepEqual(options.settingSources, ['project']);
  assert.equal('skills' in options, false);
  assert.equal(options.model, 'claude-model');
  assert.equal(options.permissionMode, 'dontAsk');
  assert.deepEqual(options.allowedTools, HARNESS_POLICIES.claude.allowedTools);
  assert.deepEqual(options.disallowedTools, ['WebFetch', 'WebSearch']);
  assert.equal(options.sandbox.enabled, true);
  assert.equal(options.sandbox.allowUnsandboxedCommands, false);
  assert.equal(options.persistSession, false);
  assert.deepEqual(options.env, { HOME: '/private/home' });
  assert.ok(options.abortController instanceof AbortController);
  assert.deepEqual(handles.at(-1), { kind: 'claude-session', value: 'claude-session-1' });
  const failed = await runClaudeTask({ context, acknowledge, prompt: 'fail', policy: { model: 'm', env: {} } });
  assert.equal(failed.infrastructureFailure, true);
  assert.deepEqual(failed.error, { code: 'claude.error_during_execution', message: 'model overloaded' });
  const turns = await runClaudeTask({ context, acknowledge, prompt: 'turns', policy: { model: 'm', env: {} } });
  assert.equal(turns.executionStatus, 'task_failed');
  assert.equal((await runClaudeTask({ context, acknowledge, prompt: 'cut', policy: { model: 'm', env: {} } })).stopped, false);
  await assert.rejects(runClaudeTask({ context, acknowledge, prompt: 'x', policy: { env: {} } }), /claude.explicit_model_required/);
});

test('Cursor adapter enables the local sandbox and disposes the agent', async () => {
  await assert.rejects(runCursorTask({ context, acknowledge, prompt: 'x', policy: { model: 'm', env: {} } }), /cursor.api_key_required/);
  const result = await runCursorTask({
    context, acknowledge, prompt: 'Fix it', policy: { model: 'any-cursor-model', env: { CURSOR_API_KEY: 'key' } },
  });
  assert.deepEqual(result, { stopped: true, output: 'ok', usage: { inputTokens: 5, outputTokens: 1 } });
  const [options] = globalThis.calls.cursor;
  assert.deepEqual(options.model, { id: 'any-cursor-model' });
  assert.deepEqual(options.local, { cwd: context.cwd, settingSources: ['project'], sandboxOptions: { enabled: true } });
  assert.deepEqual(handles.at(-1), { kind: 'cursor-run', value: 'cursor-run-1' });
  const failed = await runCursorTask({ context, acknowledge, prompt: 'fail', policy: { model: 'm', env: { CURSOR_API_KEY: 'key' } } });
  assert.deepEqual(failed.error, { code: 'cursor.error', message: 'rate limited' });
  assert.equal(globalThis.calls.cursorDisposed, 2);
});

test('Pi adapter restricts tools, loads the prepared resources and reports usage', async () => {
  const result = await runPiTask({
    context, acknowledge, prompt: 'Fix it', policy: { model: 'anthropic/model-x', env: {}, authPath: '/private/home/.pi/agent/auth.json' },
  });
  assert.deepEqual(result, { stopped: true, output: 'pi done', usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.02 } });
  const [options] = globalThis.calls.pi;
  assert.deepEqual(options.tools, ['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls']);
  assert.equal(options.cwd, context.cwd);
  assert.equal(options.agentDir, '/private/workspace/.acclimate/pi-agent');
  assert.deepEqual(options.model, { provider: 'anthropic', id: 'model-x' });
  assert.deepEqual(options.resourceLoader, { loader: true, memory: ['memory/a.md'] });
  assert.deepEqual(globalThis.calls.piRuntime[0], { authPath: '/private/home/.pi/agent/auth.json', allowModelNetwork: false });
  assert.equal(globalThis.calls.piDisposed, 1);
  await assert.rejects(runPiTask({ context, acknowledge, prompt: 'x', policy: { model: 'model-x', env: {} } }), /pi.model_format/);
  await assert.rejects(runPiTask({ context, acknowledge, prompt: 'x', policy: { model: 'other/model', env: {} } }), /pi.unknown_model/);
});
