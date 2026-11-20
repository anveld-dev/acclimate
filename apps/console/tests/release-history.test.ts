import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readHistory, readVersion } from '../src/server/release-history';

const env = {
  ...consoleEnvironment,
  CONSOLE_SERVICE_TOKEN: 'secret',
  CONSOLE_WORKSPACE: 'fixed-project',
  CONSOLE_BUNDLE: 'fixed-bundle',
};
const bytes = JSON.stringify({
  schemaVersion: 1,
  files: [{ path: 'a.md', kind: 'instruction', text: 'hello' }],
});
const metadata = {
  id: 'v1',
  bundleId: 'fixed-bundle',
  parentVersionId: null,
  createdAt: '2026-01-01T00:00:00Z',
  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
};

test('stored versions use fixed scope and reject mismatched bytes', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    urls.push(String(input));
    return String(input).endsWith('/payload') ? new Response(bytes + ' ') : Response.json(metadata);
  };
  const result = await readVersion(
    env,
    { versionId: 'v1', workspaceId: 'other', bundleId: 'other' },
    fetcher,
  );
  assert.deepEqual(result, {
    ok: false,
    message: 'Content verification failed. No files were displayed.',
  });
  assert.ok(urls.every((url) => url.includes('/workspaces/fixed-project/bundles/fixed-bundle/')));
});

test('authenticated malformed version bytes keep the generic read failure and never expose content', async () => {
  for (const content of ['{private-invalid-json', '{"schemaVersion":1,"files":[]}']) {
    const version = {
      ...metadata,
      digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    };
    const result = await readVersion(env, { versionId: 'v1' }, async (input) =>
      String(input).endsWith('/payload') ? new Response(content) : Response.json(version),
    );
    assert.deepEqual(result, {
      ok: false,
      message: 'Could not read this version. Check the connection and retry.',
    });
  }
});

test('history validates canonical positive i64 cursors and fixes scope and limit', async () => {
  let called = false;
  const fetcher: typeof fetch = async (input) => {
    called = true;
    const url = new URL(String(input));
    assert.match(
      url.pathname,
      /workspaces\/fixed-project\/bundles\/fixed-bundle\/channels\/stable\/releases$/,
    );
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(url.searchParams.get('beforeRevision'), '42');
    return Response.json({ items: [], nextBeforeRevision: null });
  };
  for (const beforeRevision of ['0', '01', '-1', '9223372036854775808', '1x']) {
    assert.equal((await readHistory(env, { beforeRevision }, fetcher)).ok, false);
  }
  assert.equal(called, false);
  assert.equal(
    (await readHistory(env, { beforeRevision: '42', workspaceId: 'other' }, fetcher)).ok,
    true,
  );
});
