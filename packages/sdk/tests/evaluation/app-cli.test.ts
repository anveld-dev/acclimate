import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadApplication, resolveApplicationFile } from '../../src/evaluation/app-cli.js';
import type { AppSetupError } from '../../src/evaluation/errors.js';
import { defineApplication } from '../../src/evaluation/index.js';

test('import failures name the exception and its code, and native setup codes keep fixed guidance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acclimate-native-errors-'));
  try {
    for (const [code, expected] of [
      ['ACCLIMATE_NATIVE_CONFIG_MISSING', /Create native\.json beside the native starter/],
      ['ACCLIMATE_NATIVE_TEST_NOT_PROTECTED', /every testFiles entry is in sourceFiles/],
      ['native.control_path', /Could not import the application module: Error \[native\.control_path\]: application detail/],
    ] as const) {
      const file = join(directory, code + '.mjs');
      await writeFile(file, `throw Object.assign(new Error('application detail'), {code: ${JSON.stringify(code)}});`);
      await assert.rejects(loadApplication(directory, file), (error: AppSetupError) => {
        assert.match(error.message, expected);
        assert.equal(error.code, 'application.import_failed');
        assert.equal((error.cause as { code?: string }).code, code);
        return true;
      });
    }
    const typo = join(directory, 'typo.mjs');
    await writeFile(typo, 'export const cases = [];\nundefinedHelper();\n');
    await assert.rejects(loadApplication(directory, typo), (error: AppSetupError) => {
      assert.match(error.message, /ReferenceError: undefinedHelper is not defined/);
      assert.ok(error.cause instanceof ReferenceError);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('adapter exports name the missing callback, empty cases and invalid case fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acclimate-adapter-errors-'));
  try {
    const cases = "[{caseId:'a', input:1, expected:1}]";
    const write = async (name: string, body: string) => {
      const file = join(directory, name + '.mjs');
      await writeFile(file, body);
      return file;
    };
    const expectSetup = async (file: string, code: string, field: string, message: RegExp) =>
      assert.rejects(loadApplication(directory, file), (error: AppSetupError) => {
        assert.equal(error.code, code);
        assert.equal(error.diagnostic.field, field);
        assert.match(error.message, message);
        return true;
      });
    await expectSetup(
      await write('no-grade', `export const cases=${cases}; export function execute(){return {output:1}}`),
      'application.invalid',
      'grade',
      /does not export grade/,
    );
    await expectSetup(
      await write('empty', 'export const cases=[]; export function execute(){} export function grade(){}'),
      'definition.invalid',
      'cases',
      /cases is empty/,
    );
    await expectSetup(
      await write('duplicate', "export const cases=[{caseId:'a',input:1,expected:1},{caseId:'a',input:2,expected:2}]; export function execute(){} export function grade(){}"),
      'definition.invalid',
      'cases[1].caseId',
      /Duplicate caseId "a"/,
    );
    await expectSetup(
      await write('date', "export const cases=[{caseId:'a',input:{when:new Date(0)},expected:1}]; export function execute(){} export function grade(){}"),
      'definition.invalid',
      'cases[0]["input"]["when"]',
      /toISOString/,
    );
    await expectSetup(
      await write('execution', `export const cases=${cases}; export const execution='modelfree'; export function execute(){} export function grade(){}`),
      'application.invalid',
      'execution',
      /"live" or "model-free"/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a default-exported defineApplication adapter loads, accepts sync callbacks and may be model-free', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acclimate-default-adapter-'));
  try {
    // Applications import defineApplication from @acclimate/sdk/evaluation. It returns its
    // argument, so this fixture exports the same plain object without a package install.
    const adapter = { execute: () => ({ output: 1 }), grade: () => ({ reward: 1 }) };
    assert.equal(defineApplication(adapter), adapter);
    await writeFile(
      join(directory, 'application.mjs'),
      [
        'export default ({',
        "  execution: 'model-free',",
        "  cases: [{ caseId: 'one', input: 'x', expected: 'x' }],",
        '  execute: (run) => ({ output: { echo: run.input, instructions: run.instructions } }),',
        '  grade: ({ output, expected }) => ({ reward: Number(output.echo === expected) }),',
        '});',
      ].join('\n'),
    );
    const loaded = await loadApplication(directory);
    assert.equal(loaded.app.descriptor.runtime.execution, 'model-free');
    assert.equal(loaded.coverage.execution, 'model-free');
    assert.deepEqual(loaded.warnings, []);
    // With both entries present, the evaluator picks application.mjs and says so.
    await writeFile(join(directory, 'application.mts'), 'export {};');
    const warnings: string[] = [];
    assert.match(await resolveApplicationFile(directory, undefined, warnings), /application\.mjs$/);
    assert.match(warnings.join('\n'), /both application\.mjs and application\.mts/);
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
    assert.notDeepEqual(updated, original.app.descriptor);
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
