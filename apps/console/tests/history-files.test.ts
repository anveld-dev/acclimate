import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BundlePayload, VersionMetadata } from '@acclimate/sdk';
import { HistoryFiles, type HistoryVersionState } from '../src/components/history-files';
import { TooltipProvider } from '../src/components/ui/tooltip';

const version = {
  id: 'candidate',
  digest: 'sha256:verified',
  parentVersionId: 'base',
} as VersionMetadata;
const base: BundlePayload = {
  schemaVersion: 1,
  files: [
    { path: 'AGENTS.md', kind: 'instruction', text: 'Old instruction.' },
    { path: 'memory/removed.md', kind: 'memory', text: 'Remove this entry.' },
  ],
};
const payload: BundlePayload = {
  schemaVersion: 1,
  files: [
    { path: 'AGENTS.md', kind: 'instruction', text: 'New instruction.' },
    { path: 'skills/triage/SKILL.md', kind: 'skill', text: 'Read the receipt.' },
  ],
};
function html(value: HistoryVersionState, requestedPath?: string) {
  return renderToStaticMarkup(
    createElement(TooltipProvider, {
      children: createElement(HistoryFiles, {
        value,
        requestedPath,
        scopeKey: 'private-fixture',
        onSelectPath() {},
      }),
    }),
  );
}
const ready: HistoryVersionState = {
  status: 'ready',
  id: 'candidate',
  version,
  payload,
  base: { version: { ...version, id: 'base', parentVersionId: null }, payload: base },
};

test('files use the verified creation base and keep removed paths in the real tree', () => {
  const text = html(ready, 'memory/removed.md');
  assert.match(text, /creation base/);
  assert.match(text, /Each evaluation lists its own comparison parent/);
  assert.match(text, /Removed: memory\/removed.md/);
  assert.match(text, /Remove this entry/);
  assert.match(text, /3 files/);
  assert.doesNotMatch(text, /Changed: AGENTS.md/);
  assert.doesNotMatch(text, /Changed artifact map/);
});

test('a missing requested path stays explicit rather than silently selecting another file', () => {
  const text = html(ready, 'memory/not-here.md');
  assert.match(text, /requested path is not in this file view/);
  assert.match(text, /Show the first file/);
  assert.doesNotMatch(text, /Changed lines in AGENTS.md/);
});

test('a missing requested path can be cleared when the version has no file changes', () => {
  const text = html({ ...ready, payload: base }, 'missing.md');
  assert.match(text, /No file changes/);
  assert.match(text, /requested path is not in this file view/);
  assert.match(text, /Clear file selection/);
});

test('root versions show their saved content without a fabricated diff base', () => {
  const text = html({
    status: 'ready',
    id: 'root',
    version: { ...version, id: 'root', parentVersionId: null },
    payload,
  });
  assert.match(text, /no creation base/);
  assert.match(text, /Saved content of AGENTS.md/);
  assert.match(text, /New instruction/);
  assert.doesNotMatch(text, /Changed lines|creation base <code>/);
});

test('an inaccessible creation base leaves verified content readable and labels automatic retry', () => {
  const text = html({
    status: 'ready',
    id: 'candidate',
    version,
    payload,
    baseError: 'Creation base unavailable; retrying automatically.',
  });
  assert.match(text, /Creation base unavailable; retrying automatically/);
  assert.match(text, /Saved content of AGENTS.md/);
  assert.doesNotMatch(text, /Changed lines/);
});

test('loading and unavailable version states do not expose stale file bytes', () => {
  assert.match(html({ status: 'loading', id: 'new-version' }), /Reading verified files/);
  const unavailable = html({
    status: 'unavailable',
    id: 'private',
    message: 'Version unavailable; retrying automatically.',
  });
  assert.match(unavailable, /role="alert"/);
  assert.doesNotMatch(unavailable, /New instruction|Old instruction|file-tree/);
});
