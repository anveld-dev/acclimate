import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BundlePayload } from '@acclimate/sdk';
import { ContentDiff } from '../src/components/diff-content';

const payload = (text: string): BundlePayload => ({
  schemaVersion: 1,
  files: [{ path: 'AGENTS.md', kind: 'instruction', text }],
});
const render = (base: BundlePayload, current: BundlePayload, variant?: 'workspace') =>
  renderToStaticMarkup(createElement(ContentDiff, { base, current, variant }));

for (const lines of [500, 501]) {
  test(`whole-draft preview distinguishes ${lines} records and retains the full download`, () => {
    const text =
      'shared\n' + Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n';
    const html = render(payload('shared\n'), payload(text), 'workspace');
    assert.match(html, /Changed lines in AGENTS.md/);
    assert.match(html, new RegExp(lines + ' added lines'));
    assert.doesNotMatch(html, /Preview limited/);
    if (lines > 500) {
      const href = html.match(/href="(data:text\/plain[^\"]+)"/s)![1];
      assert.equal(decodeURIComponent(href.split(',')[1]).split('\n').length, lines);
    }
  });
}

test('JSON entry downloads preserve exact Unicode and newline content in both variants', () => {
  for (const variant of [undefined, 'workspace'] as const) {
    const before = payload('café\r\nreceipt\n');
    const after = payload('確認\r\nreceipt\n\n');
    const html = render(before, after, variant);
    const hrefs = [...html.matchAll(/href="(data:application\/json[^\"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      hrefs.map((href) => JSON.parse(decodeURIComponent(href.split(',')[1]))),
      [before.files[0], after.files[0]],
    );
    assert.match(html, /Download original entry JSON/);
    assert.match(html, /Download current entry JSON/);
    assert.equal(html.includes('source-review-container'), variant === 'workspace');
  }
});

test('separated edits exclude unchanged lines from changed-line totals', () => {
  const html = render(payload('old one\ncontext\nold two'), payload('new one\ncontext\nnew two'));
  assert.match(html, /2 added lines/);
  assert.match(html, /2 removed lines/);
});
