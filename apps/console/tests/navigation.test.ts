import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleEnvironment, scopedEnvironment } from '../src/server/selection';
import { bundleHref, parseConsoleLocation } from '../src/navigation';

test('a rendered form keeps its own target even after another tab changes remembered selection', () => {
  const remembered = {
    CONSOLE_WORKSPACE: 'other-project',
    CONSOLE_BUNDLE: 'other-bundle',
    CONSOLE_CHANNEL: 'canary',
    CONSOLE_SESSION_TOKEN: 'fixture-person',
  };
  const rendered = { workspaceId: 'work-a', bundleId: 'bundle-a', channel: 'stable' };
  const bound = bundleEnvironment(remembered, rendered);
  assert.equal(bound.CONSOLE_WORKSPACE, 'work-a');
  assert.equal(bound.CONSOLE_BUNDLE, 'bundle-a');
  assert.equal(bound.CONSOLE_CHANNEL, 'stable');
  assert.equal(bound.CONSOLE_SESSION_TOKEN, 'fixture-person');
  const workspace = scopedEnvironment(remembered, { workspaceId: 'work-a' });
  assert.equal(workspace.CONSOLE_BUNDLE, undefined);
  assert.equal(workspace.CONSOLE_CHANNEL, undefined);
});

test('missing or malformed form scope never inherits a remembered bundle', () => {
  const remembered = {
    CONSOLE_WORKSPACE: 'work-a',
    CONSOLE_BUNDLE: 'old',
    CONSOLE_CHANNEL: 'stable',
  };
  for (const scope of [
    undefined,
    {},
    { workspaceId: 'work-a', bundleId: 'new' },
    { workspaceId: 'work-a', bundleId: '../bad', channel: 'stable' },
  ]) {
    assert.throws(() => bundleEnvironment(remembered, scope as never));
  }
});

test('published views identify their channel and removed routes do not parse', () => {
  const scope = { workspaceId: 'acme', bundleId: 'review', channel: 'stable' };
  assert.equal(bundleHref(scope, 'content'), '/w/acme/bundles/review/channels/stable/content');
  for (const path of [
    '/w/acme/bundles/review/changes',
    '/w/acme/bundles/%2Fsecret/changes',
    '/w/acme/bundles/review/channels/stable/unknown',
    '/w/acme%00/bundles',
  ])
    assert.equal(parseConsoleLocation(path), null);
});

test('learning is bundle scoped and round-trips without the selected channel', () => {
  const scope = { workspaceId: 'acme', bundleId: 'b', channel: 'canary' };
  const href = bundleHref(scope, 'learning');
  assert.equal(href, '/w/acme/bundles/b/learning');
  assert.deepEqual(parseConsoleLocation(href), {
    workspaceId: 'acme',
    bundleId: 'b',
    view: 'learning',
  });
});
