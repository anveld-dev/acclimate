import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceCreate } from '../src/components/workspace-create';
import { AccountMenu } from '../src/components/account-menu';
import type { AccessState } from '../src/server/access-core';

const person = {
  ok: true,
  identity: { userId: 'verified-person', issuer: 'https://identity.example', subject: 'person' },
  projects: [{ id: 'p', name: 'Project', role: 'admin' }],
  canCreateWorkspace: false,
} satisfies AccessState;

test('an existing workspace administrator is not offered deployment-operator creation', () => {
  const ordinary = renderToStaticMarkup(createElement(WorkspaceCreate, { access: person }));
  assert.equal(ordinary, '');
  const operator = renderToStaticMarkup(
    createElement(WorkspaceCreate, { access: { ...person, canCreateWorkspace: true } }),
  );
  assert.match(operator, /Create workspace/);
  assert.match(operator, /Workspace ID/);
});

test('a signed-in person without membership gets email-invitation guidance', () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceCreate, { access: { ...person, projects: [] } }),
  );
  assert.match(html, /Ask a workspace administrator/);
  assert.match(html, /invite your sign-in email/);
  assert.doesNotMatch(html, /Create workspace/);
});

test('verified account actions and anonymous sign-in stay separate', () => {
  const hosted = renderToStaticMarkup(createElement(AccountMenu, { access: person }));
  assert.match(hosted, />Account</);
  assert.doesNotMatch(hosted, /Local operator info/);
  const signedOut = renderToStaticMarkup(
    createElement(AccountMenu, {
      access: { ok: false, identity: null, projects: [], message: 'Sign in' },
    }),
  );
  assert.match(signedOut, /href="\/auth\/login"/);
});
