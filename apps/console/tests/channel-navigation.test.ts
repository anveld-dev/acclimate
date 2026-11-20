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

test('setup retains its existing route and fragment navigation', () => {
  assert.deepEqual(Object.values(bundleViewLabels), ['Content', 'Releases']);
  const href = bundleHref(scope, 'connect') + '#reporting';
  const destination = consoleDestination(href);
  assert.equal(destination.params._splat, 'workspace/bundles/bundle/channels/canary/connect');
  assert.equal(destination.hash, 'reporting');
});

test('bundle breadcrumbs identify the current detail using short labels', () => {
  assert.equal(bundleDetailLabel('content', { path: 'skills/review/SKILL.md' }), 'SKILL.md');
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
  assert.deepEqual(channelSwitchSearch('releases', { fromRevision: 4 }), {});
});
