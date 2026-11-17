import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  AcclimateClient,
  ApiError,
  prepareFiles,
  resolveAndCache,
  type VerifiedBundle,
} from '../../src/index.js';

const payloadBytes = await readFile(
  new URL('../../../../contracts/fixtures/bundle-v1.json', import.meta.url),
);
const digest = `sha256:${createHash('sha256').update(payloadBytes).digest('hex')}`;
const version = {
  id: 'v1',
  bundleId: 'b1',
  parentVersionId: null,
  digest,
  createdAt: '2026-11-13T00:00:00Z',
};
const resolution = { channel: 'stable', revision: '1', version };
async function fixture(
  handler: (req: any, res: any) => void | Promise<void>,
): Promise<{ server: Server; baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as any;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
  };
}
function send(res: any, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

test('mutation retry preserves exact bytes and idempotency key; errors retain request ID', async () => {
  let count = 0;
  const bodySeen: string[] = [],
    keys: string[] = [];
  const f = await fixture((req, res) => {
    let body = '';
    req.on('data', (b: Buffer) => (body += b));
    req.on('end', () => {
      bodySeen.push(body);
      keys.push(req.headers['idempotency-key']);
      if (++count === 1)
        send(res, 503, { error: { code: 'unavailable', message: 'retry', requestId: 'req-1' } });
      else send(res, 201, { id: 'b1', name: 'x', projectId: 'p', createdAt: 'now' });
    });
  });
  try {
    const c = new AcclimateClient({ baseUrl: f.baseUrl, token: 'secret', scope: 'principal-1' });
    await c.createBundle('p', { name: 'x' }, 'key-1');
    assert.equal(bodySeen.length, 2);
    assert.deepEqual(bodySeen, [bodySeen[0], bodySeen[0]]);
    assert.deepEqual(keys, ['key-1', 'key-1']);
    const denied = await fixture((_q, res) =>
      send(res, 403, { error: { code: 'denied', message: 'no', requestId: 'rid-denied' } }),
    );
    try {
      await assert.rejects(
        new AcclimateClient({ baseUrl: denied.baseUrl, token: 't', scope: 's' }).getVersion(
          'p',
          'b',
          'v',
        ),
        (e: any) => e instanceof ApiError && e.code === 'denied' && e.requestId === 'rid-denied',
      );
    } finally {
      await denied.close();
    }
  } finally {
    await f.close();
  }
});

test('conditional channel and exact-byte digest cache; explicit stale fallback never masks denial', async () => {
  let calls = 0,
    channelFailure = 0;
  const f = await fixture((req, res) => {
    if (req.url?.endsWith('/channels/stable')) {
      calls++;
      if (channelFailure) {
        send(res, channelFailure, {
          error: {
            code: channelFailure === 403 ? 'denied' : 'not_found',
            message: 'no',
            requestId: 'r',
          },
        });
      } else if (req.headers['if-none-match'] === '"1"') {
        res.writeHead(304, { etag: '"1"' });
        res.end();
      } else send(res, 200, resolution, { etag: '"1"' });
    } else if (req.url?.endsWith('/versions/v1')) send(res, 200, version);
    else if (req.url?.endsWith('/payload')) {
      res.writeHead(200);
      res.end(payloadBytes);
    } else send(res, 404, { error: { code: 'not_found', message: 'missing', requestId: 'n' } });
  });
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-cache-'));
  try {
    const client = new AcclimateClient({ baseUrl: f.baseUrl, token: 'secret', scope: 'principal' });
    const policy = { cacheDir: join(dir, 'cache') };
    const first = await resolveAndCache(
      client,
      { projectId: 'p', bundleId: 'b1', channel: 'stable' },
      policy,
    );
    assert.equal(first.version.digest, digest);
    assert.equal(first.stale, false);
    const second = await resolveAndCache(
      client,
      { projectId: 'p', bundleId: 'b1', channel: 'stable' },
      policy,
    );
    assert.equal(
      second.payload.files[0]?.text.trim(),
      'Review the supplied diff and support every finding.',
    );
    assert.equal(calls, 2);
    channelFailure = 503;
    const stale = await resolveAndCache(
      client,
      { projectId: 'p', bundleId: 'b1', channel: 'stable' },
      { ...policy, offline: { maxAgeMs: 99999 } },
    );
    assert.equal(stale.stale, true);
    for (const status of [403, 404]) {
      channelFailure = status;
      await assert.rejects(
        resolveAndCache(
          client,
          { projectId: 'p', bundleId: 'b1', channel: 'stable' },
          { ...policy, offline: { maxAgeMs: 99999 } },
        ),
        ApiError,
      );
    }
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('preparation refuses collisions and cleans only its own files', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-prepare-'));
  const verified: VerifiedBundle = {
    version,
    payload: {
      schemaVersion: 1,
      files: [{ path: 'instructions/review.md', kind: 'instruction', text: 'hello' }],
    },
    resolvedAt: Date.now(),
    stale: false,
  };
  try {
    const dest = join(dir, 'job');
    const prepared = await prepareFiles(verified, dest);
    assert.equal(await readFile(prepared.files[0]!.absolutePath, 'utf8'), 'hello');
    await assert.rejects(prepareFiles(verified, dest));
    await prepared.cleanup();
    await assert.rejects(readFile(prepared.files[0]!.absolutePath, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicitly pinned cached version is available offline after a prior verified fetch', async () => {
  let online = true;
  const f = await fixture((req, res) => {
    if (!online) {
      send(res, 503, { error: { code: 'unavailable', message: 'offline', requestId: 'offline' } });
      return;
    }
    if (req.url?.endsWith('/versions/v1')) send(res, 200, version);
    else if (req.url?.endsWith('/payload')) {
      res.writeHead(200);
      res.end(payloadBytes);
    } else send(res, 404, { error: { code: 'not_found', message: 'missing', requestId: 'n' } });
  });
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-pin-'));
  try {
    const c = new AcclimateClient({ baseUrl: f.baseUrl, token: 'secret', scope: 'principal' });
    const policy = { cacheDir: join(dir, 'cache') };
    await resolveAndCache(c, { projectId: 'p', bundleId: 'b1', versionId: 'v1' }, policy);
    online = false;
    const bundle = await resolveAndCache(
      c,
      { projectId: 'p', bundleId: 'b1', versionId: 'v1' },
      { ...policy, offline: { pinnedVersionId: 'v1' } },
    );
    assert.equal(bundle.stale, true);
    assert.equal(
      bundle.payload.files[0]?.text.trim(),
      'Review the supplied diff and support every finding.',
    );
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('promotion history encodes its query, returns a page and preserves typed errors', async () => {
  const paths: string[] = [];
  const f = await fixture((req, res) => {
    paths.push(req.url);
    if (req.url.includes('limit=0'))
      return send(res, 400, {
        error: { code: 'invalid_content', message: 'bad limit', requestId: 'bad' },
      });
    if (req.url.includes('beforeRevision=denied'))
      return send(res, 403, { error: { code: 'denied', message: 'no', requestId: 'deny' } });
    send(res, 200, { items: [], nextBeforeRevision: null });
  });
  try {
    const c = new AcclimateClient({ baseUrl: f.baseUrl, token: 'secret', scope: 'principal' });
    assert.deepEqual(
      await c.listPromotions('p', 'b', 'stable', { limit: 100, beforeRevision: 'a&b' }),
      { items: [], nextBeforeRevision: null },
    );
    assert.match(paths[0], /limit=100&beforeRevision=a%26b$/);
    await assert.rejects(
      c.listPromotions('p', 'b', 'stable', { limit: 0 }),
      (e: unknown) => e instanceof ApiError && e.status === 400 && e.code === 'invalid_content',
    );
    await assert.rejects(
      c.listPromotions('p', 'b', 'stable', { beforeRevision: 'denied' }),
      (e: unknown) => e instanceof ApiError && e.status === 403 && e.code === 'denied',
    );
    assert.throws(() => c.listPromotions('..', 'b', 'stable'), TypeError);
  } finally {
    await f.close();
  }
});

test('redirect responses are errors and cannot silently forward credentials', async () => {
  let reached = false;
  const target = await fixture((_req, res) => {
    reached = true;
    send(res, 200, {});
  });
  const redirect = await fixture((_req, res) => {
    res.writeHead(302, { location: target.baseUrl });
    res.end();
  });
  try {
    const c = new AcclimateClient({
      baseUrl: redirect.baseUrl,
      token: 'secret',
      scope: 'principal',
    });
    await assert.rejects(
      c.listPromotions('p', 'b', 'stable'),
      (e: unknown) => e instanceof ApiError && e.status === 302,
    );
    assert.equal(reached, false);
  } finally {
    await redirect.close();
    await target.close();
  }
});

test('connection-qualified delivery isolates conditional and offline entries for a shared reader', async () => {
  const enrolled = 'a7100000-0000-0000-0000-000000000001';
  const sibling = 'a7100000-0000-0000-0000-000000000002';
  const candidate = { ...version, id: 'candidate' };
  const seen: Array<{ path: string; connection?: string; etag?: string }> = [];
  let offline = false;
  const service = await fixture((req, res) => {
    const connection = req.headers['x-acclimate-integration-id'] as string | undefined;
    seen.push({ path: req.url, connection, etag: req.headers['if-none-match'] });
    if (offline) return send(res, 503, {});
    if (req.url.endsWith('/channels/stable')) {
      return send(res, 200, { ...resolution, version: connection === enrolled ? candidate : version }, {
        etag: connection === enrolled ? '"connection:1"' : '"1"',
      });
    }
    if (req.url.endsWith('/payload')) {
      res.writeHead(200);
      return res.end(payloadBytes);
    }
    return send(res, 404, {});
  });
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-connection-cache-'));
  try {
    const make = (integrationId?: string) => new AcclimateClient({
      baseUrl: service.baseUrl, token: 'shared-reader', scope: 'project-reader', integrationId,
    });
    const policy = { cacheDir: dir, offline: { maxAgeMs: 60_000 } };
    const selection = { projectId: 'p', bundleId: 'b1', channel: 'stable' };
    const resolved = await resolveAndCache(make(enrolled), selection, policy);
    assert.equal(resolved.version.id, 'candidate');
    assert.deepEqual(resolved.connection, { projectId: 'p', integrationId: enrolled });
    assert.equal((await resolveAndCache(make(sibling), selection, policy)).version.id, 'v1');
    assert.deepEqual(seen.map(call => call.connection), [enrolled, enrolled, sibling, sibling]);
    assert.equal(seen[2]?.etag, undefined);
    offline = true;
    assert.equal((await resolveAndCache(make(enrolled), selection, policy)).version.id, 'candidate');
    assert.equal((await resolveAndCache(make(sibling), selection, policy)).version.id, 'v1');
    await assert.rejects(resolveAndCache(make(), selection, policy), ApiError);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
