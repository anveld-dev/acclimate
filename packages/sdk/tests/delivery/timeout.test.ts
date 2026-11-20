import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AcclimateClient,
  ApiError,
  DeliveryError,
  TransportError,
  resolveAndCache,
} from '../../src/index.js';

const bytes = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    files: [{ path: 'guide.md', kind: 'instruction', text: 'Verified guidance' }],
  }),
);
const version = {
  id: 'v',
  bundleId: 'b',
  parentVersionId: null,
  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  createdAt: '2026-11-14',
};

for (const kind of ['channel', 'version'] as const) {
  for (const stall of ['headers', 'body'] as const) {
    test(`native HTTP ${stall} timeout checks cached ${kind} bytes and delivery freshness`, async () => {
      let mode: 'online' | 'stall' | 'denied' | 'corrupt' = 'online';
      let denial = 403;
      const server = createServer((req, res) => {
        if (req.url!.endsWith('/payload')) {
          res.end(mode === 'corrupt' ? Buffer.from('tampered') : bytes);
          return;
        }
        if (mode === 'stall' || (mode === 'corrupt' && kind === 'version')) {
          if (stall === 'body') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{');
          }
          return;
        }
        if (mode === 'denied') {
          res.writeHead(denial, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'denied', message: 'no', requestId: 'deny' } }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify(
            kind === 'channel' ? { channel: 'stable', revision: '1', version } : version,
          ),
        );
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const address = server.address() as { port: number };
      const dir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-timeout-'));
      const client = new AcclimateClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: 'test-read',
        scope: 'test-reader',
        // Leave headroom for real HTTP/cache setup under parallel test load.
        // The stalled server never replies, so the timeout remains deterministic.
        timeoutMs: 500,
        retries: 0,
      });
      const selection =
        kind === 'channel'
          ? { workspaceId: 'p', bundleId: 'b', channel: 'stable' }
          : { workspaceId: 'p', bundleId: 'b', versionId: 'v' };
      const offline = kind === 'channel' ? undefined : { pinnedVersionId: 'v' };
      try {
        await resolveAndCache(client, selection, { cacheDir: dir });
        mode = 'stall';
        // Native AbortSignal.timeout is exercised by real stalled HTTP, no mocked error.
        // The client reports it as a TransportError that keeps the native error as its cause.
        await assert.rejects(
          resolveAndCache(client, selection, { cacheDir: dir }),
          (e: any) =>
            e instanceof TransportError &&
            e.code === 'transport.timeout' &&
            e.cause instanceof DOMException &&
            ['TimeoutError', 'AbortError'].includes(e.cause.name),
        );
        if (kind === 'version') {
          const cached = await resolveAndCache(client, selection, { cacheDir: dir, offline });
          assert.equal(cached.stale, true);
          assert.equal(cached.payload.files[0]!.text, 'Verified guidance');
        }
        await assert.rejects(
          resolveAndCache(client, selection, {
            cacheDir: dir,
            offline: { pinnedVersionId: 'other' },
          }),
        );
        mode = 'denied';
        for (denial of [401, 403, 404]) {
          await assert.rejects(
            resolveAndCache(client, selection, { cacheDir: dir, offline }),
            (e: unknown) => e instanceof ApiError && e.status === denial,
          );
        }
        // Corrupt the test-owned payload cache. A permitted metadata fallback must
        // still reject bytes that fail integrity verification, never return them.
        for (const name of await readdir(dir)) {
          const path = join(dir, name, 'entry.json');
          const entry = JSON.parse(await readFile(path, 'utf8'));
          if (entry.payloadBytes) {
            entry.payloadBytes = Buffer.from('tampered').toString('base64');
            await writeFile(path, JSON.stringify(entry));
          }
        }
        mode = 'corrupt';
        await assert.rejects(
          resolveAndCache(client, selection, { cacheDir: dir, offline }),
          (e: unknown) => e instanceof DeliveryError && e.code === 'digest_mismatch',
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((r, reject) => server.close((e) => (e ? reject(e) : r())));
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
