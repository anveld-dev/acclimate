import assert from 'node:assert/strict';
import test from 'node:test';
import { freshSessionInputs } from '../harnesses.mjs';
import { fixture } from './support.mjs';

for (const harness of ['codex', 'claude', 'pi', 'cursor']) {
  test(`${harness} native option/loader helper consumes only the effective context`, async () => {
    await fixture(async ({ run }) => {
      await run({
        harness,
        runHarness: async ({ context }) => {
          const inputs = await freshSessionInputs(harness, context);
          assert.equal(inputs.memoryFiles.length, 1);
          assert.equal(inputs.memoryFiles[0].path, 'memory/yes.md');
          if (harness === 'codex') {
            assert.equal(inputs.sessionOptions.workingDirectory, context.cwd);
            assert.equal(inputs.sessionOptions.skipGitRepoCheck, true);
          } else if (harness === 'claude') {
            assert.equal(inputs.sessionOptions.cwd, context.cwd);
            assert.deepEqual(inputs.sessionOptions.settingSources, ['project']);
            assert.deepEqual(inputs.sessionOptions.skills, []);
          } else if (harness === 'cursor') {
            assert.equal(inputs.sessionOptions.local.cwd, context.cwd);
            assert.deepEqual(inputs.sessionOptions.local.settingSources, ['project']);
          } else {
            assert.equal(typeof inputs.resourceLoader.reload, 'function');
            assert.equal(typeof inputs.resourceLoader.getSkills, 'function');
            assert.deepEqual(inputs.resourceLoader.getAppendSystemPrompt(), ['YES']);
            assert.equal(
              inputs.resourceLoader.getAgentsFiles().agentsFiles[0].path,
              context.instructionPath,
            );
          }
          return { stopped: true, output: { fixture: true } };
        },
      });
    });
  });
}
