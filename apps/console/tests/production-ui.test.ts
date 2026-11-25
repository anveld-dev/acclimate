import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router';
import { AccountMenu } from '../src/components/account-menu';
import { WorkspaceCreate } from '../src/components/workspace-create';
import { WorkspaceAdopt } from '../src/components/workspace-adopt';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { SdkSetup } from '../src/components/sdk-setup';
import {
  adoptionIdentityMatches,
  adoptionOutcome,
  reviewWorkspaceAdoption,
} from '../src/lib/workspace-adoption';
import type { AccessState } from '../src/server/access-core';
import type { ConsoleState } from '../src/server/channel';

const identity = {
  userId: 'user-one',
  issuer: 'https://identity.example',
  subject: 'operator-one',
};
const access = (canCreateWorkspace = false): AccessState => ({
  ok: true,
  identity,
  projects: [],
  canCreateWorkspace,
});
function markup(element: ReturnType<typeof createElement>) {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return renderToStaticMarkup(
    createElement(RouterContextProvider, {
      router,
      children: createElement(TooltipProvider, { children: element }),
    }),
  );
}

test('uninvited verified users get email invitation guidance without bootstrap controls', () => {
  const html = markup(createElement(WorkspaceCreate, { access: access() }));
  assert.match(html, /You don&#x27;t have a workspace yet/);
  assert.match(html, /workspace administrator/);
  assert.match(html, /invite your sign-in email/);
  assert.doesNotMatch(html, />Copy ID</);
  assert.doesNotMatch(html, /Create a workspace|Adopt an existing workspace|local|hosted/i);
});

test('anonymous account access offers sign-in and membership administrators do not gain operator controls', () => {
  const anonymous = { ok: false, identity: null, projects: [], message: 'Sign in' } as AccessState;
  const anonymousHtml = markup(createElement(AccountMenu, { access: anonymous }));
  assert.match(anonymousHtml, /href="\/auth\/login"/);
  assert.match(anonymousHtml, /aria-label="Sign in"/);
  assert.equal(anonymousHtml.replace(/<[^>]*>/g, ''), 'Sign in');
  const member = {
    ...access(),
    projects: [{ id: 'owned', name: 'Owned', role: 'admin' }],
  } as AccessState;
  assert.equal(markup(createElement(WorkspaceCreate, { access: member })), '');
  const html = markup(createElement(AccountMenu, { access: member }));
  assert.match(html, /Account/);
  assert.doesNotMatch(html, /Local operator|Sign in/);
});

test('only separate operator capability reveals creation and explicit adoption', () => {
  const html = markup(createElement(WorkspaceCreate, { access: access(true) }));
  assert.match(html, /Create a workspace/);
  assert.match(html, /Adopt an existing workspace/);
  assert.match(html, /Workspace ID to adopt/);
  assert.match(html, /Reason for adoption/);
  assert.match(html, /Review adoption/);
  assert.doesNotMatch(html, />Adopt workspace</);
  assert.equal(markup(createElement(WorkspaceAdopt, { access: access() })), '');
  assert.equal(
    markup(
      createElement(WorkspaceAdopt, {
        access: { ok: false, identity: null, projects: [], message: 'Sign in' },
      }),
    ),
    '',
  );
});

test('adoption review captures exact ID and identity, rejecting malformed or incomplete claims', () => {
  for (const workspaceId of [' workspace', '.', '..'])
    assert.equal(reviewWorkspaceAdoption(workspaceId, 'reason', identity), null);
  assert.equal(reviewWorkspaceAdoption('workspace', '  ', identity), null);
  assert.equal(reviewWorkspaceAdoption('workspace', 'x'.repeat(2001), identity), null);
  const actor = { ...identity };
  const review = reviewWorkspaceAdoption('workspace.Exact', '  Planned cutover  ', actor)!;
  assert.equal(review.workspaceId, 'workspace.Exact');
  assert.equal(review.reason, 'Planned cutover');
  actor.subject = 'other';
  assert.equal(adoptionIdentityMatches(review, identity), true);
  for (const field of ['userId', 'issuer', 'subject'] as const) {
    assert.equal(adoptionIdentityMatches(review, { ...identity, [field]: 'different' }), false);
  }
});

test('historic adoption reports current access without promising a membership regrant', () => {
  assert.equal(
    adoptionOutcome({ alreadyAdopted: false, currentRole: 'admin' }),
    'Workspace adopted. Current role: admin.',
  );
  for (const currentRole of ['viewer', 'editor', null]) {
    const text = adoptionOutcome({ alreadyAdopted: true, currentRole });
    assert.match(text, /original adoption record/);
    assert.match(text, /No access was restored or role changed/);
    assert.match(text, new RegExp(`Current role: ${currentRole ?? 'No membership'}`));
  }
});

test('app setup publishes the configured public API URL and scopes administration to current admin', () => {
  const state = {
    workspaceId: 'workspace',
    bundleId: 'bundle',
    channel: 'stable',
    publicApiUrl: 'https://api.example.com',
    serviceUrl: 'http://private-api:3000',
  } as unknown as Extract<ConsoleState, { status: 'ready' }>;
  for (const role of ['viewer', 'editor', 'operator', undefined]) {
    const html = markup(createElement(SdkSetup, { state, role }));
    assert.match(html, /https:\/\/api.example.com/);
    assert.match(html, /Copy API URL/);
    assert.doesNotMatch(html, /private-api|Manage app credentials/);
  }
  const admin = markup(createElement(SdkSetup, { state, role: 'admin' }));
  assert.match(admin, /href="\/w\/workspace\/connections\?bundleId=bundle&amp;channel=stable"/);
  assert.match(admin, /href="\/w\/workspace\/delivery"/);
  assert.match(admin, /Connect your agent/);
  assert.doesNotMatch(admin, /Compare a change|\/bundle\/changes/);
});
