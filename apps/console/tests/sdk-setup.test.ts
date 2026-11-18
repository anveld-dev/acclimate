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
import type { ConsoleState } from '../src/server/channel';

// Setup only reads this selection; delivery data stays in the server-owned ready state.
const state = {
  projectId: 'project-one',
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

test('app setup leads with language choice and a delivery check, keeping optional topics expandable', () => {
  const html = setup('viewer');
  assert.match(html, />App setup</);
  assert(html.indexOf('Recipe language') < html.indexOf('1. Install the SDK'));
  assert(html.indexOf('1. Install the SDK') < html.indexOf('2. Configure access'));
  assert(html.indexOf('2. Configure access') < html.indexOf('3. Run the delivery check'));
  assert.match(html, /aria-label="TypeScript delivery recipe"/);
  assert.doesNotMatch(html, /aria-label="Python delivery recipe"/);
  assert.match(html, /This check makes no model calls/);
  assert.match(html, /resolved version stays pinned/);
  assert.match(html, /Give each identity its own scope; never use a/);
  assert.match(
    html,
    /<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?<span[^>]*>Install from this checkout<\/span><\/button>/,
  );
  assert.match(
    html,
    /<div[^>]*id="reporting"[\s\S]*?<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?<span[^>]*>Optional delivery reports<\/span><\/button>/,
  );
  assert.match(
    html,
    /<button[^>]*aria-expanded="false"[^>]*>[\s\S]*?<span[^>]*>Preparing job-local files<\/span><\/button>/,
  );
  assert.match(html, /Optional reporting failures do not block delivery or application start/);
  assert.match(html, /aria-label="Copy recipe"/);
  assert.match(html, /<pre[^>]*select-text[^>]*><code>/);
});

test('only administrators get actual scoped credential management links', () => {
  for (const role of ['admin']) {
    const html = setup(role);
    assert.match(
      html,
      /href="\/w\/project-one\/connections\?bundleId=bundle-two&amp;channel=preview"[^>]*>Manage app credentials</,
    );
    assert.doesNotMatch(html, /Ask a workspace admin for a content-read credential/);
  }
  for (const role of ['viewer', 'editor', 'operator', undefined]) {
    const html = setup(role);
    assert.match(
      html,
      /Ask a workspace admin for a content-read credential for this bundle and channel/,
    );
    assert.doesNotMatch(html, /Manage app credentials/);
  }
});

test('package installation is available before the checkout build disclosure', () => {
  const html = setup('viewer');
  const installSection = html.slice(
    html.indexOf('1. Install the SDK'),
    html.indexOf('id="sdk-local-install"'),
  );
  assert.match(
    installSection,
    /npm install \/absolute\/path\/to\/release\/acclimate-sdk-[\d.]+\.tgz/,
  );
  assert.match(installSection, /aria-label="Copy install command"/);
  assert.match(installSection, /replace the absolute path with your actual package file/);
  assert.doesNotMatch(installSection, /npm install @acclimate\/sdk/);
  assert.match(html, /npm run build:packages/);
  assert.match(html, /npm pack --workspace @acclimate\/sdk/);
});

test('required settings and expected check output precede their independent disclosures', () => {
  const html = setup('viewer');
  const summary = html.slice(
    html.indexOf('aria-label="Required environment variables"'),
    html.indexOf('Environment variables and private directories'),
  );
  for (const name of ['ACCLIMATE_URL', 'ACCLIMATE_TOKEN', 'ACCLIMATE_SCOPE']) {
    assert.match(summary, new RegExp(`<dt[^>]*>${name}</dt>`));
  }
  assert.match(summary, /Stable app identity for the cache; never a token/);
  assert.doesNotMatch(summary, /<dt[^>]*>ACCLIMATE_(CACHE|JOB_DIR)<\/dt>/);
  const directoryDetails = html.slice(
    html.indexOf('Environment variables and private directories'),
    html.indexOf('3. Run the delivery check'),
  );
  assert.doesNotMatch(directoryDetails, /<dt/);
  assert.match(directoryDetails, /https:\/\/api\.example/);
  assert.match(directoryDetails, /aria-label="Copy API URL"/);
  assert.match(directoryDetails, /Give each identity its own scope; never use a token/);
  assert.match(directoryDetails, /ACCLIMATE_CACHE/);
  assert.match(directoryDetails, /ACCLIMATE_JOB_DIR/);
  assert.match(
    directoryDetails,
    /Keep each job directory separate from the cache and empty before preparation/,
  );
  assert.match(
    html,
    /owned by the current user and private \(mode 0700\), with no symlink ancestors/,
  );
  const runInstructions = html.slice(
    html.indexOf('3. Run the delivery check'),
    html.indexOf('View the TypeScript recipe'),
  );
  assert.match(runInstructions, /node delivery-check\.mjs/);
  assert.doesNotMatch(runInstructions, /npx tsx/);
  assert.match(runInstructions, /resolved version stays pinned for this job/);
  assert.match(runInstructions, /digest and checked file count, then cleans up its prepared files/);
});

test('delivery leads into explicit agent context and evaluator access before a comparison', () => {
  const html = setup('viewer');
  assert.match(html, /4\. Connect your agent, then compare a change/);
  assert.match(html, /aria-label="Application runtime"/);
  assert.match(html, /aria-label="TypeScript agent connection recipe"/);
  assert.match(html, /Connect your existing agent loop/);
  assert.match(html, /Delivery credentials cannot read unpublished candidates/);
  assert.match(html, /policy pass does not release a version/);
  assert.match(html, /\/w\/project-one\/delivery/);
  assert.match(html, /\/w\/project-one\/bundles\/bundle-two\/changes\?channel=preview/);
  assert.match(html, /SHA256SUMS/);
  assert.match(html, /ACCLIMATE_EVALUATOR_CASES/);
  assert.doesNotMatch(html, /trial\.mjs|demo\.mjs|model-free fixture|fake harness/);
});
