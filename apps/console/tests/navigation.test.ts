import { consoleEnvironment } from './console-fixture';
import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleEnvironment, scopedEnvironment } from '../src/server/selection';
import { bundleHref, parseConsoleLocation } from '../src/navigation';

test('a rendered form keeps its own target even after another tab changes remembered selection', () => {
  const remembered = {
    CONSOLE_PROJECT: 'other-project',
    CONSOLE_BUNDLE: 'other-bundle',
    CONSOLE_CHANNEL: 'canary',
    CONSOLE_SESSION_TOKEN: 'fixture-person',
  };
  const rendered = { projectId: 'work-a', bundleId: 'bundle-a', channel: 'stable' };
  const bound = bundleEnvironment(remembered, rendered);
  assert.equal(bound.CONSOLE_PROJECT, 'work-a');
  assert.equal(bound.CONSOLE_BUNDLE, 'bundle-a');
  assert.equal(bound.CONSOLE_CHANNEL, 'stable');
  assert.equal(bound.CONSOLE_SESSION_TOKEN, 'fixture-person');
  const workspace = scopedEnvironment(remembered, { projectId: 'work-a' });
  assert.equal(workspace.CONSOLE_BUNDLE, undefined);
  assert.equal(workspace.CONSOLE_CHANNEL, undefined);
});

test('missing or malformed form scope never inherits a remembered bundle', () => {
  const remembered = {
    CONSOLE_PROJECT: 'work-a',
    CONSOLE_BUNDLE: 'old',
    CONSOLE_CHANNEL: 'stable',
  };
  for (const scope of [
    undefined,
    {},
    { projectId: 'work-a', bundleId: 'new' },
    { projectId: 'work-a', bundleId: '../bad', channel: 'stable' },
  ]) {
    assert.throws(() => bundleEnvironment(remembered, scope as never));
  }
});

test('published views identify their channel while bundle changes do not pretend suggestions are channel-owned', () => {
  const scope = { projectId: 'acme', bundleId: 'review', channel: 'stable' };
  assert.equal(bundleHref(scope, 'content'), '/w/acme/bundles/review/channels/stable/content');
  const changes = bundleHref(scope, 'changes', {
    draft: 'saved-id',
    path: 'skills/review/SKILL.md',
  });
  const url = new URL(changes, 'https://console.invalid');
  assert.equal(url.pathname, '/w/acme/bundles/review/changes');
  assert.equal(url.searchParams.get('draft'), 'saved-id');
  assert.equal(url.searchParams.get('channel'), 'stable');
  assert.equal(url.searchParams.get('path'), 'skills/review/SKILL.md');
  assert.deepEqual(parseConsoleLocation(url.pathname), {
    projectId: 'acme',
    bundleId: 'review',
    view: 'changes',
  });
  for (const path of [
    '/w/acme/bundles/%2Fsecret/changes',
    '/w/acme/bundles/review/channels/stable/unknown',
    '/w/acme%00/bundles',
  ])
    assert.equal(parseConsoleLocation(path), null);
});

test('legacy Access never sends local operators or hosted viewers into a Members dead end', async () => {
  const { landingState } = await import('../src/server/navigation-core');
  for (const role of ['viewer', 'editor']) {
    const result = await landingState(
      {
        ...consoleEnvironment,
        CONSOLE_SERVICE_TOKEN: 'fixture',
        CONSOLE_SESSION_TOKEN: 'fixture-session',
        CONSOLE_PROJECT: 'acme',
      },
      { legacy: 'access' },
      async (input) =>
        String(input).endsWith('/auth/session')
          ? Response.json({
              userId: '12345678-1234-4234-8234-123456789012',
              issuer: 'https://fixture.invalid',
              subject: 'person',
            })
          : Response.json({
              items: [{ id: 'acme', name: 'Acme', role: role }],
              nextCursor: null,
            }),
    );
    assert.equal(result.href, '/w/acme/bundles');
  }
});
