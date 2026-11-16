import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  SuggestionComposer,
  type SuggestionComposerProps,
} from '../src/components/suggestion-composer';

const props: SuggestionComposerProps = {
  files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Keep operation identity.' }],
  channel: 'stable',
  revision: '7',
  parentVersionId: 'parent-id',
  parentDigest: 'parent-digest',
  hypothesis: 'Preserve the receipt.',
  evidence: '',
  paths: ['AGENTS.md'],
  consent: true,
  canEdit: true,
  busy: false,
  pending: false,
  blocked: false,
  onHypothesisChange() {},
  onEvidenceChange() {},
  onPathsChange() {},
  onConsentChange() {},
  onSubmit() {},
};
const render = (changes: Partial<SuggestionComposerProps> = {}) =>
  renderToStaticMarkup(createElement(SuggestionComposer, { ...props, ...changes }));
const request = (html: string) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(
    (m) => m[2] === 'Request suggestion',
  )![1];

test('the composer keeps every submission gate while evidence remains optional', () => {
  assert.doesNotMatch(request(render()), /\sdisabled(?:=|\s|$)/);
  for (const change of [
    { hypothesis: ' \n ' },
    { paths: [] },
    { consent: false },
    { canEdit: false },
    { busy: true },
    { pending: true },
    { blocked: true },
  ]) {
    assert.match(request(render(change)), /\sdisabled(?:=|\s|$)/, JSON.stringify(change));
  }
  const pending = render({ pending: true, hypothesis: 'Later browser edit' });
  assert.match(pending, /Later browser edit/);
  const input = pending.match(/<textarea\b([^>]*)id="proposal-hypothesis"([^>]*)>/)!;
  assert.doesNotMatch(
    input[1] + input[2],
    /\sdisabled(?:=|\s|$)/,
    'uncertainty blocks submission while preserving editable later text',
  );
  assert.match(
    render({ blocked: true, blockedReason: 'Recovery storage is unavailable.' }),
    /Recovery storage is unavailable/,
  );
});

test('the actual sharing boundary and source identities survive the compact presentation', () => {
  const html = render({ hypothesis: '<script>unsafe</script>' });
  for (const text of [
    'whole parent bundle, including reusable',
    'Editable paths restrict changes, not reading.',
    'Private session',
    'parent-id',
    'parent-digest',
    'Authorize bundle disclosure',
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(render(), /Search editable paths/);
  const files = Array.from({ length: 9 }, (_, i) => ({
    path: `memory/context-${i}.md`,
    kind: 'memory' as const,
    text: '',
  }));
  assert.match(render({ files }), /Search editable paths/);
});
