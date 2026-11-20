import assert from 'node:assert/strict';
import test from 'node:test';
import { EvaluationHandoffDownload } from '../src/components/evaluation-handoff-download';
import { appDescriptor } from './fixtures/app-evaluator';
import { evaluationHandoff } from '../src/lib/evaluation-config';

test('request download retains exactly the public handoff and releases its blob URL', async (t) => {
  const handoff = evaluationHandoff(
    'https://api.example.test',
    'project',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    appDescriptor,
  );
  let saved: Blob | undefined;
  let clicked = false;
  let removed = false;
  let revoked = false;
  const link = {
    href: '',
    download: '',
    click() {
      clicked = true;
    },
    remove() {
      removed = true;
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (name: string) => {
        assert.equal(name, 'a');
        return link;
      },
      body: { append: (node: unknown) => assert.equal(node, link) },
    },
  });
  t.mock.method(URL, 'createObjectURL', (value: Blob) => {
    saved = value;
    return 'blob:public-request';
  });
  t.mock.method(URL, 'revokeObjectURL', (value: string) => {
    assert.equal(value, 'blob:public-request');
    revoked = true;
  });
  try {
    const button = EvaluationHandoffDownload({ handoff });
    button.props.onClick();
    assert.equal(clicked, true);
    assert.equal(removed, true);
    assert.equal(link.download, 'handoff.json');
    assert.equal(link.href, 'blob:public-request');
    assert.equal(saved?.type, 'application/json');
    assert.equal(await saved?.text(), handoff + '\n');
    assert.doesNotMatch(await saved!.text(), /evaluatorToken|journalRoot|consoleToken|readToken/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(revoked, true);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
