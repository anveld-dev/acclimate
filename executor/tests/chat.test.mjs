import assert from 'node:assert/strict';
import test from 'node:test';
import { messages } from '../runner/chat.mjs';

test('renders files in SDK order and preserves conversations', () => {
  const files = ['memory', 'skill', 'instruction'].map(kind => ({ kind, path: kind, text: kind }));
  const history = [{ role: 'assistant', content: 'prior' }];
  assert.deepEqual(messages({ files }, { messages: history }), [
    { role: 'system', content: '# instruction\ninstruction\n\n# skill\nskill\n\n# memory\nmemory' }, ...history,
  ]);
  assert.equal(messages({}, 'answer')[1].content, 'answer');
  assert.equal(messages({}, { x: 3 })[1].content, '{"x":3}');
});
