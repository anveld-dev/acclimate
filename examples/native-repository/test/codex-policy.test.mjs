import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { codexRuntimeInputs, runCodexTask } from '../harnesses.mjs';

test('Codex application policy requires a declared environment and model before SDK construction', () => {
  const effective = { cwd: '/private/app/workspace', memoryFiles: [{ path: 'memory/selected.md' }] };
  assert.throws(() => codexRuntimeInputs(effective), /explicit_environment_required/);
  assert.throws(() => codexRuntimeInputs(effective, { env: {} }), /explicit_model_required/);
  assert.throws(() => codexRuntimeInputs(effective, { env: { HOME: undefined }, model: 'app-model' }), /explicit_environment_required/);
  const policy = { env: { PATH: '/usr/bin', CODEX_HOME: '/private/app/codex' }, model: 'app-model', config: { features: { app_choice: false } }, configOverrides: ['app_key=false'] };
  const inputs = codexRuntimeInputs(effective, policy);
  policy.env.PATH = '/changed';
  policy.config.features.app_choice = true;
  policy.configOverrides.push('another=true');
  assert.deepEqual(inputs.constructorOptions, { env: { PATH: '/usr/bin', CODEX_HOME: '/private/app/codex' }, config: { features: { app_choice: false } }, configOverrides: ['app_key=false'] });
  assert.equal(inputs.threadOptions.workingDirectory, effective.cwd);
  assert.equal(inputs.threadOptions.model, 'app-model');
  assert.equal(inputs.threadOptions.sandboxMode, 'workspace-write');
  assert.equal(inputs.threadOptions.approvalPolicy, 'never');
  assert.equal(inputs.threadOptions.networkAccessEnabled, false);
  assert.equal(inputs.threadOptions.webSearchMode, 'disabled');
  assert.equal(inputs.memoryFiles, effective.memoryFiles);
});

test('Codex stream adapter carries observed handles, token usage and terminal state through the job', async () => {
  const module = `export class Codex {
    startThread() {
      return { runStreamed: async prompt => ({ events: (async function* () {
        yield { type: 'thread.started', thread_id: 'example-thread' };
        if (prompt.startsWith('truncated')) return;
        if (prompt.startsWith('failed')) { yield { type: 'turn.failed' }; return; }
        yield { type: 'item.completed', item: { type: 'agent_message', text: prompt } };
        yield { type: 'turn.completed', usage: { input_tokens: 15, output_tokens: 3 } };
        if (prompt.startsWith('late-error')) throw new Error('stream disconnected');
      })() }) };
    }
  }`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@openai/codex-sdk')
        return { url: 'data:text/javascript,' + encodeURIComponent(module), shortCircuit: true };
      return next(specifier, context);
    },
  });
  try {
    const handles = [];
    const run = prompt => runCodexTask({
      prompt, context: { cwd: '/private/workspace', memoryFiles: [{ absolutePath: '/approved.md' }] },
      policy: { env: {}, model: 'installed-model' }, acknowledge: async handle => handles.push(handle),
    });
    const completed = await run('User task');
    assert.equal(completed.stopped, true);
    assert.deepEqual(handles, [{ kind: 'codex-thread', value: 'example-thread' }]);
    assert.match(completed.output, /User task\nApproved memory files:\n\/approved.md/);
    assert.deepEqual(completed.usage, { inputTokens: 15, outputTokens: 3 });
    assert.equal((await run('truncated')).stopped, false);
    assert.equal((await run('failed')).infrastructureFailure, true);
    await assert.rejects(run('late-error'), /stream disconnected/);
  } finally {
    hook.deregister();
  }
});
