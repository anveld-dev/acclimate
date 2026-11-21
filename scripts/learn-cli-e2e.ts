import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { AcclimateClient } from '@acclimate/sdk';
import { heldOutDigest } from '../packages/sdk/src/learning/index.js';

const { workspace, directory } = JSON.parse(readFileSync(0, 'utf8')) as { workspace: string; directory: string };
const base = 'http://' + process.env.ACCLIMATE_BIND;
const modelToken = randomUUID();
const cases = Array.from({ length: 12 }, (_, index) => ({
  caseId: 'case-' + index, input: 'input-' + index, expected: 'refund',
}));
const heldOut = cases.filter(({ caseId }) => createHash('sha256').update(caseId).digest()[0] < 128);
const evolve = cases.filter(item => !heldOut.includes(item));
assert(heldOut.length && evolve.length);
let modelError: unknown;
const calls: string[] = [];
const optimizer = createServer((request, response) => {
  void (async () => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const raw = Buffer.concat(parts).toString();
    assert.equal(request.headers.authorization, 'Bearer ' + modelToken);
    for (const item of heldOut) {
      assert(!raw.includes('"' + item.caseId + '"'));
      assert(!raw.includes('"' + item.input + '"'));
    }
    assert(!raw.includes('private trace'));
    const body = JSON.parse(raw);
    const [system, user] = body.messages.map((message: { content: string }) => message.content);
    const data = JSON.parse(user.split('\n')[1]) as { candidates?: { sample: number }[] };
    let result: object;
    if (system.startsWith('You improve')) {
      calls.push('propose');
      result = {
        schemaVersion: 2, rationale: 'Clarify the refund rule.', edits: [],
        files: [{ op: 'write', path: 'AGENTS.md', text: 'Verify the charge and refund it.' }],
        diagnosis: { problem: { new: 'Missing refund rule' }, predicted: evolve.map(item => item.caseId) },
      };
    } else if (system.startsWith('Each candidate is a proposed')) {
      calls.push('screen');
      result = { samples: data.candidates!.map(({ sample }) => ({
        sample, verdict: sample === 1 ? 'evaluate' : 'skip', reason: 'Scripted screen.',
      })) };
    } else {
      assert(system.startsWith('Each candidate was evaluated'));
      calls.push('select');
      result = { decision: 'adopt', sample: 1, reason: 'The refund rule passed.' };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
    }));
  })().catch(error => {
    modelError ??= error;
    response.writeHead(500).end();
  });
});
optimizer.listen(0, '127.0.0.1');
await once(optimizer, 'listening');
const address = optimizer.address();
assert(address && typeof address !== 'string');
const service = spawn(resolve('target/debug/acclimate-service'), [], {
  env: {
    ...process.env,
    ACCLIMATE_MODEL_ENDPOINT: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    ACCLIMATE_MODEL_TOKEN: modelToken,
    ACCLIMATE_MODEL: 'fixture/optimizer',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(service, 'exit');
let serviceLog = '';
for (const stream of [service.stdout, service.stderr]) {
  stream.on('data', chunk => { serviceLog = (serviceLog + chunk.toString()).slice(-8000); });
}

try {
  for (let attempt = 0; ; attempt++) {
    const ready = await fetch(base + '/ready', { signal: AbortSignal.timeout(500) }).catch(() => null);
    if (ready?.ok) break;
    assert(attempt < 100 && service.exitCode === null, 'Service did not become ready.');
    await delay(100);
  }

  async function adminPost<T>(route: string, token: string, body: object, session?: string): Promise<T> {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token, 'content-type': 'application/json',
        'idempotency-key': randomUUID(), ...(session ? { 'x-acclimate-session': session } : {}),
      },
      body: JSON.stringify(body),
    });
    assert(response.ok, `${route}: ${response.status}`);
    return response.json() as Promise<T>;
  }
  const { secret: session } = await adminPost<{ secret: string }>(
    '/v1/auth/sessions', process.env.ACCLIMATE_LOGIN_TOKEN!,
    { issuer: process.env.ACCLIMATE_OIDC_ISSUER, subject: 'operator' },
  );
  const consoleToken = process.env.ACCLIMATE_CONSOLE_TOKEN!;
  await adminPost('/v1/workspaces', consoleToken, { id: workspace, name: 'Learn CLI fixture' }, session);
  const { secret: token, token: { principalId } } = await adminPost<{ secret: string; token: { principalId: string } }>(
    `/v1/workspaces/${workspace}/machine-tokens`, consoleToken,
    { name: 'learn-cli', rights: ['evaluate', 'promote'] }, session,
  );
  const admin = new AcclimateClient({ baseUrl: base, token: consoleToken, sessionToken: session, scope: 'admin' });
  const { id: bundleId } = await admin.createBundle(workspace, { name: 'support-agent' }, randomUUID());
  const seed = await admin.createVersion(workspace, bundleId, {
    parentVersionId: null,
    payload: { schemaVersion: 1, files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Keep responses concise.' }] },
  }, randomUUID());
  await admin.createRelease(workspace, bundleId, 'stable', {
    versionId: seed.id, expectedRevision: '0', unevaluatedReason: 'Seed the learning channel.',
  }, randomUUID());

  await mkdir(join(directory, 'node_modules'));
  await symlink(resolve('node_modules/@acclimate'), join(directory, 'node_modules/@acclimate'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'cases.jsonl'), cases.map(item => JSON.stringify(item)).join('\n'));
  await writeFile(join(directory, 'acclimate.loop.ts'), `
import { defineLoop, exact } from '@acclimate/sdk/learning';

export default defineLoop({
  bundle: 'support-agent',
  channel: 'stable',
  cases: './cases.jsonl',
  execute({ instructions, input }) {
    const action: string = instructions.includes('refund') ? 'refund' : 'keep';
    return { output: { action }, trace: ${JSON.stringify(heldOut.map(entry => entry.input))}.includes(input as string) ? 'private trace' : 'evolve trace' };
  },
  grade: exact('action'),
});
`);
  const app = new AcclimateClient({ baseUrl: base, token, scope: principalId });
  const cli = (overrides: NodeJS.ProcessEnv = {}) => promisify(execFile)(process.execPath, [
    resolve('packages/sdk/dist/learning/learn-cli.js'), 'learn', '--once',
  ], {
    cwd: directory, timeout: 80_000,
    env: { ...process.env, ACCLIMATE_URL: base, ACCLIMATE_WORKSPACE: workspace, ACCLIMATE_TOKEN: token, ...overrides },
  });

  // One machine token with promote and evaluate discovers its principal, enrolls itself and serves.
  const identity = await app.getPrincipal(workspace);
  assert.deepEqual(
    { ...identity, rights: [...identity.rights].sort() },
    { principalId, kind: 'machine', rights: ['evaluate', 'promote', 'read'] },
  );
  const { stdout } = await cli();
  console.log('Enrollment path: one machine token');
  process.stdout.write(stdout);
  assert.ifError(modelError);
  assert.deepEqual(calls.slice(0, 7), ['propose', 'propose', 'propose', 'propose', 'propose', 'screen', 'select']);
  assert.match(stdout, /round 1 · incumbent 0\.00/);
  assert.match(stdout, /screened out/);
  assert.match(stdout, /evolve 1\.00/);
  assert.match(stdout, /adopted s1 .* held-out 1\.00/);
  assert(!stdout.includes('\x1b'));
  const loop = await admin.getLearningLoop(workspace, bundleId);
  assert.deepEqual(loop.heldOut, { cases: heldOut.length, digest: heldOutDigest(heldOut) });
  assert.equal(loop.appPrincipalId, principalId);
  assert.deepEqual(loop.setting, { domain: 'support-agent', benchmark: 'cases.jsonl', policyModel: 'model-free' });
  const live = await app.listLearningEvolveCases(workspace, bundleId, { limit: 100 });
  assert.deepEqual(live.items.map(({ caseId }) => caseId).sort(), evolve.map(({ caseId }) => caseId).sort());
  assert.equal(loop.rounds.find(item => item.number === 1)?.state, 'completed');
  console.log('learn CLI integration passed');
} catch (error) {
  if (modelError) console.error(modelError);
  if (serviceLog) console.error(serviceLog);
  throw error;
} finally {
  service.kill();
  await exited;
  optimizer.close();
  optimizer.closeAllConnections();
}
