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
import { TooltipProvider } from '../src/components/ui/tooltip';
import { SdkSetup } from '../src/components/sdk-setup';
import { basicDeliveryRecipes } from '../src/components/sdk-setup-recipes';
import type { ConsoleState } from '../src/server/channel';

// Setup only reads this selection; delivery data stays in the server-owned ready state.
const state = {
  workspaceId: 'project-one',
  bundleId: 'bundle-two',
  channel: 'preview',
  publicApiUrl: 'https://api.example',
} as Extract<ConsoleState, { status: 'ready' }>;

function setup(role?: string) {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return renderToStaticMarkup(
    createElement(RouterContextProvider, {
      router,
      children: createElement(TooltipProvider, {
        children: createElement(SdkSetup, { state, role }),
      }),
    }),
  );
}

test('downloaded delivery recipe targets the selected bundle and channel', () => {
  const html = setup('viewer');
  const download = html.match(
    /href="data:text\/plain;charset=utf-8,([^"]+)" download="delivery-check\.mjs"/,
  );
  assert(download);
  assert.equal(
    decodeURIComponent(download[1].replaceAll('&#x27;', "'").replaceAll('&#39;', "'")),
    basicDeliveryRecipes({
      workspaceId: state.workspaceId,
      bundleId: state.bundleId,
      channel: state.channel,
    }).typescript,
  );
});
