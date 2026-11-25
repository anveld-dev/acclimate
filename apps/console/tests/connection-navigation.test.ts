import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionHref } from '../src/lib/connection-navigation';

test('selecting a connection retains only the originating bundle and channel filters', () => {
  const href = connectionHref(
    'workspace one',
    { bundleId: 'bundle/a', channel: 'canary & next' },
    'id/one',
  );
  const url = new URL(href, 'https://console.invalid');
  assert.equal(url.pathname, '/w/workspace%20one/connections');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    connection: 'id/one',
    bundleId: 'bundle/a',
    channel: 'canary & next',
  });
  assert.equal(connectionHref('w', { bundleId: [], channel: undefined }), '/w/w/connections');
  assert.equal(connectionHref('w'), '/w/w/connections');
});

test('returning to the directory preserves a search and supported access state', () => {
  assert.equal(
    connectionHref('w', { q: '  api worker ', access: 'revoked' }),
    '/w/w/connections?q=api+worker&access=revoked',
  );
  assert.equal(connectionHref('w', { q: ' ', access: 'invalid' }), '/w/w/connections');
});
