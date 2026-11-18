import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleDetailLabel, channelSwitchSearch } from '../src/navigation';

test('channel switch preserves only valid history selection and file context', () => {
  assert.deepEqual(
    channelSwitchSearch('changes', {
      history: '1',
      candidate: 'candidate',
      request: 'request',
      tab: 'files',
      path: 'a.md',
      comparison: 'old',
    }),
    { history: 1, candidate: 'candidate', request: 'request', tab: 'files', path: 'a.md' },
  );
  assert.deepEqual(
    channelSwitchSearch('changes', { history: 1, request: 'request', tab: 'files', path: 'a.md' }),
    { history: 1, request: 'request' },
  );
  assert.deepEqual(
    channelSwitchSearch('changes', { history: '1', candidate: 'c', tab: 'invalid', path: 'a.md' }),
    { history: 1, candidate: 'c' },
  );
  assert.deepEqual(channelSwitchSearch('changes', { draft: 'd', history: '1', request: 'r' }), {});
  assert.deepEqual(
    channelSwitchSearch('changes', { candidate: 'c', request: 'r', comparison: 'cmp' }),
    { candidate: 'c', request: 'r', comparison: 'cmp' },
  );
  assert.equal(
    bundleDetailLabel('changes', { history: '1', candidate: 'candidate', request: 'request' }),
    undefined,
  );
  assert.equal(
    bundleDetailLabel('changes', { candidate: 'candidate', request: 'request' }),
    'Review candidate',
  );
});
