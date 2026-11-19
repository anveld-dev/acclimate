// A custom harness built from the public contract, used by application.test.mjs.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareNativeFiles } from '@acclimate/sdk/native-files';
import { defineHarness } from '../harnesses.mjs';

export const harness = defineHarness({
  name: 'my-agent',
  async prepare(bundle) {
    const staged = await prepareNativeFiles(bundle, {
      mapping: { instructionPath: 'AGENTS.md', skillRoot: '.agents/skills', memoryRoot: '.acclimate/memory' },
      prefix: 'my-agent-',
    });
    return { ...staged, versionId: bundle.version.id, digest: bundle.version.digest };
  },
  async run({ context, acknowledge }) {
    await acknowledge({ kind: 'my-agent', value: String(process.pid) });
    await writeFile(path.join(context.cwd, 'src/retry.js'), 'export function retryKey(requestId) {\n  return requestId;\n}\n');
    return { stopped: true, output: 'custom harness ran' };
  },
  identity: { agent: 'my-agent', version: '1' },
});
