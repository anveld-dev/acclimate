import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { agentConnectionRecipes } from '../src/components/sdk-setup-recipes';

// Execute exactly the copied application code against a minimal installed API seam.
// No provider, service or repository implementation imports are needed.
async function runFixture(
  language: 'typescript' | 'python',
  behavior: 'success' | 'rejected' | 'uncertain' | 'collision',
) {
  const root = await mkdtemp(join(tmpdir(), 'acclimate-console-agent-'));
  const job = join(root, 'job');
  await mkdir(job, { mode: 0o700 });
  const resultPath = join(job, 'acclimate-agent-result.json');
  const instructionPath = join(job, 'AGENTS.md');
  const recipes = agentConnectionRecipes({
    projectId: 'project',
    bundleId: 'bundle',
    channel: 'stable',
  });
  try {
    if (behavior === 'collision') await writeFile(resultPath, 'original output', { mode: 0o600 });
    let command: string;
    let filename: string;
    const recipe = recipes[language];
    if (language === 'typescript') {
      const sdk = join(root, 'node_modules', '@acclimate', 'sdk');
      await mkdir(sdk, { recursive: true });
      await writeFile(
        join(sdk, 'package.json'),
        JSON.stringify({ type: 'module', exports: './index.mjs' }),
      );
      await writeFile(
        join(sdk, 'index.mjs'),
        `
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
export class AcclimateClient {
  async prepare({destination}) {
    const absolutePath = join(destination, 'AGENTS.md');
    await writeFile(absolutePath, 'Prepared instruction');
    return { version: { id: 'version-one', digest: 'digest-one' }, instructions: 'Prepared instruction',
      skillFiles: [], files: [{ kind: 'instruction', absolutePath }], cleanup: () => unlink(absolutePath) };
  }
}`,
      );
      await writeFile(
        join(root, 'application.mjs'),
        `
export async function runExistingAgent({instruction, approvedMemory, task}) {
  ${behavior === 'rejected' ? "throw new Error('Application did not settle');" : ''}
  return {stopped: ${behavior !== 'uncertain'}, result: {instructionProvided: Boolean(instruction), selectedMemory: approvedMemory.length, task}};
}`,
      );
      filename = join(root, 'agent-connection.mjs');
      command = process.execPath;
    } else {
      await writeFile(
        join(root, 'acclimate.py'),
        `
from pathlib import Path
class AcclimateClient:
    def __init__(self, *args): pass
    def prepare(self, *args, destination, **kwargs): return Prepared(destination)
class Prepared:
    def __init__(self, root):
        self.path = Path(root) / 'AGENTS.md'
        self.path.write_text('Prepared instruction')
        self.instructions = 'Prepared instruction'
        self.version = dict(id='version-one', digest='digest-one')
        self.skill_files = []
        self.files = [dict(kind='instruction', absolutePath=str(self.path))]
    def cleanup(self): self.path.unlink()
`,
      );
      await writeFile(
        join(root, 'application.py'),
        `
def run_existing_agent(*, instruction, skill_files, approved_memory, task):
    ${behavior === 'rejected' ? "raise RuntimeError('Application did not settle')" : ''}
    return dict(stopped=${behavior !== 'uncertain' ? 'True' : 'False'}, result=dict(instructionProvided=bool(instruction), selectedMemory=len(approved_memory), task=task))
`,
      );
      filename = join(root, 'agent_connection.py');
      command = 'python3';
    }
    await writeFile(filename, recipe);
    const child = spawnSync(command, [filename], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        ACCLIMATE_URL: 'https://api.example.test',
        ACCLIMATE_TOKEN: 'test-only',
        ACCLIMATE_SCOPE: 'app',
        ACCLIMATE_CACHE: join(root, 'cache'),
        ACCLIMATE_JOB_DIR: job,
        AGENT_TASK: 'Check the latest receipt',
      },
    });
    assert.ifError(child.error);
    if (behavior === 'success') {
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(await readFile(resultPath, 'utf8'));
      assert.equal(result.versionId, 'version-one');
      assert.equal(result.digest, 'digest-one');
      assert.equal(result.result.instructionProvided, true);
      assert.equal(result.result.selectedMemory, 0);
      assert.equal(result.result.task, 'Check the latest receipt');
      assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
      assert.doesNotMatch(child.stdout, /instructionProvided|Prepared instruction/);
      await assert.rejects(access(instructionPath), { code: 'ENOENT' });
    } else {
      assert.notEqual(child.status, 0);
      await access(instructionPath);
      if (behavior === 'collision')
        assert.equal(await readFile(resultPath, 'utf8'), 'original output');
      else await assert.rejects(access(resultPath), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const language of ['typescript', 'python'] as const) {
  test(`${language} copied agent recipe retains a private bound result before input cleanup`, () =>
    runFixture(language, 'success'));
  test(`${language} copied agent recipe preserves inputs when termination or retention is unresolved`, async () => {
    for (const behavior of ['rejected', 'uncertain', 'collision'] as const)
      await runFixture(language, behavior);
  });
}
