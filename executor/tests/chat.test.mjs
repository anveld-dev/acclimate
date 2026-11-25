import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { complete, messages } from '../runner/chat.mjs';

test('renders files in SDK order and preserves conversations', () => {
  const files = ['memory', 'skill', 'instruction'].map(kind => ({ kind, path: kind, text: kind }));
  const history = [{ role: 'assistant', content: 'prior' }];
  assert.deepEqual(messages({ files }, { messages: history }), [
    { role: 'system', content: '# instruction\ninstruction\n\n# skill\nskill\n\n# memory\nmemory' }, ...history,
  ]);
  assert.equal(messages({}, 'answer')[1].content, 'answer');
  assert.equal(messages({}, { x: 3 })[1].content, '{"x":3}');
});

test('calls the gateway over its socket and rejects a refusal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-'));
  const socketPath = join(directory, 'gateway');
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      assert.equal(request.url, '/chat/completions');
      const refuse = JSON.parse(body).refuse;
      // Answer late, as a gateway does while it waits for a provider.
      setTimeout(() => response.writeHead(refuse ? 429 : 200).end(refuse ? 'no' : '{"ok":true}'), 50);
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  try {
    assert.equal(await complete('{}', socketPath), '{"ok":true}');
    await assert.rejects(complete('{"refuse":true}', socketPath), /Gateway refused request/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true });
  }
});
