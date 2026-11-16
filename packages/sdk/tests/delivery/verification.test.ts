import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AcclimateClient,
  DeliveryError,
  resolveAndCache,
  verifyPayloadBytes,
} from '../../src/index.js';

const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const payload = {
  schemaVersion: 1,
  files: [{ path: 'instructions.md', kind: 'instruction', text: 'Café\r\nNext line\n' }],
};
const bytes = Buffer.from(JSON.stringify(payload, null, 2) + '\r\n');

test('verification preserves document bytes and authenticates the original JSON serialization', () => {
  assert.deepEqual(verifyPayloadBytes(bytes, digest(bytes)), payload);
  const serializedAgain = Buffer.from(JSON.stringify(payload));
  assert.throws(
    () => verifyPayloadBytes(bytes, digest(serializedAgain)),
    (error) => error instanceof DeliveryError && error.code === 'digest_mismatch',
  );
});

test('digest rejection precedes interpretation; authenticated malformed bytes retain their errors', () => {
  const invalidUtf8 = Uint8Array.of(0xff);
  const invalidJson = Buffer.from('{');
  const invalidSchema = Buffer.from('{"schemaVersion":1,"files":[]}');
  for (const malformed of [invalidUtf8, invalidJson, invalidSchema])
    assert.throws(
      () => verifyPayloadBytes(malformed, digest(bytes)),
      (error) => error instanceof DeliveryError && error.code === 'digest_mismatch',
    );
  assert.throws(() => verifyPayloadBytes(invalidUtf8, digest(invalidUtf8)), TypeError);
  assert.throws(() => verifyPayloadBytes(invalidJson, digest(invalidJson)), SyntaxError);
  assert.throws(
    () => verifyPayloadBytes(invalidSchema, digest(invalidSchema)),
    (error) => error instanceof DeliveryError && error.code === 'unsupported_schema',
  );
});

function clientFor(content: Uint8Array, expectedDigest = digest(content), onPayload = () => {}) {
  return new AcclimateClient({
    baseUrl: 'http://verification.fixture',
    token: 'fixture',
    scope: 'test',
    retries: 0,
    maxPayloadBytes: 2 * 1024 * 1024,
    fetch: async (input) => {
      if (String(input).endsWith('/payload')) {
        onPayload();
        return new Response(Uint8Array.from(content));
      }
      return Response.json({
        id: 'v1',
        bundleId: 'b1',
        parentVersionId: null,
        createdAt: 'now',
        digest: expectedDigest,
      });
    },
  });
}
const selection = { projectId: 'p1', bundleId: 'b1', versionId: 'v1' };

test('delivery still evicts corrupted cached bytes and replaces them with verified network content', async () => {
  const cacheDir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-verification-'));
  let downloads = 0;
  const client = clientFor(bytes, digest(bytes), () => {
    downloads++;
  });
  try {
    await resolveAndCache(client, selection, { cacheDir });
    for (const name of await readdir(cacheDir)) {
      const path = join(cacheDir, name, 'entry.json');
      const entry = JSON.parse(await readFile(path, 'utf8'));
      if (entry.payloadBytes) {
        entry.payloadBytes = Buffer.from('corrupt').toString('base64');
        await writeFile(path, JSON.stringify(entry));
      }
    }
    assert.deepEqual((await resolveAndCache(client, selection, { cacheDir })).payload, payload);
    assert.equal(downloads, 2);
    await resolveAndCache(client, selection, { cacheDir });
    assert.equal(downloads, 2, 'The repaired entry must remain reusable');
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('download verification retains delivery error translation and size-limit precedence', async () => {
  const malformed = Buffer.from('{');
  const invalidUtf8 = Uint8Array.of(0xff);
  const invalidSchema = Buffer.from('{"schemaVersion":1,"files":[]}');
  for (const [content, expectedDigest, code, message] of [
    [
      malformed,
      digest(bytes),
      'digest_mismatch',
      'Downloaded payload SHA-256 does not match version metadata',
    ],
    [malformed, digest(malformed), 'invalid_payload', 'Downloaded payload is not valid UTF-8 JSON'],
    [
      invalidUtf8,
      digest(invalidUtf8),
      'invalid_payload',
      'Downloaded payload is not valid UTF-8 JSON',
    ],
    [
      invalidSchema,
      digest(invalidSchema),
      'unsupported_schema',
      'Unsupported or malformed bundle payload schema',
    ],
    [
      Buffer.alloc(1024 * 1024 + 1),
      digest(bytes),
      'invalid_payload',
      'Downloaded payload exceeds size limit',
    ],
  ] as const) {
    const cacheDir = await mkdtemp(join(await realpath(tmpdir()), 'acclimate-verification-'));
    try {
      const client = clientFor(content, expectedDigest);
      // The transport can allow more bytes; delivery retains its own 1 MiB limit.
      await assert.rejects(
        resolveAndCache(client, selection, { cacheDir }),
        (error) =>
          error instanceof DeliveryError && error.code === code && error.message === message,
      );
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  }
});
