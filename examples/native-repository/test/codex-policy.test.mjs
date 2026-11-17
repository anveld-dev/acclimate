import assert from 'node:assert/strict';
import test from 'node:test';
import { codexRuntimeInputs } from '../harnesses.mjs';

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
