import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applicationMain } from '../../src/evaluation/app-cli.js';
import { pullPayload } from '../../src/evaluation/pull.js';

const bundleId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const payload = {
  schemaVersion: 1,
  files: [{ path: 'instructions.md', kind: 'instruction', text: 'Answer briefly.\n' }],
};

async function fixture() {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-pull-'));
  const bytes = JSON.stringify(payload) + '\n';
  const version = {
    id: versionId,
    bundleId,
    parentVersionId: null,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    createdAt: '2026-11-19T12:00:00Z',
  };
  const traffic: string[] = [];
  const server = createServer((req, res) => {
    traffic.push(`${req.method} ${req.url}`);
    const route = new URL(req.url!, 'http://fixture').pathname;
    res.setHeader('content-type', 'application/json');
    if (route.endsWith(`/bundles/${bundleId}/channels/stable`))
      return res.end(JSON.stringify({ channel: 'stable', revision: '3', version }));
    if (route.endsWith(`/versions/${versionId}/payload`)) return res.end(bytes);
    if (route.endsWith(`/versions/${versionId}`)) return res.end(JSON.stringify(version));
    res.statusCode = 404;
    res.end(
      JSON.stringify({ error: { code: 'not_found', message: 'missing', requestId: 'fixture' } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const configuration = path.join(directory, 'configuration');
  await mkdir(configuration, { mode: 0o700 });
  const config = path.join(configuration, 'evaluator.json');
  await writeFile(
    config,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl: `http://127.0.0.1:${address.port}`,
      projectId: 'project',
      evaluatorPrincipalId: 'evaluator',
      evaluatorToken: 'PRIVATE_CANARY',
      journalRoot: path.join(directory, 'journals'),
    }),
    { mode: 0o600 },
  );
  return {
    directory,
    config,
    traffic,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('pull saves the published payload as a new private file for compare --payload', async () => {
  const f = await fixture();
  try {
    const out = path.join(f.directory, 'candidate.json');
    const result = await pullPayload({ configPath: f.config, bundleId, channel: 'stable', out });
    assert.equal(result.versionId, versionId);
    assert.equal(result.revision, '3');
    assert.equal(result.files, 1);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), payload);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    await assert.rejects(
      pullPayload({ configPath: f.config, bundleId, channel: 'stable', out }),
      /already exists/,
    );
  } finally {
    await f.cleanup();
  }
});

test('the CLI runs pull without an application module and explains usage', async () => {
  const f = await fixture();
  let output = '',
    errors = '';
  const write = process.stdout.write,
    writeError = process.stderr.write;
  process.stdout.write = ((value: unknown) => ((output += String(value)), true)) as typeof write;
  process.stderr.write = ((value: unknown) => ((errors += String(value)), true)) as typeof write;
  try {
    const out = path.join(f.directory, 'parent.json');
    const empty = path.join(f.directory, 'no-application');
    await mkdir(empty);
    const ok = await applicationMain(
      ['pull', '--config', f.config, '--bundle', bundleId, '--out', out],
      empty,
    );
    const missing = await applicationMain(
      ['pull', '--config', f.config, '--bundle', bundleId],
      empty,
    );
    const refused = await applicationMain(
      ['pull', '--config', f.config, '--bundle', bundleId, '--channel', 'beta', '--out', out + '2'],
      empty,
    );
    process.stdout.write = write;
    process.stderr.write = writeError;
    assert.equal(ok, 0);
    assert.equal(JSON.parse(output.split('\n')[0]).channel, 'stable');
    assert.equal(missing, 1);
    assert.match(errors, /Missing --out/);
    assert.equal(refused, 1);
    assert.match(errors, /refused the request \(404 not_found\)/);
    assert.ok(!errors.includes('PRIVATE_CANARY'));
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeError;
    await f.cleanup();
  }
});
