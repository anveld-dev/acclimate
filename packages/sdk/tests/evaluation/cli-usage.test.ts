import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applicationMain } from '../../src/evaluation/app-cli.js';
import { parseEvaluatorArguments } from '../../src/evaluation/cli.js';
import { readEvaluatorConfig } from '../../src/evaluation/config.js';
import { EvaluationError } from '../../src/evaluation/errors.js';

/** Run the installed CLI in a directory without an application module. */
async function cli(args: string[], options: { tty?: boolean; env?: Record<string, string> } = {}) {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-usage-'));
  let out = '',
    err = '';
  const stdout = process.stdout.write,
    stderr = process.stderr.write,
    log = console.log;
  const descriptors = [process.stdout, process.stderr].map((stream) =>
    Object.getOwnPropertyDescriptor(stream, 'isTTY'),
  );
  const saved = Object.fromEntries(Object.keys(options.env ?? {}).map((key) => [key, process.env[key]]));
  for (const stream of [process.stdout, process.stderr])
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: options.tty === true });
  Object.assign(process.env, options.env);
  process.stdout.write = ((value: unknown) => ((out += String(value)), true)) as typeof stdout;
  process.stderr.write = ((value: unknown) => ((err += String(value)), true)) as typeof stderr;
  console.log = (...values: unknown[]) => void (out += values.join(' ') + '\n');
  try {
    const status = await applicationMain(args, directory);
    const last = err.trim().split('\n').at(-1) ?? '';
    return { status, out, err, error: last.startsWith('{') ? JSON.parse(last).error : undefined };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    console.log = log;
    for (const [index, stream] of [process.stdout, process.stderr].entries()) {
      if (descriptors[index]) Object.defineProperty(stream, 'isTTY', descriptors[index]!);
      else Reflect.deleteProperty(stream, 'isTTY');
    }
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(directory, { recursive: true, force: true });
  }
}

test('no arguments is a usage error, while --help succeeds', async () => {
  const empty = await cli([]);
  assert.equal(empty.status, 1);
  assert.equal(empty.error.code, 'usage.missing_command');
  assert.match(empty.err, /Commands: try, compare/);
  const help = await cli(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.out, /defineApplication/);
  assert.equal((await cli(['status', '--help'])).status, 0);
});

test('--version prints the SDK version without loading an application', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const result = await cli(['--version']);
  assert.equal(result.status, 0);
  assert.equal(result.out.trim(), pkg.version);
});

test('arguments are validated before the application module is loaded', async () => {
  const unknown = await cli(['frobnicate']);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.error.code, 'usage.unknown_command');
  assert.equal(unknown.error.field, '"frobnicate"');
  assert.match(unknown.error.hint, /Choose a command/);
  assert.doesNotMatch(unknown.err, /application\.mjs/);

  const flag = await cli(['describe', '--bogus']);
  assert.equal(flag.error.code, 'usage.unknown_flag');
  assert.equal(flag.error.field, '"--bogus"');
  assert.doesNotMatch(flag.err, /application\.mjs/);

  // status never needs application code, so a missing --config is reported as such.
  const status = await cli(['status', '--handoff', 'x.json']);
  assert.equal(status.error.code, 'usage.missing_flag');
  assert.equal(status.error.field, '--config');
  assert.doesNotMatch(status.err, /application\.mjs/);

  const manifest = await cli(['verify-export']);
  assert.equal(manifest.error.code, 'usage.missing_flag');
  assert.equal(manifest.error.field, '--manifest');

  // Only commands that run callbacks load the module.
  const describe = await cli(['describe']);
  assert.equal(describe.status, 1);
  assert.equal(describe.error.code, 'application.invalid');
  assert.match(describe.error.message, /Add application\.mjs/);
});

test('terminal errors are readable and JSON errors always carry field and hint', async () => {
  const human = await cli(['frobnicate'], { tty: true });
  assert.match(human.err, /^error\[usage\.unknown_command\]: Unknown command.*"frobnicate"/m);
  assert.match(human.err, /hint: Choose a command/);
  assert.match(human.err, /next: fix_command/);
  const json = await cli(['frobnicate', '--json'], { tty: true });
  assert.equal(json.error.code, 'usage.unknown_command');
  assert.equal(json.error.field, '"frobnicate"');
  assert.match(json.error.hint, /Choose a command/);
});

test('--verbose and ACCLIMATE_DEBUG add the stack trace', async () => {
  for (const options of [{ args: ['--verbose'] }, { env: { ACCLIMATE_DEBUG: '1' } }]) {
    const result = await cli(['describe', ...(options.args ?? [])], { env: options.env });
    const record = JSON.parse(result.err.trim().split('\n').at(-1)!);
    assert.ok(Array.isArray(record.stack) && /AppSetupError/.test(record.stack[0]));
  }
});

test('path flags resolve against the working directory', () => {
  const parsed = parseEvaluatorArguments(
    ['status', '--config', 'private/evaluator.json', '--handoff', '/abs/request.json'],
    '/work',
  );
  assert.equal(parsed.flags.config, '/work/private/evaluator.json');
  assert.equal(parsed.flags.handoff, '/abs/request.json');
  assert.throws(
    () => parseEvaluatorArguments(['status', '--config'], '/work'),
    (error: EvaluationError) => error.code === 'usage.missing_flag' && error.diagnostic.field === '--config',
  );
  assert.throws(
    () => parseEvaluatorArguments(['run', '--live', '--live'], '/work'),
    (error: EvaluationError) => error.code === 'usage.invalid_flag' && error.diagnostic.field === '--live',
  );
});

test('a missing config is reported as missing even when its directory is not private', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-open-dir-'));
  try {
    const open = path.join(directory, 'shared');
    await mkdir(open);
    await chmod(open, 0o755);
    await assert.rejects(
      readEvaluatorConfig(path.join(open, 'evaluator.json')),
      (error: EvaluationError) => error.code === 'config.missing' && error.diagnostic.field === 'configPath',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
