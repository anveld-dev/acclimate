import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorState } from '@codemirror/state';
import { history, undo, redo, isolateHistory } from '@codemirror/commands';
import {
  applySourceChanges,
  editorText,
  sourceLines,
  sourceRange,
  reconcileEditorText,
} from '../src/lib/syntax-source';
import { sourceDocument } from '../src/lib/editor-source';
import { highlightCode, normalizeSyntaxLanguage, syntaxLanguage } from '../src/lib/highlighter';
import { SyntaxCode } from '../src/components/syntax-code';

test('filename inference uses the real source extension and unsupported input stays plain', () => {
  assert.equal(syntaxLanguage('skills/review/SKILL.md'), 'markdown');
  assert.equal(syntaxLanguage('policy.json'), 'json');
  assert.equal(syntaxLanguage('src/retry.rs'), 'rust');
  assert.equal(syntaxLanguage('.env.production'), 'dotenv');
  assert.equal(syntaxLanguage('Dockerfile.release'), 'dockerfile');
  assert.equal(syntaxLanguage('README', 'python'), 'python');
  for (const language of ['constructor', 'toString', '__proto__', 'unknown'])
    assert.equal(normalizeSyntaxLanguage(language), null);
  assert.equal(syntaxLanguage('file.unsupported'), null);
});

test('line presentation retains mixed endings, empty lines and the final newline exactly', () => {
  const source = '# Policy\r\n\r\nKeep this.\nLast\r';
  assert.equal(
    sourceLines(source)
      .map((line) => line.text + line.ending)
      .join(''),
    source,
  );
  assert.deepEqual(sourceLines(''), [{ text: '', ending: '' }]);
  assert.equal(editorText(source), '# Policy\n\nKeep this.\nLast\n');
});

test('logical edits preserve untouched mixed CRLF and LF bytes', () => {
  const source = 'first\r\nsecond\nthird\r\n';
  const updated = applySourceChanges(source, [{ from: 6, to: 12, insert: 'changed' }]);
  assert.equal(updated, 'first\r\nchanged\nthird\r\n');
  assert.equal(
    applySourceChanges(source, [{ from: 0, to: 0, insert: 'new\n' }]),
    'new\r\n' + source,
  );
  assert.equal(applySourceChanges('a\r\nb', [{ from: 1, to: 2, insert: '' }]), 'ab');
  assert.equal(applySourceChanges('a\rb', [{ from: 2, to: 3, insert: 'B' }]), 'a\rB');
});

test('multiple source edits use the same original UTF-16 offsets and reject invalid ranges', () => {
  const source = '🦀a\r\nbc\n';
  assert.equal(
    applySourceChanges(source, [
      { from: 2, to: 3, insert: 'A' },
      { from: 4, to: 6, insert: 'BC' },
    ]),
    '🦀A\r\nBC\n',
  );
  assert.throws(() => applySourceChanges('text', [{ from: 3, to: 2, insert: '' }]), /Invalid/);
  assert.throws(() => applySourceChanges('text', [{ from: 0, to: 5, insert: '' }]), /Invalid/);
});

test('CodeMirror undo and redo restore exact raw mixed line endings', () => {
  const original = 'one\r\ntwo\nthree\r\n';
  const raw = sourceDocument(original);
  let state = EditorState.create({
    doc: editorText(original),
    extensions: [raw.extension, history()],
  });
  const target = {
    get state() {
      return state;
    },
    dispatch(transaction: { state: EditorState }) {
      state = transaction.state;
    },
  };
  state = state.update({
    changes: { from: 3, to: 4, insert: '' },
    annotations: isolateHistory.of('full'),
  }).state;
  assert.equal(raw.read(state), 'onetwo\nthree\r\n');
  assert.equal(undo(target), true);
  assert.equal(raw.read(state), original);
  assert.equal(redo(target), true);
  assert.equal(raw.read(state), 'onetwo\nthree\r\n');
});

