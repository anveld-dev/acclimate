import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AcclimateClient, ApiError, resolveAndCache } from '../packages/sdk/src/index.js';
import { compare, submitComparison } from '../packages/sdk/src/compare.js';
import { prepare as prepareCodex } from '../packages/codex-plugin/src/index.js';
import type {
  BundlePayload,
  ComparisonRequest,
  VersionMetadata,
} from '../packages/sdk/src/types.js';

const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
};
const databaseUrl = required('EVALUATION_TEST_DATABASE_URL');
if (!/^postgres(?:ql)?:\/\//.test(databaseUrl))
  throw new Error('EVALUATION_TEST_DATABASE_URL must point to the owned disposable e2e PostgreSQL database');
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
    projectId: project,
    rights: ['read', 'write', 'propose', 'promote'],
  },
  {
    token: noReadToken,
    principalId: `e2e-limited-${randomUUID()}`,
    projectId: project,
    rights: ['write', 'propose', 'promote'],
  },
]);
const modelToken = `fixture-${randomUUID()}`;
const temp = await mkdtemp(path.join(await realpath(os.tmpdir()), 'acclimate-service-e2e-'));
let service: ChildProcess | undefined, model: Server | undefined;
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
const listen = async (server: Server): Promise<number> => {
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return (server.address() as any).port;
};
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
  const modelPort = await listen(
    (model = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${modelToken}`) {
        res.writeHead(401).end();
        return;
      }
      try {
        const outer = JSON.parse(raw),
          prompt = JSON.parse(outer.messages[0].content);
        const payload: BundlePayload = structuredClone(prompt.parent);
        const allowed = new Set(prompt.request.allowedPaths);
        const file = payload.files.find((f) => allowed.has(f.path));
        if (!file) throw new Error('fixture expected an allowed path');
        const content = JSON.stringify({
          schemaVersion: 1,
          edits: [{path: file.path, oldText: file.text, newText: file.text + '\n\nProposal: ' + prompt.request.hypothesis}],
          rationale: 'Fixture model applied the requested bounded text edit.',
        });
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
      } catch {
        res.writeHead(400).end();
      }
    })),
  );
  const servicePort = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
  // Share the private production fixture contract; machine grants keep their exact rights.
  const productionEnv = JSON.parse(execFileSync(process.env.ACCLIMATE_TEST_PYTHON || 'python3',
    ['-m', 'scripts.testing.production'], {
      cwd: root,
      input: JSON.stringify({database_url: databaseUrl, bind: `127.0.0.1:${servicePort}`,
        project, tokens: {operator: token}, login_token: randomUUID() + randomUUID(),
        console_token: randomUUID() + randomUUID(), base_env: process.env}),
      encoding: 'utf8',
    })) as NodeJS.ProcessEnv;
  service = spawn(binary, [], {
    cwd: root,
    env: {
      ...productionEnv,
      ACCLIMATE_BIND: `127.0.0.1:${servicePort}`,
      DATABASE_URL: databaseUrl,
      ACCLIMATE_AUTH: auth,
      ACCLIMATE_MODEL_ENDPOINT: `http://127.0.0.1:${modelPort}/v1/chat/completions`,
      ACCLIMATE_MODEL_TOKEN: modelToken,
      ACCLIMATE_MODEL: 'gpt-6-luna',
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
  let ready = false;
  const startupDeadline = Date.now() + 15000;
  await withTimeout(
    (async () => {
      while (!ready && Date.now() < startupDeadline) {
        if (service?.exitCode !== null && service?.exitCode !== undefined)
          throw new Error(`service exited before startup (${service.exitCode}): ${childOutput}`);
        try {
          const r = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) });
          ready = r.ok;
        } catch {}
        if (!ready) await delay(100);
      }
      if (!ready) throw new Error('service startup deadline exceeded');
    })(),
    16000,
    'service startup',
  );
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
  const seeded = await client.promote(
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
    { projectId: project, bundleId: bundle.id, channel: 'stable' },
    { cacheDir },
  );
  assert.equal(verified.version.id, parent.id);
  const explicit = await resolveAndCache(
    client,
    { projectId: project, bundleId: bundle.id, versionId: parent.id },
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

  const proposal = await client.createProposal(
    project,
    bundle.id,
    {
      parentVersionId: parent.id,
      allowedPaths: ['AGENTS.md'],
      hypothesis: 'Clarify concise response behavior',
      evidence: ['fixture evidence'],
    },
    'proposal-create',
  );
  const finalProposal = await withTimeout(
    (async () => {
      for (let i = 0; i < 100; i++) {
        const p = await client.getProposal(project, bundle.id, proposal.id);
        if (p.status === 'succeeded' || p.status === 'failed') return p;
        await delay(100);
      }
      throw new Error('proposal did not finish');
    })(),
    12000,
    'proposal completion',
  );
  assert.equal(finalProposal.status, 'succeeded', `proposal failed: ${finalProposal.error}`);
  assert(finalProposal.candidate);
  const candidate = finalProposal.candidate as VersionMetadata;
  const complete = await compare({
    parent: { version: parent },
    candidate: { version: candidate },
    cases: [
      {
        caseId: 'case-a',
        snapshot: { text: 'sample' },
        settings: { tone: 'plain' },
        repetitions: 2,
      },
    ],
    datasetRevision: 'fixture-dataset-v1',
    runtime: { app: 'service-e2e' },
    graderRevision: 'fixture-grader-v1',
    execute: async ({ version, caseId, repetition, snapshot }) => ({
      output: { text: snapshot.text, version: version.version.id, caseId, repetition },
    }),
    grade: async ({ output, version }) => ({ reward: output.version === candidate.id ? 0.8 : 0.7 }),
  });
  assert.equal(complete.results.length, 2);
  const incomplete: ComparisonRequest = { ...complete, results: complete.results.slice(0, 1) };
  const incompleteRow = await submitComparison(
    client,
    project,
    bundle.id,
    incomplete,
    'comparison-incomplete',
  );
  assert.equal(incompleteRow.complete, false);
  await expectApiError(
    () =>
      submitComparison(
        client,
        project,
        bundle.id,
        { ...complete, candidateDigest: 'sha256:' + '0'.repeat(64) },
        'comparison-mismatched-digest',
      ),
    400,
    'invalid_content',
  );
  await expectApiError(
    () =>
      client.promote(
        project,
        bundle.id,
        'stable',
        {
          versionId: candidate.id,
          expectedRevision: seeded.revision,
          comparisonId: incompleteRow.id,
        },
        'promotion-incomplete',
      ),
    409,
    'parent_conflict',
  );
  const uploaded = await submitComparison(
    client,
    project,
    bundle.id,
    complete,
    'comparison-complete',
  );
  assert.equal(uploaded.complete, true);
  const promoted = await client.promote(
    project,
    bundle.id,
    'stable',
    { versionId: candidate.id, expectedRevision: seeded.revision, comparisonId: uploaded.id },
    'promotion-good',
  );
  await expectApiError(
    () =>
      client.promote(
        project,
        bundle.id,
        'stable',
        { versionId: parent.id, expectedRevision: seeded.revision, unevaluatedReason: 'stale CAS' },
        'promotion-stale',
      ),
    409,
    'revision_conflict',
  );
  const rollback = await client.promote(
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
    { projectId: project, bundleId: bundle.id, channel: 'stable' },
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
    `${base}/v1/projects/${project}/bundles/${bundle.id}/versions/${parent.id}`,
    noReadToken,
  );
  assert.equal(denied.status, 403);
  const unknown = await fetchError(
    `${base}/v1/projects/${project}/bundles/${bundle.id}/versions/${parent.id}`,
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
        { projectId: project, bundleId: bundle.id, versionId: parent.id },
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
      ACCLIMATE_MODEL_ENDPOINT: `http://127.0.0.1:${modelPort}/v1/chat/completions`,
      ACCLIMATE_MODEL_TOKEN: modelToken,
      ACCLIMATE_MODEL: 'gpt-6-luna',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.stdout?.on('data', (b) => {
    childOutput += b.toString();
  });
  service.stderr?.on('data', (b) => {
    childOutput += b.toString();
  });
  const restartDeadline = Date.now() + 15000;
  await withTimeout(
    (async () => {
      for (; Date.now() < restartDeadline; ) {
        if (service?.exitCode !== null && service?.exitCode !== undefined)
          throw new Error(`service failed restarting: ${childOutput}`);
        try {
          if ((await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) })).ok) return;
        } catch {}
        await delay(100);
      }
      throw new Error('service restart deadline exceeded');
    })(),
    16000,
    'service restart',
  );
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
    (await restarted.getProposal(project, bundle.id, proposal.id)).candidate?.id,
    candidate.id,
  );
  assert.equal((await restarted.getComparison(project, bundle.id, uploaded.id)).complete, true);
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
  if (model) await new Promise<void>((resolve) => model!.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
}
