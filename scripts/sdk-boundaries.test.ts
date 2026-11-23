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

test('channel delivery requires the service even when bytes are cached', async () => {
  const h = await harness();
  try {
    const selection = { workspaceId: 'p', bundleId: 'b1', channel: 'stable' };
    await resolveAndCache(h.client, selection, h.policy);
    for (const status of [503, 401, 403, 404]) {
      h.mode(status);
      await assert.rejects(
        resolveAndCache(h.client, selection, h.policy),
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
        resolveAndCache(h.client, { workspaceId: 'p', bundleId: 'b1', versionId: 'v1' }, h.policy),
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
      resolveAndCache(h.client, { workspaceId: 'p', bundleId: 'b1', versionId: 'v1' }, h.policy),
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
      resolveAndCache(h.client, { workspaceId: 'p', bundleId: 'b1', versionId: 'v1' }, h.policy),
      /symlink|unsafe/i,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await h.close();
  }
});

test('a new job cannot select an offline version', async () => {
  const h = await harness();
  try {
    await assert.rejects(resolveAndCache(h.client, { workspaceId: 'p', bundleId: 'b1', channel: 'stable' },
      { ...h.policy, offline: { pinnedVersionId: 'v1' } }), /resolve the channel online/);
    assert.equal(h.downloads(), 0);
  } finally { await h.close(); }
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
        { workspaceId: 'p', bundleId: 'b1', versionId: 'v1' },
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

/** Every module specifier in a source file: static imports, re-exports and dynamic import(). */
function moduleSpecifiers(source: string): string[] {
  const found = [];
  for (const match of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm,
  ))
    found.push(match[1]);
  return found;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(filename)));
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
      files.push(filename);
  }
  return files;
}

test('examples import only published @acclimate package entry points', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const exportsByPackage = new Map<string, Set<string>>();
  for (const name of await readdir(join(root, 'packages'))) {
    const manifest = await readFile(join(root, 'packages', name, 'package.json'), 'utf8').catch(
      () => null,
    );
    if (!manifest) continue;
    const parsed = JSON.parse(manifest) as { name: string; exports?: Record<string, unknown> };
    exportsByPackage.set(parsed.name, new Set(Object.keys(parsed.exports ?? { '.': null })));
  }
  const violations: string[] = [];
  for (const filename of await sourceFiles(join(root, 'examples'))) {
    if (filename.startsWith(join(root, 'examples/self-improvement-memory') + '/')) continue;
    const relative = filename.slice(root.length);
    for (const specifier of moduleSpecifiers(await readFile(filename, 'utf8'))) {
      if (/(?:^|\/)packages\/[^/]+\/(?:src|dist)(?:\/|$)/.test(specifier)) {
        violations.push(`${relative}: ${specifier} reaches into a package's source`);
        continue;
      }
      const scoped = /^(@acclimate\/[^/]+)(\/.*)?$/.exec(specifier);
      if (!scoped) continue;
      const exported = exportsByPackage.get(scoped[1]);
      if (exported && !exported.has('.' + (scoped[2] ?? '')))
        violations.push(`${relative}: ${specifier} is not an exported entry point of ${scoped[1]}`);
    }
  }
  assert.deepEqual(violations, []);
});
