import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  realpath,
  rm,
  readFile,
  stat,
  symlink,
  mkdir,
  readdir,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AcclimateClient,
  ApiError,
  resolveAndCache,
  prepareFiles,
} from '../packages/sdk/src/index.js';

const bytes = await readFile(new URL('../contracts/fixtures/bundle-v1.json', import.meta.url));
const version = {
  id: 'v1',
  bundleId: 'b1',
  parentVersionId: null,
  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  createdAt: '2026-11-13T00:00:00Z',
};
async function harness() {
  let mode = 200;
  let wrongVersion = false;
  let downloads = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (mode !== 200) {
      res.writeHead(mode);
      res.end(
        JSON.stringify({
          error: {
            code: mode === 503 ? 'unavailable' : 'denied',
            message: 'fixture',
            requestId: 'fixture-id',
          },
        }),
      );
      return;
    }
    if (req.url?.endsWith('/channels/stable')) {
      if (req.headers['if-none-match'] === '"1"') {
        res.writeHead(304, { ETag: '"1"' });
        res.end();
      } else {
        res.setHeader('ETag', '"1"');
        res.end(JSON.stringify({ channel: 'stable', revision: '1', version }));
      }
    } else if (req.url?.endsWith('/payload')) {
      downloads++;
      res.end(bytes);
    } else res.end(JSON.stringify(wrongVersion ? { ...version, id: 'wrong-id' } : version));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-boundaries-'));
  const client = new AcclimateClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    scope: 'fixture-principal',
    token: 'fixture-token',
  });
  return {
    client,
    root,
    policy: { cacheDir: join(root, 'cache') },
    mode: (next: number) => {
      mode = next;
    },
    wrong: () => {
      wrongVersion = true;
    },
    downloads: () => downloads,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('offline fallback uses same scoped mapping, permits unavailable only and never denial or missing', async () => {
  const h = await harness();
  try {
    const selection = { projectId: 'p', bundleId: 'b1', channel: 'stable' };
    const first = await resolveAndCache(h.client, selection, h.policy);
    h.mode(503);
    const cached = await resolveAndCache(h.client, selection, {
      ...h.policy,
      offline: { maxAgeMs: 60_000 },
    });
    assert.equal(cached.version.id, first.version.id);
    assert.equal(cached.stale, true);
    assert.equal(h.downloads(), 1);
    for (const status of [401, 403, 404]) {
      h.mode(status);
      await assert.rejects(
        resolveAndCache(h.client, selection, { ...h.policy, offline: { maxAgeMs: 60_000 } }),
        (e) => e instanceof ApiError && e.status === status,
      );
    }
  } finally {
    await h.close();
  }
});

test('concurrent readers publish one usable private cache and complete payloads', async () => {
  const h = await harness();
  try {
    const all = await Promise.all(
      Array.from({ length: 8 }, () =>
        resolveAndCache(h.client, { projectId: 'p', bundleId: 'b1', versionId: 'v1' }, h.policy),
      ),
    );
    assert.ok(
      all.every((v) => v.version.digest === version.digest && v.payload.files.length === 3),
    );
    assert.equal((await stat(h.policy.cacheDir)).mode & 0o777, 0o700);
    for (const dir of await readdir(h.policy.cacheDir)) {
      const entry = join(h.policy.cacheDir, dir, 'entry.json');
      const stored = JSON.parse(await readFile(entry, 'utf8'));
      assert.ok(stored);
      assert.equal((await stat(entry)).mode & 0o777, 0o600);
    }
  } finally {
    await h.close();
  }
});

test('pinned selection rejects a different version returned by the service', async () => {
  const h = await harness();
  try {
    h.wrong();
    await assert.rejects(
      resolveAndCache(h.client, { projectId: 'p', bundleId: 'b1', versionId: 'v1' }, h.policy),
      /version|metadata/i,
    );
  } finally {
    await h.close();
  }
});

test('a cache directory symlink cannot redirect private writes', async () => {
  const h = await harness();
  try {
    const outside = join(h.root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, h.policy.cacheDir);
    await assert.rejects(
      resolveAndCache(h.client, { projectId: 'p', bundleId: 'b1', versionId: 'v1' }, h.policy),
      /symlink|unsafe/i,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await h.close();
  }
});

test('offline cache age must be finite and bounded before fetching', async () => {
  const h = await harness();
  try {
    for (const maxAgeMs of [Infinity, NaN, -1, 31 * 24 * 60 * 60 * 1000]) {
      await assert.rejects(
        resolveAndCache(
          h.client,
          { projectId: 'p', bundleId: 'b1', channel: 'stable' },
          { ...h.policy, offline: { maxAgeMs } },
        ),
        /offline.maxAgeMs/,
      );
    }
    assert.equal(h.downloads(), 0);
  } finally {
    await h.close();
  }
});

test('existing public cache and preparation directories are rejected without chmod', async () => {
  const h = await harness();
  try {
    const shared = join(h.root, 'existing');
    await mkdir(shared);
    await chmod(shared, 0o755);
    await assert.rejects(
      resolveAndCache(
        h.client,
        { projectId: 'p', bundleId: 'b1', versionId: 'v1' },
        { cacheDir: shared },
      ),
      /private/,
    );
    assert.equal((await stat(shared)).mode & 0o777, 0o755);
    await assert.rejects(
      prepareFiles(
        { version, payload: JSON.parse(bytes.toString()), resolvedAt: Date.now(), stale: false },
        shared,
      ),
      /private/,
    );
    assert.equal((await stat(shared)).mode & 0o777, 0o755);
  } finally {
    await h.close();
  }
});
