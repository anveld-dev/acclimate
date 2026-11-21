import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { sourceLines } from '../src/lib/syntax-source';
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
