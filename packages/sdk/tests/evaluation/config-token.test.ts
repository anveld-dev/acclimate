import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EVALUATOR_TOKEN_ENV, readEvaluatorConfig, readReaderConfig } from '../../src/evaluation/config.js';
import { EvaluationError } from '../../src/evaluation/errors.js';

async function fixture() {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-token-'));
  const base = {
    schemaVersion: 1,
    serviceUrl: 'https://acclimate.example/',
    workspaceId: 'workspace',
    evaluatorPrincipalId: 'machine:ci',
    journalRoot: path.join(directory, 'journal'),
  };
  const write = async (value: object) => {
    const filename = path.join(directory, 'evaluator.json');
    await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
    await chmod(filename, 0o600);
    return filename;
  };
  return { directory, base, write };
}

const code = (expected: string) => (error: unknown) =>
  error instanceof EvaluationError &&
  error.code === expected &&
  !JSON.stringify(error).includes('TOKEN_CANARY');

async function withEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[EVALUATOR_TOKEN_ENV];
  if (value === undefined) delete process.env[EVALUATOR_TOKEN_ENV];
  else process.env[EVALUATOR_TOKEN_ENV] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[EVALUATOR_TOKEN_ENV];
    else process.env[EVALUATOR_TOKEN_ENV] = previous;
  }
}

test('an evaluator token can come from a private token file', async () => {
  const { directory, base, write } = await fixture();
  try {
    const secrets = path.join(directory, 'secrets');
    await mkdir(secrets, { mode: 0o700 });
    const tokenFile = path.join(secrets, 'evaluator-token');
    await writeFile(tokenFile, 'acm_TOKEN_CANARY\n', { mode: 0o600 });
    const filename = await write({ ...base, evaluatorTokenFile: tokenFile });
    const config = await withEnv('acm_ENV_IGNORED', () => readEvaluatorConfig(filename));
    assert.equal(config.evaluatorToken, 'acm_TOKEN_CANARY');
    assert.equal(Object.hasOwn(config, 'evaluatorTokenFile'), false);

    // The token file gets the same permission checks as the config file.
    await chmod(tokenFile, 0o644);
    await assert.rejects(readEvaluatorConfig(filename), code('config.permissions'));
    await chmod(tokenFile, 0o600);
    await chmod(secrets, 0o755);
    await assert.rejects(readEvaluatorConfig(filename), code('config.permissions'));
    await chmod(secrets, 0o700);
    const alias = path.join(directory, 'alias-token');
    await symlink(tokenFile, alias);
    await assert.rejects(
      readEvaluatorConfig(await write({ ...base, evaluatorTokenFile: alias })),
      code('config.permissions'),
    );
    await assert.rejects(
      readEvaluatorConfig(await write({ ...base, evaluatorTokenFile: 'relative/token' })),
      code('config.schema'),
    );
    await writeFile(tokenFile, 'acm_TOKEN_CANARY\nsecond-line\n');
    await assert.rejects(
      readEvaluatorConfig(await write({ ...base, evaluatorTokenFile: tokenFile })),
      code('config.schema'),
    );
    await rm(tokenFile);
    await assert.rejects(readEvaluatorConfig(filename), code('config.missing'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an evaluator token can come from ACCLIMATE_EVALUATOR_TOKEN when the config names none', async () => {
  const { directory, base, write } = await fixture();
  try {
    const filename = await write(base);
    const config = await withEnv('acm_TOKEN_CANARY', () => readEvaluatorConfig(filename));
    assert.equal(config.evaluatorToken, 'acm_TOKEN_CANARY');
    await withEnv(undefined, () =>
      assert.rejects(readEvaluatorConfig(filename), code('config.schema')),
    );
    await withEnv(' padded ', () =>
      assert.rejects(readEvaluatorConfig(filename), code('config.schema')),
    );
    // An inline token keeps precedence over the environment.
    const inline = await write({ ...base, evaluatorToken: 'acm_INLINE' });
    assert.equal(
      (await withEnv('acm_TOKEN_CANARY', () => readEvaluatorConfig(inline))).evaluatorToken,
      'acm_INLINE',
    );
    // Naming two token sources is ambiguous.
    await assert.rejects(
      readEvaluatorConfig(
        await write({
          ...base,
          evaluatorToken: 'acm_INLINE',
          evaluatorTokenFile: '/private/token',
        }),
      ),
      code('config.schema'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

