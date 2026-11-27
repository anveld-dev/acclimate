import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAcclimate } from '../../src/index.js';

test('job pins the verified version and prepares snapshots of it', async () => {
  const cacheDir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-job-test-'));
  const bytes = JSON.stringify({ schemaVersion: 1, files: [{ kind: 'instruction', path: 'AGENTS.md', text: 'Do the job.' }] });
  const version = {
    id: 'version', bundleId: 'bundle', parentVersionId: null, createdAt: 'now',
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  };
  try {
    const acclimate = createAcclimate({
      baseUrl: 'http://localhost', token: 'fake', workspaceId: 'test', cacheDir, retries: 0,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/bundles')) return url.searchParams.has('cursor')
          ? Response.json({ items: [{ id: 'bundle', name: 'support' }], nextCursor: null })
          : Response.json({ items: [], nextCursor: 'next' });
        if (url.pathname.endsWith('/channels/stable'))
          return Response.json({ channel: 'stable', revision: '1', version });
        if (url.pathname.endsWith('/versions/version')) return Response.json(version);
        if (url.pathname.endsWith('/payload')) return new Response(bytes);
        return new Response('not found', { status: 404 });
      },
    });
    const job = await acclimate.job('support', { channel: 'stable' });
    assert.deepEqual(job.version.version, version);
    assert.equal(job.prepare(verified => {
      verified.payload.files[0].text = 'Mutated.';
      return verified.payload.files[0].text;
    }), 'Mutated.');
    assert.equal(job.prepare(verified => verified.payload.files[0].text), 'Do the job.');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('a job refuses an ambiguous bundle name before resolving a version', async () => {
  const acclimate = createAcclimate({
    baseUrl: 'http://localhost', token: 'fake', workspaceId: 'test',
    fetch: async (input) => {
      const url = new URL(String(input));
      assert(url.pathname.endsWith('/bundles'));
      return url.searchParams.has('cursor')
        ? Response.json({ items: [{ id: 'b2', name: 'support' }], nextCursor: null })
        : Response.json({ items: [{ id: 'b1', name: 'support' }], nextCursor: 'next' });
    },
  });
  await assert.rejects(acclimate.job('support', { channel: 'stable' }), /Multiple bundles share that name/);
});

test('release uploads a child version, releases it with the read revision and skips an identical payload', async () => {
  const { fakeService } = await import('./fake-service.js');
  const { ApiError, payloadDigest } = await import('../../src/index.js');
  const service = await fakeService();
  try {
    const first = { schemaVersion: 1 as const, files: [{ path: 'AGENTS.md', kind: 'instruction' as const, text: 'One.\n' }] };
    const second = { schemaVersion: 1 as const, files: [{ path: 'AGENTS.md', kind: 'instruction' as const, text: 'Two.\n' }] };
    const bundle = service.addBundle('support', first);
    const [initial] = service.releases.get(`${bundle.id}:stable`)!;
    assert.equal(payloadDigest(first), initial.version.digest);
    let moveDuringRelease = false;
    const acclimate = createAcclimate({
      baseUrl: service.url, token: 'PRIVATE_CANARY', workspaceId: service.workspace, retries: 0,
      fetch: async (input, init) => {
        if (moveDuringRelease && init?.method === 'POST' && String(input).endsWith('/versions')) {
          const response = await fetch(input, init);
          service.release(bundle.id, 'stable', initial.version.id, 'Someone else');
          return response;
        }
        return fetch(input, init);
      },
    });
    await assert.rejects(acclimate.release('support', second, { reason: ' ' }), /reason is required/);
    const unchanged = await acclimate.release('support', first, { reason: 'Same' });
    assert.deepEqual([unchanged.changed, unchanged.version.id, unchanged.revision], [false, initial.version.id, '1']);
    assert.equal(service.traffic.filter((item) => item.method === 'POST').length, 0);
    const released = await acclimate.release('support', second, { reason: 'Second' });
    assert.deepEqual([released.changed, released.revision, released.channel], [true, '2', 'stable']);
    assert.equal(released.version.parentVersionId, initial.version.id);
    const [versionWrite, releaseWrite] = service.traffic.filter((item) => item.method === 'POST');
    assert.equal(releaseWrite.body.expectedRevision, '1');
    assert.equal(releaseWrite.body.unevaluatedReason, 'Second');
    assert.ok(versionWrite.key && releaseWrite.key && versionWrite.key !== releaseWrite.key);
    const beta = await acclimate.release('support', second, { channel: 'beta', reason: 'Try it' });
    assert.deepEqual([beta.revision, beta.version.parentVersionId], ['1', null]);
    moveDuringRelease = true;
    await assert.rejects(
      acclimate.release('support', { ...first, files: [{ ...first.files[0], text: 'Three.\n' }] }, { reason: 'Third' }),
      (error: unknown) => error instanceof ApiError && error.code === 'revision_conflict' && error.status === 409,
    );
    moveDuringRelease = false;
    const back = await acclimate.rollback('support', { reason: 'Undo' });
    assert.equal(back.version.id, released.version.id);
    assert.equal(back.revision, '4');
    await assert.rejects(acclimate.rollback('support', { channel: 'canary', reason: 'Undo' }), /no earlier version/);
    await assert.rejects(acclimate.release('missing', first, { reason: 'x' }), /No bundle with that name/);
  } finally {
    await service.close();
  }
});
