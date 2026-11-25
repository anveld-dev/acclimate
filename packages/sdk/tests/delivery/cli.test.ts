import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { main, readPayloadSource } from '../../src/cli.js';
import { fakeService } from './fake-service.js';

const payload = {
  schemaVersion: 1 as const,
  files: [{ path: 'instructions.md', kind: 'instruction' as const, text: 'Answer briefly.\n' }],
};

async function setup() {
  const service = await fakeService();
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-cli-'));
  const saved = { ...process.env };
  Object.assign(process.env, {
    ACCLIMATE_URL: service.url,
    ACCLIMATE_WORKSPACE: service.workspace,
    ACCLIMATE_TOKEN: 'PRIVATE_CANARY',
    HOME: directory,
  });
  return {
    service,
    directory,
    /** Run one command and return its exit status, its JSON line and its stderr sentence. */
    async cli(...argv: string[]) {
      let stdout = '',
        stderr = '';
      const write = process.stdout.write,
        writeError = process.stderr.write;
      process.stdout.write = ((value: unknown) => ((stdout += String(value)), true)) as typeof write;
      process.stderr.write = ((value: unknown) => ((stderr += String(value)), true)) as typeof write;
      let status: number;
      try {
        status = await main(argv);
      } finally {
        process.stdout.write = write;
        process.stderr.write = writeError;
      }
      assert.ok(!stdout.includes('PRIVATE_CANARY') && !stderr.includes('PRIVATE_CANARY'));
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      return { status, json, stdout, stderr };
    },
    async cleanup() {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
      await service.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('help lists the four commands and a bare call is a usage error', async () => {
  const f = await setup();
  try {
    const help = await f.cli('--help');
    assert.equal(help.status, 0);
    for (const command of ['pull', 'publish', 'release', 'rollback']) assert.match(help.stdout, new RegExp(`^  ${command} `, 'm'));
    assert.equal((await f.cli()).status, 2);
    const one = await f.cli('publish', '--help');
    assert.equal(one.status, 0);
    assert.match(one.stdout, /^Usage: acclimate publish <payload.json or folder> --bundle <name>/);
    const unknown = await f.cli('push');
    assert.equal(unknown.status, 2);
    assert.equal(unknown.json.error.code, 'usage.unknown_command');
    const flag = await f.cli('pull', '--bundel', 'x');
    assert.equal(flag.status, 2);
    assert.equal(flag.json.error.code, 'usage.invalid_flag');
  } finally {
    await f.cleanup();
  }
});

test('pull reads the environment, finds the bundle by name or ID and never overwrites a file', async () => {
  const f = await setup();
  try {
    f.service.addBundle('Other');
    const bundle = f.service.addBundle('Support agent', payload);
    const out = path.join(f.directory, 'payload.json');
    const pulled = await f.cli('pull', '--bundle', 'Support agent', '--out', out);
    assert.equal(pulled.status, 0, pulled.stdout);
    assert.deepEqual(Object.keys(pulled.json), ['schemaVersion', 'bundleId', 'channel', 'versionId', 'digest', 'revision', 'files', 'out']);
    assert.equal(pulled.json.bundleId, bundle.id);
    assert.equal(pulled.json.revision, '1');
    assert.match(pulled.stderr, /^Saved stable \(version .+, 1 file\) to .+payload\.json\.\n$/);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), payload);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    const again = await f.cli('pull', '--bundle', bundle.id, '--out', out);
    assert.equal(again.status, 2);
    assert.deepEqual([again.json.error.code, again.json.error.field], ['usage.invalid_flag', '--out']);
    const missing = await f.cli('pull', '--bundle', 'Support agent');
    assert.deepEqual([missing.status, missing.json.error.code, missing.json.error.field], [2, 'usage.missing_flag', '--out']);
    const beta = await f.cli('pull', '--bundle', 'Support agent', '--channel', 'beta', '--out', out + '.beta');
    assert.deepEqual([beta.status, beta.json.error.code], [1, 'bundle.missing']);
    const nameless = await f.cli('pull', '--bundle', 'Nobody', '--out', out + '.none');
    assert.deepEqual([nameless.status, nameless.json.error.code], [1, 'bundle.missing']);
    delete process.env.ACCLIMATE_TOKEN;
    const unset = await f.cli('pull', '--bundle', 'Support agent', '--out', out + '.unset');
    assert.deepEqual([unset.status, unset.json.error.code], [1, 'config.missing']);
  } finally {
    await f.cleanup();
  }
});

test('pull still accepts a private config file, which names its own service and token', async () => {
  const f = await setup();
  try {
    const bundle = f.service.addBundle('Support agent', payload);
    const configuration = path.join(f.directory, 'configuration');
    await mkdir(configuration, { mode: 0o700 });
    const config = path.join(configuration, 'pull.json');
    await writeFile(config, JSON.stringify({
      schemaVersion: 1, serviceUrl: f.service.url, workspaceId: f.service.workspace,
      scope: 'evaluator', token: 'PRIVATE_CANARY', cacheDir: path.join(f.directory, 'cache'),
    }), { mode: 0o600 });
    process.env.ACCLIMATE_URL = 'http://127.0.0.1:9';
    const pulled = await f.cli('pull', '--config', config, '--bundle', bundle.id, '--out', path.join(f.directory, 'p.json'));
    assert.equal(pulled.status, 0, pulled.stdout);
    await chmod(config, 0o644);
    const open = await f.cli('pull', '--config', config, '--bundle', bundle.id, '--out', path.join(f.directory, 'q.json'));
    assert.deepEqual([open.status, open.json.error.code], [1, 'config.permissions']);
  } finally {
    await f.cleanup();
  }
});

test('publish uploads a file as a child version, releases it and does nothing for the same payload', async () => {
  const f = await setup();
  try {
    const bundle = f.service.addBundle('Support agent', payload);
    const [first] = f.service.releases.get(`${bundle.id}:stable`)!;
    const file = path.join(f.directory, 'payload.json');
    const edited = { schemaVersion: 1, files: [{ ...payload.files[0], text: 'Answer in one line.\n' }] };
    await writeFile(file, JSON.stringify(edited));
    const published = await f.cli('publish', file, '--bundle', 'Support agent', '--reason', 'Shorter answers');
    assert.equal(published.status, 0, published.stdout);
    assert.deepEqual(
      [published.json.bundleId, published.json.revision, published.json.changed, published.json.created],
      [bundle.id, '2', true, false],
    );
    assert.match(published.stderr, /^Released version .+ on stable \(revision 2\)\.\n$/);
    const version = f.service.versions.get(published.json.versionId)!.meta;
    assert.equal(version.parentVersionId, first.version.id);
    assert.equal(version.digest, published.json.digest);
    assert.equal(f.service.releases.get(`${bundle.id}:stable`)![0].unevaluatedReason, 'Shorter answers');
    const writes = f.service.traffic.filter((item) => item.method === 'POST');
    assert.equal(writes.length, 2);
    assert.notEqual(writes[0].key, writes[1].key);
    const same = await f.cli('publish', file, '--bundle', 'Support agent');
    assert.equal(same.status, 0);
    assert.deepEqual([same.json.changed, same.json.versionId, same.json.revision], [false, published.json.versionId, '2']);
    assert.match(same.stderr, /^No change/);
    assert.equal(f.service.traffic.filter((item) => item.method === 'POST').length, 2);
  } finally {
    await f.cleanup();
  }
});

test('publish reads a folder with the console import rule and needs --create for a new bundle', async () => {
  const f = await setup();
  try {
    const folder = path.join(f.directory, 'bundle');
    for (const [name, text] of [
      ['AGENTS.md', 'Be brief.\n'],
      ['skills/refunds/SKILL.md', '# Refunds\n'],
      ['memory/notes.md', 'Customers prefer email.\n'],
      ['.git/config', 'ignored'],
    ]) {
      await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
      await writeFile(path.join(folder, name), text);
    }
    assert.deepEqual(
      (await readPayloadSource(folder)).files.map(({ path, kind }) => [path, kind]),
      [['AGENTS.md', 'instruction'], ['memory/notes.md', 'memory'], ['skills/refunds/SKILL.md', 'skill']],
    );
    const unknown = await f.cli('publish', folder, '--bundle', 'New agent');
    assert.deepEqual([unknown.status, unknown.json.error.code, unknown.json.error.field], [1, 'bundle.missing', '--bundle']);
    assert.match(unknown.stderr, /--create/);
    assert.equal(f.service.bundles.length, 0);
    const created = await f.cli('publish', folder, '--bundle', 'New agent', '--create', '--channel', 'beta');
    assert.equal(created.status, 0, created.stdout);
    assert.deepEqual([created.json.created, created.json.channel, created.json.revision], [true, 'beta', '1']);
    assert.deepEqual(f.service.bundles.map((bundle) => bundle.name), ['New agent']);
    await writeFile(path.join(folder, 'bad.md'), new Uint8Array([0xff, 0xfe]));
    const bad = await f.cli('publish', folder, '--bundle', 'New agent');
    assert.deepEqual([bad.status, bad.json.error.code], [1, 'payload.invalid']);
  } finally {
    await f.cleanup();
  }
});

test('release points the channel at a version and rollback returns it to the previous one', async () => {
  const f = await setup();
  try {
    const bundle = f.service.addBundle('Support agent', payload);
    const [first] = f.service.releases.get(`${bundle.id}:stable`)!;
    const candidate = f.service.addVersion(bundle.id, { schemaVersion: 1, files: [{ ...payload.files[0], text: 'New.\n' }] }, first.version.id);
    const released = await f.cli('release', candidate.id, '--bundle', 'Support agent');
    assert.equal(released.status, 0, released.stdout);
    assert.deepEqual([released.json.versionId, released.json.revision, released.json.changed], [candidate.id, '2', true]);
    const again = await f.cli('release', candidate.id, '--bundle', 'Support agent');
    assert.deepEqual([again.json.changed, again.json.revision], [false, '2']);
    const back = await f.cli('rollback', '--bundle', 'Support agent', '--reason', 'Undo');
    assert.equal(back.status, 0, back.stdout);
    assert.deepEqual([back.json.versionId, back.json.revision], [first.version.id, '3']);
    assert.match(back.stderr, /^Rolled stable back to version/);
    const history = f.service.releases.get(`${bundle.id}:stable`)!;
    assert.equal(history[0].unevaluatedReason, 'Undo');
    const empty = f.service.addBundle('Empty');
    const none = await f.cli('rollback', '--bundle', empty.id);
    assert.deepEqual([none.status, none.json.error.code], [1, 'release.none']);
    const operand = await f.cli('release', '--bundle', 'Support agent');
    assert.deepEqual([operand.status, operand.json.error.code], [2, 'usage.invalid_argument']);
  } finally {
    await f.cleanup();
  }
});

test('the installed executable runs a command and exits with its status', async () => {
  const f = await setup();
  try {
    f.service.addBundle('Support agent', payload);
    const bin = fileURLToPath(new URL('../../src/cli-bin.ts', import.meta.url));
    const run = (...args: string[]) =>
      promisify(execFile)(process.execPath, ['--import', 'tsx', bin, ...args], { env: process.env }).then(
        (result) => ({ code: 0, ...result }),
        (error) => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }),
      );
    const help = await run('--help');
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: acclimate <command>/);
    const pulled = await run('pull', '--bundle', 'Support agent', '--out', path.join(f.directory, 'bin.json'));
    assert.equal(pulled.code, 0, pulled.stderr);
    assert.equal(JSON.parse(pulled.stdout).files, 1);
    const failed = await run('rollback', '--bundle', 'Nobody');
    assert.equal(failed.code, 1);
    assert.equal(JSON.parse(failed.stdout).error.code, 'bundle.missing');
    assert.match(failed.stderr, /^acclimate: No bundle is named "Nobody"/);
  } finally {
    await f.cleanup();
  }
});
