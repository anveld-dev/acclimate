import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { defineEvaluation } from '../../src/evaluation/index.js';
import {
  serveConnectedLearning,
  type ConnectedLearningDriverOptions,
} from '../../src/learning/connected.js';

async function fixture(t: TestContext, kind: 'recheck' | 'field' | 'incident') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'connected-replays-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      serviceUrl: 'http://localhost:8090',
      projectId: 'test',
      evaluatorPrincipalId: 'evaluator',
      evaluatorToken: 'test',
      journalRoot: join(root, 'journal'),
    }),
    { mode: 0o600 },
  );
  const bundleId = randomUUID(),
    versionId = randomUUID(),
    outcomeId = randomUUID();
  const payload = JSON.stringify({
    schemaVersion: 1,
    files: [{ path: 'guide.md', kind: 'instruction', text: 'test' }],
  });
  const digest = 'sha256:' + createHash('sha256').update(payload).digest('hex');
  const assignment =
    kind === 'recheck'
      ? { correctionId: randomUUID(), versionId, digest, revision: '2', outcomeId }
      : {
          versionId,
          digest,
          baselineRevision: '2',
          outcomeId,
          ...(kind === 'incident' ? { roundId: randomUUID() } : {}),
        };
  const path = {
    recheck: '/rechecks',
    field: '/field-requalifications',
    incident: '/incident-replays',
  }[kind];
  const record = {
    active: true,
    requested: true,
    reads: 0,
    callbacks: 0,
    posts: [] as string[],
    keys: [] as string[],
    failPost: false,
    beforeWork: () => {},
    run: async (_signal: AbortSignal) => {},
  };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/work')) {
      record.reads++;
      record.beforeWork();
      return Response.json({
        active: record.active,
        installationId: 'test',
        bundleId,
        items: [],
        [{ field: 'fieldReplays', incident: 'incidentReplays', recheck: 'rechecks' }[kind]]:
          record.requested ? [assignment] : [],
      });
    }
    if (url.endsWith('/payload')) return new Response(payload);
    if (url.endsWith('/versions/' + versionId))
      return Response.json({
        id: versionId,
        bundleId,
        digest,
        parentVersionId: null,
        createdAt: '2026-11-12T00:00:00Z',
      });
    if (url.endsWith(path)) {
      record.posts.push(String(init.body));
      record.keys.push(new Headers(init.headers).get('Idempotency-Key') ?? '');
      if (record.failPost) throw new Error('lost acknowledgement');
      record.active = false;
      return Response.json({ accepted: true });
    }
    throw new Error('Unexpected request ' + url);
  });
  const app = defineEvaluation({
    configId: 'test',
    configRevision: '1',
    datasetRevision: '1',
    graderRevision: '1',
    runtime: {},
    execution: 'model-free',
    cases: [{ caseId: 'one', input: 1, expected: 1 }],
    async execute() {
      throw new Error('paired evaluator unavailable');
    },
    async grade() {
      throw new Error('paired grader unavailable');
    },
  });
  const integrationId = randomUUID();
  const apps: ConnectedLearningDriverOptions['apps'] = {
    development: app,
    audit: [],
    recheck: async ({ signal }) => {
      record.callbacks++;
      await record.run(signal!);
      return 'reproduced';
    },
    replayIncident: async ({ signal }) => {
      record.callbacks++;
      await record.run(signal!);
      return 'pass';
    },
    requalifyFieldCase: async ({ signal }) => {
      record.callbacks++;
      await record.run(signal!);
      return 'pass';
    },
  };
  const errors: unknown[] = [];
  async function run(mode?: 'live' | 'model-free', allowLive = false) {
    const stop = new AbortController();
    const codes: string[] = [];
    errors.length = 0;
    await serveConnectedLearning({
      integrationId,
      installationId: 'test',
      configPath,
      apps: {
        ...apps,
        recheckExecution: mode,
        requalifyFieldCaseExecution: mode,
        replayIncidentExecution: mode,
      },
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(30_000)]),
      allowLive,
      pollIntervalMs: 25,
      onDiagnostic(diagnostic, error) {
        errors.push(error);
        codes.push(diagnostic.code);
        stop.abort();
      },
    });
    return codes;
  }
  return { record, run, apps, errors };
}

for (const kind of ['recheck', 'field', 'incident'] as const) {
  test(
    kind + ' requires live opt-in and reposts its saved verdict after a driver restart',
    async (t) => {
      const { record, run } = await fixture(t, kind);
      assert.deepEqual(await run(), ['config.schema']);
      assert.deepEqual(await run('live'), ['config.schema']);
      assert.equal(record.callbacks, 0);
      record.failPost = true;
      assert.equal((await run('live', true)).length, 1);
      assert.equal(record.callbacks, kind === 'recheck' ? 1 : 3);
      record.failPost = false;
      assert.deepEqual(await run('live', false), []);
      assert.ok(record.posts.length >= 2);
      assert.equal(new Set(record.posts).size, 1);
      assert.equal(new Set(record.keys).size, 1);
      assert.ok(record.keys[0]);
      if (kind !== 'recheck') assert.deepEqual(JSON.parse(record.posts[0]!).attempts, ['pass', 'pass', 'pass']);
      assert.equal(record.callbacks, kind === 'recheck' ? 1 : 3);
    },
  );
  test(
    kind + ' holds an uncertain callback across restarts until the evaluator reconciles it',
    async (t) => {
      const { record, run, errors } = await fixture(t, kind);
      const failure = Object.assign(new Error('ambiguous callback failure'), {
        code: 'provider.timeout',
      });
      record.run = async () => {
        throw failure;
      };
      assert.deepEqual(await run('model-free'), ['execution.uncertain']);
      assert.equal((errors[0] as Error).cause, failure);
      assert.deepEqual(await run('model-free'), ['execution.uncertain']);
      assert.equal(record.callbacks, 1);
      assert.deepEqual(record.posts, []);
      record.active = false; // An external evaluator reconciled the retained job and submitted its verdict.
      assert.deepEqual(await run('model-free'), []);
    },
  );
  test(
    kind + ' skips a stale assignment before dispatch and cancels a withdrawn callback',
    async (t) => {
      const { record, run } = await fixture(t, kind);
      record.beforeWork = () => {
        if (record.reads > 1) {
          record.active = false;
          record.requested = false;
        }
      };
      assert.deepEqual(await run('model-free'), []);
      assert.equal(record.callbacks, 0);
      record.active = true;
      record.requested = true;
      record.beforeWork = () => {};
      record.run = async (signal) => {
        record.active = false;
        record.requested = false;
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError')
                reject(signal.reason);
              else resolve();
            },
            { once: true },
          );
        });
      };
      assert.deepEqual(await run('model-free'), []);
      assert.equal(record.callbacks, 1);
      assert.deepEqual(record.posts, []);
    },
  );
}

for (const [kind, callback, code] of [
  ['recheck', 'recheck', 'learning.recheck_callback_missing'],
  ['field', 'requalifyFieldCase', 'learning.field_replay_callback_missing'],
  ['incident', 'replayIncident', 'learning.incident_replay_callback_missing'],
] as const) {
  test(kind + ' exposes assigned work without a private callback', async (t) => {
    const { apps, record, run } = await fixture(t, kind);
    delete apps[callback];
    assert.deepEqual(await run('model-free'), [code]);
    assert.equal(record.callbacks, 0);
    assert.deepEqual(record.posts, []);
  });
}
