import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { defineLoop, exact, openai, OpenAIHttpError } from '../../src/learning/index.js';
import { loadLoop } from '../../src/learning/define.js';
import type { VerifiedVersion } from '../../src/types.js';

const expectedPrompt = '# instructions/main.md\nReturn JSON.\nUse the schema.\n\n'
  + '# skills/lookup/SKILL.md\nLook up values.\n\n# skills/lookup/schema.json\n{}\n\n\n'
  + '# memory/café.md\nRemember the résumé.';
const version: VerifiedVersion = {
  version: { id: 'v', bundleId: 'b', parentVersionId: null, digest: 'fixture', createdAt: 'now' },
  resolvedAt: 0,
  stale: false,
  payload: JSON.parse(await readFile(new URL('../fixtures/openai-bundle.json', import.meta.url), 'utf8')),
};
const completion = {
  choices: [{ message: { content: '{"action":"refund"}' }, finish_reason: 'stop' }],
  usage: { total_tokens: 12 },
};

async function endpoint(replies: { status: number; body: object; retryAfter?: string }[]) {
  const requests: { method?: string; url?: string; authorization?: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const reply = replies[Math.min(requests.length, replies.length - 1)];
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (reply.retryAfter !== undefined) res.setHeader('Retry-After', reply.retryAfter);
    res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  return { baseURL: `http://127.0.0.1:${address.port}/v1/`, requests, close: () => { server.close(); } };
}
const rollout = (input: unknown) => ({
  version, input, caseId: 'case', rollout: 0, signal: new AbortController().signal,
});

test('OpenAI uses the shared render vector and parses assistant text', async t => {
  const api = await endpoint([{ status: 200, body: completion }]);
  t.after(api.close);
  const agent = openai({ model: 'fixture', baseURL: api.baseURL, apiKey: '', parse: async text => JSON.parse(text) as { action: string } });
  for (let run = 0; run < 2; run++) {
    assert.deepEqual(await agent.execute(rollout({ task: 'refund' })), {
      output: { action: 'refund' },
      trace: JSON.stringify({ text: '{"action":"refund"}', finish_reason: 'stop', usage: { total_tokens: 12 } }),
    });
  }
  assert.deepEqual(api.requests, Array.from({ length: 2 }, () => ({
    method: 'POST', url: '/v1/chat/completions', authorization: undefined,
    body: {
      model: 'fixture', messages: [{ role: 'system', content: expectedPrompt }, { role: 'user', content: '{"task":"refund"}' }],
    },
  })));
  const loop = await loadLoop(defineLoop({
    agent, bundle: 'support', channel: 'stable', grade: exact('action'),
    cases: [{ caseId: 'case-0', input: 'test', expected: 'refund' }, { caseId: 'case-2', input: 'test', expected: 'refund' }],
  }), '.');
  assert.equal(loop.setting.policyModel, 'fixture');
});

test('OpenAI applies optional settings and retries 429 and 5xx', async t => {
  const api = await endpoint([
    { status: 429, retryAfter: '0', body: {} },
    { status: 503, retryAfter: new Date(0).toUTCString(), body: {} },
    { status: 200, body: completion },
  ]);
  t.after(api.close);
  const { OPENAI_BASE_URL: previousURL, OPENAI_API_KEY: previousKey } = process.env;
  process.env.OPENAI_BASE_URL = api.baseURL;
  process.env.OPENAI_API_KEY = 'fake-key';
  t.after(() => {
    if (previousURL === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousURL;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });
  const agent = openai({ model: 'fixture', effort: 'high', render: async v => v.version.id });
  assert.equal((await agent.execute(rollout('hello'))).output, '{"action":"refund"}');
  assert.equal(api.requests.length, 3);
  for (const request of api.requests) {
    assert.equal(request.authorization, 'Bearer fake-key');
    assert.deepEqual(request.body, {
      model: 'fixture', reasoning_effort: 'high',
      messages: [{ role: 'system', content: 'v' }, { role: 'user', content: 'hello' }],
    });
  }
});

test('OpenAI throws a redacted typed error after bounded retries', async t => {
  const api = await endpoint([{ status: 503, retryAfter: '0', body: { error: 'Invalid fake-key' } }]);
  t.after(api.close);
  const agent = openai({ model: 'fixture', baseURL: api.baseURL, apiKey: 'fake-key' });
  await assert.rejects(async () => agent.execute(rollout('hello')), (error: unknown) => {
    assert(error instanceof OpenAIHttpError);
    assert.equal(error.status, 503);
    assert.equal(error.trace, '{"error":{"error":"Invalid [redacted]"}}');
    assert.doesNotMatch(error.message, /fake-key/);
    return true;
  });
  assert.equal(api.requests.length, 3);
});

test('OpenAI stops when Retry-After exceeds the retry budget', async t => {
  const api = await endpoint([{ status: 429, retryAfter: '60', body: {} }]);
  t.after(api.close);
  const agent = openai({ model: 'fixture', baseURL: api.baseURL, apiKey: '' });
  await assert.rejects(async () => agent.execute(rollout('hello')), { status: 429 });
  assert.equal(api.requests.length, 1);
});