test('grouped typing can be undone to the byte-exact source rather than an intermediate edit', () => {
  const original = 'one\r\ntwo\n';
  const raw = sourceDocument(original);
  let state = EditorState.create({
    doc: editorText(original),
    extensions: [raw.extension, history()],
  });
  const target = {
    get state() {
      return state;
    },
    dispatch(transaction: { state: EditorState }) {
      state = transaction.state;
    },
  };
  state = state.update({ changes: { from: 0, insert: 'A' }, userEvent: 'input.type' }).state;
  state = state.update({ changes: { from: 1, insert: 'B' }, userEvent: 'input.type' }).state;
  assert.equal(raw.read(state), 'AB' + original);
  assert.equal(undo(target), true);
  assert.equal(raw.read(state), original);
  assert.equal(redo(target), true);
  assert.equal(raw.read(state), 'AB' + original);
});

test('read-only SSR renders escaped exact source, with accessible labels preserved', () => {
  const code = '<script>alert("x")</script>\r\n\n';
  const html = renderToStaticMarkup(
    createElement(SyntaxCode, { code, language: 'html', 'aria-label': 'Source' }),
  );
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /aria-label="Source"/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(html.includes('\r\n\n'), 'Line endings and empty final lines must survive SSR');
});

test('numbered source preserves source bytes and numbers the final empty editor line', () => {
  const code = 'alpha\r\n\nbeta\n';
  const html = renderToStaticMarkup(createElement(SyntaxCode, { code, lineNumbers: true }));
  const inner = html.match(/<code[^>]*>([\s\S]*)<\/code>/)![1];
  assert.deepEqual(
    [...inner.matchAll(/data-line="(\d+)"/g)].map((match) => match[1]),
    ['1', '2', '3', '4'],
  );
  assert.equal(
    inner.replace(
      /<span class="source-line-marker" aria-hidden="true" data-line="\d+"><\/span>/g,
      '',
    ),
    code,
  );
});

test('Shiki produces real token styles for the languages used by setup and files', async () => {
  for (const [language, code] of [
    ['typescript', 'const greeting: string = "hello";'],
    ['python', 'def review():\n    return "safe"'],
    ['json', '{"retry": false}'],
    ['bash', 'export REVIEW_MODE="safe"'],
    ['markdown', '# Review\n\n**Keep** the original request.'],
  ]) {
    const tokens = await highlightCode(code, language);
    assert.ok(tokens?.length);
    const html = renderToStaticMarkup(createElement('div', null, tokens));
    assert.match(html, /--shiki-light/);
    assert.match(html, /syntax-token/);
  }
  assert.equal(await highlightCode('plain', 'unknown'), null);
});

test('highlighted line rendering preserves CRLF, blank lines and escaped source exactly', async () => {
  const code = '# Header\r\n\r\n<script>not executable</script>\r\n';
  const tokens = await highlightCode(code, 'markdown');
  const lines = sourceLines(code);
  assert.equal(tokens?.length, lines.length);
  for (const [index, line] of lines.entries()) {
    const highlighted: string = renderToStaticMarkup(
      createElement('span', null, tokens![index]),
    ).replace(/<[^>]*>/g, '');
    const plain: string = renderToStaticMarkup(createElement('span', null, line.text)).replace(
      /<[^>]*>/g,
      '',
    );
    assert.equal(highlighted, plain);
  }
});

test('native fallback edits and selected copying preserve untouched raw source', () => {
  const source = '🦀a\r\nbc\n';
  assert.equal(sourceRange(source, 3, 6), '\r\nbc');
  assert.equal(reconcileEditorText(source, '🦀A\nbc\n'), '🦀A\r\nbc\n');
  assert.equal(reconcileEditorText(source, editorText(source)), source);
});

test('grouped newline insertion history restores original and edited ending metadata', () => {
  const original = 'a\r\nb\n';
  const raw = sourceDocument(original);
  let state = EditorState.create({
    doc: editorText(original),
    extensions: [raw.extension, history()],
  });
  const target = {
    get state() {
      return state;
    },
    dispatch(transaction: { state: EditorState }) {
      state = transaction.state;
    },
  };
  state = state.update({ changes: { from: 1, insert: '\n' }, userEvent: 'input.type' }).state;
  state = state.update({ changes: { from: 2, insert: '\n' }, userEvent: 'input.type' }).state;
  assert.equal(raw.read(state), 'a\r\n\r\n\r\nb\n');
  assert.equal(undo(target), true);
  assert.equal(raw.read(state), original);
  assert.equal(redo(target), true);
  assert.equal(raw.read(state), 'a\r\n\r\n\r\nb\n');
});
