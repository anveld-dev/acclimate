import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AcclimateClient, ApiError, resolveAndCache } from '../packages/sdk/src/index.js';
import { prepare as prepareCodex } from '../packages/codex-plugin/src/index.js';
import type { BundlePayload } from '../packages/sdk/src/types.js';
const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
};
const databaseUrl = required('EVALUATION_TEST_DATABASE_URL');
if (!/^postgres(?:ql)?:\/\//.test(databaseUrl))
  throw new Error(
    'EVALUATION_TEST_DATABASE_URL must point to the owned disposable e2e PostgreSQL database',
  );
const root = process.cwd(),
  binary = path.join(root, 'target/debug/acclimate-service');
const project = `e2e-${randomUUID()}`,
  token = `e2e-${randomUUID()}-${randomUUID()}`;
const principal = `e2e-principal-${randomUUID()}`,
  noReadToken = `no-read-${randomUUID()}`;
const auth = JSON.stringify([
  {
    token,
    principalId: principal,
    workspaceId: project,
    rights: ['read', 'write', 'promote'],
  },
  {
    token: noReadToken,
    principalId: `e2e-limited-${randomUUID()}`,
    workspaceId: project,
    rights: ['write', 'promote'],
  },
]);
const temp = await mkdtemp(path.join(await realpath(os.tmpdir()), 'acclimate-service-e2e-'));
let service: ChildProcess | undefined;
let childOutput = '';
const withTimeout = <T>(p: Promise<T>, ms: number, label: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
async function waitUntilReady(base: string, phase: string) {
  const deadline = Date.now() + 15000;
  let lastCheck = 'no response';
  while (Date.now() < deadline) {
    if (service?.exitCode != null || service?.signalCode != null) {
      throw new Error(`service exited before ${phase} (${service.exitCode ?? service.signalCode})`);
    }
    try {
      const response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) });
      const body = await response.text();
      if (response.ok) return;
      lastCheck = `HTTP ${response.status} ${body}`;
    } catch (error) {
      lastCheck = error instanceof Error && error.cause ? String(error.cause) : String(error);
    }
    await delay(100);
  }
  throw new Error(`service ${phase} deadline exceeded (${lastCheck})`);
}
async function expectApiError(fn: () => Promise<unknown>, status: number, code?: string) {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof ApiError);
    assert.equal(e.status, status);
    if (code) assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected HTTP ${status} ${code ?? ''}`);
}
async function fetchError(url: string, tokenValue: string, method = 'GET', body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${tokenValue}`,
      'Content-Type': 'application/json',
      ...(body ? { 'Idempotency-Key': randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
try {
  const servicePort = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
  // Share the private production fixture contract; machine grants keep their exact rights.
  const productionEnv = JSON.parse(
    execFileSync(
      process.env.ACCLIMATE_TEST_PYTHON || 'python3',
      ['-m', 'scripts.testing.production'],
      {
        cwd: root,
        input: JSON.stringify({
          database_url: databaseUrl,
          bind: `127.0.0.1:${servicePort}`,
          project,
          tokens: { operator: token },
          login_token: randomUUID() + randomUUID(),
          console_token: randomUUID() + randomUUID(),
          base_env: process.env,
        }),
        encoding: 'utf8',
      },
    ),
  ) as NodeJS.ProcessEnv;
  service = spawn(binary, [], {
    cwd: root,
    env: {
      ...productionEnv,
      ACCLIMATE_BIND: `127.0.0.1:${servicePort}`,
      DATABASE_URL: databaseUrl,
      ACCLIMATE_AUTH: auth,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout?.on('data', (b) => {
    childOutput += b.toString();
    if (childOutput.length > 12000) childOutput = childOutput.slice(-12000);
  });
  service.stderr?.on('data', (b) => {
    childOutput += b.toString();
    if (childOutput.length > 12000) childOutput = childOutput.slice(-12000);
  });
  service.once('error', (e) => {
    childOutput += String(e);
  });
  const base = `http://127.0.0.1:${servicePort}`;
  await waitUntilReady(base, 'startup');
  const client = new AcclimateClient({
    baseUrl: base,
    token,
    scope: `e2e:${project}`,
    timeoutMs: 3000,
    retries: 0,
  });
  const bundle = await client.createBundle(project, { name: 'service e2e' }, 'bundle-create');
  const parentPayload: BundlePayload = {
    schemaVersion: 1,
    files: [
      { path: 'AGENTS.md', kind: 'instruction', text: 'Keep responses accurate.' },
      {
        path: 'skills/quality/SKILL.md',
        kind: 'skill',
        text: '---\nname: quality\ndescription: Quality rules for this fixture.\n---\nUse clear examples.',
      },
      { path: 'context.md', kind: 'memory', text: 'Fixture context.' },
    ],
  };
  const firstReq = { parentVersionId: null, payload: parentPayload };
  const parent = await client.createVersion(project, bundle.id, firstReq, 'version-first');
  assert.deepEqual(
    await client.createVersion(project, bundle.id, firstReq, 'version-first'),
    parent,
    'idempotent replay returns same version',
  );
  await expectApiError(
    () =>
      client.createVersion(
        project,
        bundle.id,
        {
          ...firstReq,
          payload: {
            ...parentPayload,
            files: [...parentPayload.files, { path: 'x.md', kind: 'memory', text: 'different' }],
          },
        },
        'version-first',
      ),
    409,
    'idempotency_conflict',
  );
  const bytes = await client.getPayload(project, bundle.id, parent.id);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    parent.digest.slice('sha256:'.length),
  );
  assert(bytes.at(-1) === 10, 'stored canonical JSON payload ends with newline');
  const seeded = await client.createRelease(
    project,
    bundle.id,
    'stable',
    { versionId: parent.id, expectedRevision: '0', unevaluatedReason: 'Initial fixture seed' },
    'seed-channel',
  );
  const channel = await client.resolveChannel(project, bundle.id, 'stable');
  assert.equal(channel.resolution?.version.id, parent.id);
  assert(channel.etag);
  assert(
    (await client.resolveChannel(project, bundle.id, 'stable', { etag: channel.etag! }))
      .notModified,
  );
  const cacheDir = path.join(temp, 'verified-cache');
  const verified = await resolveAndCache(
    client,
    { workspaceId: project, bundleId: bundle.id, channel: 'stable' },
    { cacheDir },
  );
  assert.equal(verified.version.id, parent.id);
  const explicit = await resolveAndCache(
    client,
    { workspaceId: project, bundleId: bundle.id, versionId: parent.id },
    { cacheDir: path.join(temp, 'explicit-cache') },
  );
  assert.equal(explicit.version.digest, parent.digest);
  const prepared = await prepareCodex(verified);
  try {
    assert.equal(prepared.versionId, parent.id);
    assert(prepared.instructionPath);
    assert.equal(prepared.skillPaths.length, 1);
    assert.equal(prepared.memoryFiles.length, 1);
  } finally {
    await prepared.cleanup();
  }

  const candidate = await client.createVersion(
    project,
    bundle.id,
    {
      parentVersionId: parent.id,
      payload: {
        ...parentPayload,
        files: parentPayload.files.map((file) =>
          file.path === 'AGENTS.md' ? { ...file, text: file.text + '\nReview retries.' } : file,
        ),
      },
    },
    'candidate-upload',
  );
  const promoted = await client.createRelease(
    project,
    bundle.id,
    'stable',
    {
      versionId: candidate.id,
      expectedRevision: seeded.revision,
      unevaluatedReason: 'Reviewed candidate upload',
    },
    'promotion-good',
  );
  await expectApiError(
    () =>
      client.createRelease(
        project,
        bundle.id,
        'stable',
        { versionId: parent.id, expectedRevision: seeded.revision, unevaluatedReason: 'stale CAS' },
        'promotion-stale',
      ),
    409,
    'revision_conflict',
  );
  const rollback = await client.createRelease(
    project,
    bundle.id,
    'stable',
    {
      versionId: parent.id,
      expectedRevision: promoted.revision,
      unevaluatedReason: 'Fixture rollback',
    },
    'promotion-rollback',
  );
  assert.equal(rollback.previousVersionId, candidate.id);
  const active = await resolveAndCache(
    client,
    { workspaceId: project, bundleId: bundle.id, channel: 'stable' },
    { cacheDir: path.join(temp, 'active-cache') },
  );
  const pinned = await prepareCodex(active);
  try {
    assert.equal(pinned.versionId, parent.id);
    assert.equal(pinned.digest, parent.digest);
  } finally {
    await pinned.cleanup();
  }

  const denied = await fetchError(
    `${base}/v1/workspaces/${project}/bundles/${bundle.id}/versions/${parent.id}`,
    noReadToken,
  );
  assert.equal(denied.status, 403);
  const unknown = await fetchError(
    `${base}/v1/workspaces/${project}/bundles/${bundle.id}/versions/${parent.id}`,
    `unknown-${randomUUID()}`,
  );
  assert.equal(unknown.status, 401);
  const cacheDeniedClient = new AcclimateClient({
    baseUrl: base,
    token: noReadToken,
    scope: `e2e:${project}`,
    timeoutMs: 1000,
    retries: 0,
  });
  await assert.rejects(
    () =>
      resolveAndCache(
        cacheDeniedClient,
        { workspaceId: project, bundleId: bundle.id, versionId: parent.id },
        { cacheDir: path.join(temp, 'explicit-cache'), offline: { pinnedVersionId: parent.id } },
      ),
    (e) => e instanceof ApiError && e.status === 403,
  );

  service.kill('SIGTERM');
  await withTimeout(
    new Promise<void>((resolve) => service!.once('exit', () => resolve())),
    5000,
    'service shutdown',
  );
  service = spawn(binary, [], {
    cwd: root,
    env: {
      ...productionEnv,
      ACCLIMATE_BIND: `127.0.0.1:${servicePort}`,
      DATABASE_URL: databaseUrl,
      ACCLIMATE_AUTH: auth,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout?.on('data', (b) => {
    childOutput += b.toString();
  });
  service.stderr?.on('data', (b) => {
    childOutput += b.toString();
  });
  await waitUntilReady(base, 'restart');
  const restarted = new AcclimateClient({
    baseUrl: base,
    token,
    scope: `e2e:${project}`,
    timeoutMs: 3000,
    retries: 0,
  });
  assert.equal((await restarted.getVersion(project, bundle.id, parent.id)).digest, parent.digest);
  assert.equal(
    (await restarted.resolveChannel(project, bundle.id, 'stable')).resolution?.version.id,
    parent.id,
  );
  assert.equal(
    (await restarted.getVersion(project, bundle.id, candidate.id)).digest,
    candidate.digest,
  );
  console.log('service e2e passed');
} catch (error) {
  const e = error instanceof Error ? error : new Error(String(error));
  // Startup output is useful for diagnosis, but redact lines that may include serialized environment or authorization headers.
  const safe = childOutput
    .split('\n')
    .filter((line) => !/(token|authorization|ACCLIMATE_AUTH|DATABASE_URL)/i.test(line))
    .join('\n');
  e.message += safe ? `\nService output:\n${safe}` : '';
  throw e;
} finally {
  if (service && service.exitCode === null) {
    service.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => service!.once('exit', () => resolve())),
      delay(3000),
    ]);
  }
  await rm(temp, { recursive: true, force: true });
}
