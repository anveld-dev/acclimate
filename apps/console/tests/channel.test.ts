import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readChannel } from '../src/server/channel';

const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'private-fixture-token',
  CONSOLE_PROJECT: 'demo',
  CONSOLE_BUNDLE: 'bundle',
};
const payload = {
  schemaVersion: 1,
  files: [
    {
      kind: 'instruction',
      path: 'instructions/review.md',
      text: '<script>untrusted text</script>',
    },
  ],
};
const bytes = JSON.stringify(payload) + '\n';
const resolution = {
  channel: 'stable',
  revision: '2',
  version: {
    id: 'version',
    bundleId: 'bundle',
    parentVersionId: null,
    createdAt: '2026-11-13T00:00:00Z',
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  },
};

function fixture(content = bytes, role = 'admin', versionDigest = resolution.version.digest) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/v1/workspaces?'))
      return Response.json({
        items: [{ id: env.CONSOLE_PROJECT, name: 'Workspace', role }],
        nextCursor: null,
      });
    if (url.includes('/bundles?'))
      return Response.json({
        items: [{ id: 'bundle', origin: 'unknown', compatibilityTarget: 'codex' }],
        nextCursor: null,
      });
    calls.push(url);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      `Bearer ${env.CONSOLE_SERVICE_TOKEN}`,
    );
    if (url.includes('/releases?')) return Response.json({ items: [], nextBeforeRevision: null });
    if (url.endsWith('/payload')) return new Response(content);
    return Response.json({
      ...resolution,
      version: { ...resolution.version, digest: versionDigest },
    });
  };
  return { calls, fetcher };
}

test('unconfigured console makes no network request and returns only missing variable names', async () => {
  const result = await readChannel({}, async () => {
    throw new Error('Unexpected request');
  });
  assert.deepEqual(result, {
    status: 'setup',
    missing: ['CONSOLE_SERVICE_TOKEN', 'CONSOLE_PROJECT', 'CONSOLE_BUNDLE'],
  });
});

test('loads a pinned channel payload and bounded history without exposing service credentials', async () => {
  const { calls, fetcher } = fixture();
  const result = await readChannel(env, fetcher);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.payload, payload);
  assert.equal(result.compatibilityTarget, 'codex');
  assert.deepEqual(result.source, {
    kind: 'configured-bundle',
    storage: 'postgresql',
    isWorkingTree: false,
  });
  assert.deepEqual(result.resolution, resolution);
  assert.equal(calls.length, 3);
  assert.ok(calls.some((url) => url.endsWith('/versions/version/payload')));
  assert.ok(calls.some((url) => url.includes('limit=20')));
  assert.ok(!JSON.stringify(result).includes(env.CONSOLE_SERVICE_TOKEN));
});

test('rejects a payload whose bytes do not match the resolved digest', async () => {
  const result = await readChannel(env, fixture(bytes + ' ').fetcher);
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.match(result.message, /verification failed/);
  assert.ok(!('payload' in result));
});

test('authenticated malformed channel payloads keep the generic error and hide all content', async () => {
  for (const content of ['{private-invalid-json', '{"schemaVersion":1,"files":[]}']) {
    const versionDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const result = await readChannel(env, fixture(content, 'admin', versionDigest).fetcher);
    assert.equal(result.status, 'error');
    if (result.status === 'error')
      assert.equal(
        result.message,
        'Could not read the service. Check the connection and server configuration, then retry.',
      );
    assert.ok(!('payload' in result));
  }
});

test('denial is an error, never an empty library or fallback data', async () => {
  const result = await readChannel(env, async () =>
    Response.json(
      { error: { code: 'forbidden', message: env.CONSOLE_SERVICE_TOKEN } },
      { status: 403 },
    ),
  );
  assert.equal(result.status, 'error');
  assert.ok(!JSON.stringify(result).includes(env.CONSOLE_SERVICE_TOKEN));
  if (result.status === 'error') assert.match(result.message, /Access denied/);
});

test('unexpected failures do not serialize raw errors or token-bearing URLs', async () => {
  const result = await readChannel(env, async () => {
    throw new Error(env.CONSOLE_SERVICE_TOKEN);
  });
  assert.equal(result.status, 'error');
  assert.ok(!JSON.stringify(result).includes(env.CONSOLE_SERVICE_TOKEN));
});

test('environment labels cannot classify legacy content as an example', async () => {
  const result = await readChannel(
    { ...env, CONSOLE_DATA_SOURCE: 'seeded-example' },
    fixture().fetcher,
  );
  assert.equal(result.status, 'ready');
  if (result.status === 'ready')
    assert.deepEqual(result.source, {
      kind: 'configured-bundle',
      storage: 'postgresql',
      isWorkingTree: false,
    });
});

test('historical bundles keep their stored example origin and published content', async () => {
  const { fetcher } = fixture();
  const result = await readChannel(env, (input, init) =>
    String(input).includes('/bundles?')
      ? Promise.resolve(
          Response.json({ items: [{ id: 'bundle', origin: 'example' }], nextCursor: null }),
        )
      : fetcher(input, init),
  );
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') {
    assert.equal(result.source.kind, 'seeded-example');
    assert.deepEqual(result.payload, payload);
  }
});

test('failed refresh retains only the prior verified observation and hides content', async () => {
  const success = await readChannel(env, fixture().fetcher);
  assert.equal(success.status, 'ready');
  const failed = await readChannel(env, async () => {
    throw new Error('network');
  });
  assert.equal(failed.status, 'error');
  if (success.status === 'ready' && failed.status === 'error')
    assert.equal(failed.lastSuccessfulRead, success.lastSuccessfulRead);
  assert.ok(!('payload' in failed));
});

test('current workspace membership controls editing and public setup never exposes internal address', async () => {
  for (const role of ['viewer', 'editor', 'admin', 'operator']) {
    const state = await readChannel(
      { ...env, CONSOLE_ALLOW_EDITS: 'true' },
      fixture(bytes, role).fetcher,
    );
    assert.equal(state.status, 'ready');
    if (state.status !== 'ready') continue;
    assert.equal(state.canEdit, role === 'editor' || role === 'admin');
    assert.equal(state.publicApiUrl, 'https://api.example');
    assert.equal(JSON.stringify(state).includes(env.CONSOLE_SERVICE_URL), false);
    assert.equal(JSON.stringify(state).includes(env.CONSOLE_SESSION_TOKEN), false);
  }
});

test('anonymous direct content read denies before any SDK request', async () => {
  let calls = 0;
  const result = await readChannel({ ...env, CONSOLE_SESSION_TOKEN: undefined }, async () => {
    calls++;
    throw Error('must not request machine-authenticated content');
  });
  assert.equal(result.status, 'error');
  assert.equal(calls, 0);
});
