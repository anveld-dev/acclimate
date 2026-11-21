import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAcclimate, type LearningOutcomeRequest } from '../../src/index.js';

test('job pins the verified version and retries one outcome body and idempotency key', async () => {
  const cacheDir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-job-test-'));
  const bytes = JSON.stringify({ schemaVersion: 1, files: [{ kind: 'instruction', path: 'AGENTS.md', text: 'Do the job.' }] });
  const version = {
    id: 'version', bundleId: 'bundle', parentVersionId: null, createdAt: 'now',
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  };
  const attempts: { key: string | null; body: LearningOutcomeRequest }[] = [];
  try {
    const acclimate = createAcclimate({
      baseUrl: 'http://localhost', token: 'fake', workspaceId: 'test', cacheDir, retries: 0,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/bundles')) return url.searchParams.has('cursor')
          ? Response.json({ items: [{ id: 'bundle', name: 'support' }], nextCursor: null })
          : Response.json({ items: [], nextCursor: 'next' });
        if (url.pathname.endsWith('/channels/stable'))
          return Response.json({ channel: 'stable', revision: '1', version });
        if (url.pathname.endsWith('/versions/version')) return Response.json(version);
        if (url.pathname.endsWith('/payload')) return new Response(bytes);
        assert(url.pathname.endsWith('/learning/outcomes'));
        const body = JSON.parse(String(init?.body)) as LearningOutcomeRequest;
        attempts.push({ key: new Headers(init?.headers).get('idempotency-key'), body });
        if (attempts.length === 1)
          return Response.json({ error: { code: 'unavailable', message: 'try again', requestId: 'retry' } }, { status: 503 });
        return Response.json({ outcomeId: body.outcomeId, caseId: 'outcome:' + body.outcomeId, evolveRevision: 1 });
      },
    });
    const input = { ticket: 1 };
    const job = await acclimate.job('support', { channel: 'stable', input });
    assert.deepEqual(job.version.version, version);
    assert.equal(job.prepare(verified => verified.payload.files[0].text), 'Do the job.');
    input.ticket = 2;
    const expected = { action: 'refund' };
    await assert.rejects(job.expect(expected), /try again/);
    expected.action = 'ignore';
    const [left, right] = await Promise.all([job.expect(expected), job.expect(expected)]);
    assert.equal(left, right);
    assert.deepEqual(attempts, Array(2).fill({
      key: job.outcomeId,
      body: { outcomeId: job.outcomeId, input: { ticket: 1 }, expected: { action: 'refund' }, versionId: version.id, digest: version.digest },
    }));
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
