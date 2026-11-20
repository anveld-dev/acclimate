import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentDiff } from '../src/components/diff-content';
import { mergeHistory, refreshKnownActive } from '../src/lib/improvement-history';

test('direct polling reaches known active rows beyond twenty entries with bounded concurrency', async () => {
  const rows = Array.from({ length: 31 }, (_, i) => ({
    id: String(i),
    status: i === 1 ? 'completed' : 'running',
  }));
  let active = 0,
    peak = 0;
  const seen: string[] = [];
  const result = await refreshKnownActive(
    rows,
    async (id) => {
      active++;
      peak = Math.max(peak, active);
      seen.push(id);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return { id, status: 'completed' };
    },
    () => true,
  );
  assert.equal(result.length, 30);
  assert.ok(seen.includes('30'));
  assert.ok(!seen.includes('1'));
  assert.equal(peak, 4);
  const merged = mergeHistory(rows.slice(0, 20), rows.slice(20), true);
  assert.deepEqual(merged, rows);
  assert.deepEqual(mergeHistory(merged, [{ id: 'new', status: 'requested' }, rows[0]])[0], {
    id: 'new',
    status: 'requested',
  });
});

test('scope changes discard direct polling results and stop claiming later batches', async () => {
  let current = true,
    calls = 0;
  const result = await refreshKnownActive(
    Array.from({ length: 30 }, (_, i) => ({ id: String(i), status: 'running' })),
    async (id) => {
      calls++;
      current = false;
      return { id, status: 'completed' };
    },
    () => current,
  );
  assert.deepEqual(result, []);
  assert.equal(calls, 4);
});

test('final ContentDiff includes kind-only changes and empty added/removed files', () => {
  const html = renderToStaticMarkup(
    createElement(ContentDiff, {
      base: {
        schemaVersion: 1,
        files: [
          { path: 'kind.md', kind: 'instruction', text: '' },
          { path: 'removed.md', kind: 'skill', text: '' },
        ],
      },
      current: {
        schemaVersion: 1,
        files: [
          { path: 'kind.md', kind: 'memory', text: '' },
          { path: 'added.md', kind: 'skill', text: '' },
        ],
      },
    }),
  );
  assert.match(html, /Changed: kind.md/);
  assert.match(html, /Kind: instruction/);
  assert.match(html, /memory/);
  assert.match(html, /Removed: removed.md/);
  assert.match(html, /Added: added.md/);
  assert.match(html, /Download original entry JSON/);
  assert.match(html, /Download current entry JSON/);
});

test('large diff opens the shared merge view with complete downloadable changed lines', () => {
  const text = Array.from({ length: 700 }, (_, i) => `line-${i}`).join('\n');
  const html = renderToStaticMarkup(
    createElement(ContentDiff, {
      base: { schemaVersion: 1, files: [] },
      current: { schemaVersion: 1, files: [{ path: 'large.md', kind: 'instruction', text }] },
    }),
  );
  assert.match(html, /Changed lines in large.md/);
  assert.match(html, /Download all changed lines/);
  assert.match(decodeURIComponent(html), /line-699/);
});
