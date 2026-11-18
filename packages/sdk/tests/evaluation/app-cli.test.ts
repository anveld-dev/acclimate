import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadApplication } from '../../src/evaluation/app-cli.js';
import { assertDescriptor } from '../../src/evaluation/runner.js';

test('native setup diagnostics use fixed messages and other import exceptions remain private', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acclimate-native-errors-'));
  try {
    for (const [code, expected] of [
      ['ACCLIMATE_NATIVE_CONFIG_MISSING', /Create native\.json beside the native starter/],
      ['ACCLIMATE_NATIVE_TEST_NOT_PROTECTED', /every testFiles entry is in sourceFiles/],
      ['UNRECOGNIZED', /Could not import the application module/],
    ] as const) {
      const file = join(directory, code + '.mjs');
      await writeFile(file, `throw Object.assign(new Error('sensitive application detail'), {code: ${JSON.stringify(code)}});`);
      await assert.rejects(loadApplication(directory, file), (error: Error) => {
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /sensitive application detail/);
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('actual local grader bytes bind the descriptor and a resident process cannot relabel cached code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acclimate-app-'));
  try {
    await writeFile(
      join(directory, 'application.mjs'),
      [
        "export const cases = [{ caseId: 'tool', input: 'task', expected: 'private answer' }];",
        "export { grade } from './delegate.mjs';",
        'export async function execute({ input }) { return { output: input }; }',
      ].join('\n'),
    );
    await writeFile(join(directory, 'delegate.mjs'), "export { grade } from './grader.mjs';");
    const grader = join(directory, 'grader.mjs');
    await writeFile(grader, 'export async function grade() { return {reward: 1}; }');
    const original = await loadApplication(directory);
    assert.deepEqual(original.coverage.importedFiles, ['delegate.mjs', 'grader.mjs']);
    assert.deepEqual((await loadApplication(directory)).app.descriptor, original.app.descriptor);
    await writeFile(grader, 'export async function grade() { return {reward: 0.25}; }');
    await assert.rejects(loadApplication(directory), /restart the evaluator process/i);
    const loader = new URL('../../src/evaluation/app-cli.ts', import.meta.url);
    const script = `import {loadApplication} from ${JSON.stringify(loader.href)}; console.log(JSON.stringify((await loadApplication(process.argv[1])).app.descriptor));`;
    const updated = JSON.parse(
      execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, directory],
        { encoding: 'utf8' },
      ),
    );
    assert.equal(updated.datasetRevision, original.app.descriptor.datasetRevision);
    assert.notEqual(updated.graderRevision, original.app.descriptor.graderRevision);
    assert.throws(() => assertDescriptor(updated, original.app.descriptor), /descriptor.mismatch/);
    assert.ok(!JSON.stringify(updated).includes('private answer'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit entries resolve NodeNext imports and revision files relative to the adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acclimate-typed-app-'));
  try {
    const source = join(directory, 'src');
    await mkdir(source);
    await writeFile(
      join(source, 'evaluator.mts'),
      [
        "export const cases = [{caseId:'task', input:null, expected:1}];",
        "export {grade} from './judge.mjs';",
        "export const revisionFiles=['runtime.lock'];",
        'export async function execute() {return {output:1}}',
      ].join('\n'),
    );
    await writeFile(
      join(source, 'judge.mts'),
      'export async function grade({output}:{output:number}) {return {reward:output}}',
    );
    const lock = join(source, 'runtime.lock');
    await writeFile(lock, 'model-1');
    const { coverage } = await loadApplication(directory, 'src/evaluator.mts');
    assert.equal(coverage.adapter, 'src/evaluator.mts');
    assert.deepEqual(coverage.importedFiles, ['judge.mts']);
    assert.deepEqual(coverage.revisionFiles, ['runtime.lock']);
    await writeFile(lock, 'model-2');
    await assert.rejects(
      loadApplication(directory, 'src/evaluator.mts'),
      /restart the evaluator process/i,
    );
    await writeFile(join(source, 'broken.mts'), "export { grade } from './missing.mjs';");
    await assert.rejects(
      loadApplication(directory, 'src/broken.mts'),
      /Cannot resolve import .\/missing.mjs.*--app PATH/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
