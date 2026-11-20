import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bundleDetailLabel,
  releaseRevision,
  bundleHref,
  bundleViewLabels,
  channelSwitchSearch,
} from '../src/navigation';
import { consoleDestination } from '../src/components/console-link';

const scope = { workspaceId: 'workspace', bundleId: 'bundle', channel: 'canary' };

test('channel switch retains Content filters and selected path without leaking unrelated detail', () => {
  const search = channelSwitchSearch('content', {
    q: 'review',
    query: 'legacy',
    kind: 'skill',
    path: 'skills/review/SKILL.md',
    draft: 'old',
    comparison: 'old',
  });
  const url = new URL(bundleHref(scope, 'content', search), 'https://console.invalid');
  assert.equal(url.pathname, '/w/workspace/bundles/bundle/channels/canary/content');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    q: 'review',
    query: 'legacy',
    kind: 'skill',
    path: 'skills/review/SKILL.md',
  });
});

test('channel-owned draft and saved-draft review selection return to the Changes list', () => {
  for (const draft of ['new', 'saved']) {
    assert.deepEqual(
      channelSwitchSearch('changes', {
        draft,
        candidate: 'snapshot',
        generation: 2,
        comparison: 'evidence',
        path: 'a.md',
      }),
      {},
    );
  }
});

test('bundle-wide suggestion selection survives target navigation for a fresh review mount', () => {
  const search = channelSwitchSearch('changes', {
    proposal: 'proposal',
    candidate: 'snapshot',
    generation: 3,
    comparison: 'evidence',
    path: 'old',
    reason: 'old approval',
  });
  const url = new URL(bundleHref(scope, 'changes', search), 'https://console.invalid');
  assert.equal(url.searchParams.get('channel'), 'canary');
  assert.deepEqual(search, {
    proposal: 'proposal',
    candidate: 'snapshot',
    generation: 3,
    comparison: 'evidence',
  });
  assert.deepEqual(channelSwitchSearch('connect', search), {});
  assert.deepEqual(channelSwitchSearch('releases', search), {});
});

test('setup retains its existing route and fragment navigation', () => {
  assert.deepEqual(Object.values(bundleViewLabels), ['Content', 'Changes', 'Releases']);
  const href = bundleHref(scope, 'connect') + '#reporting';
  const destination = consoleDestination(href);
  assert.equal(destination.params._splat, 'workspace/bundles/bundle/channels/canary/connect');
  assert.equal(destination.hash, 'reporting');
});

test('bundle breadcrumbs identify the current detail using short labels', () => {
  assert.equal(bundleDetailLabel('content', { path: 'skills/review/SKILL.md' }), 'SKILL.md');
  assert.equal(bundleDetailLabel('changes', { draft: 'new' }), 'New draft');
  assert.equal(
    bundleDetailLabel('changes', { candidate: 'snapshot-123456789' }),
    'Review snapshot-123',
  );
  assert.equal(
    bundleDetailLabel('changes', { draft: 'saved', candidate: 'snapshot' }),
    'Review draft saved',
  );
  assert.equal(bundleDetailLabel('changes', { draft: 42, candidate: {} }), undefined);
  assert.equal(bundleDetailLabel('connect', { draft: 'unused' }), undefined);
});

test('release return locations use positive 64-bit revisions and drop them on channel switch', () => {
  for (const [value, normalized] of [
    [1, '1'],
    ['42', '42'],
    ['9223372036854775807', '9223372036854775807'],
  ]) {
    assert.equal(releaseRevision(value), normalized);
  }
  for (const invalid of [
    undefined,
    0,
    '-1',
    '01',
    1.5,
    {},
    'other/channel',
    '9223372036854775808',
    1e30,
  ]) {
    assert.equal(releaseRevision(invalid), undefined);
  }
  assert.deepEqual(
    channelSwitchSearch('changes', { candidate: 'v', history: 1, tab: 'files', fromRevision: 4 }),
    { candidate: 'v', history: 1, tab: 'files' },
  );
});
