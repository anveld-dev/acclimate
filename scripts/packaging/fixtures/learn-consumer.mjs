import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const bundleId = '11111111-1111-4111-8111-111111111111';
const principalId = 'machine:installed';
const prefix = '/v1/workspaces/fixture';
const learning = `${prefix}/bundles/${bundleId}/learning`;
const roundId = 'first';
const round = {
  id: roundId, number: 1, state: 'completed', endedAt: 'now', decision: 'kept',
  reason: null, incumbentScore: 1, heldOutScore: 1, heldOutError: null,
  selection: null, candidates: [],
};
let enrolled;
let uploaded;
let failure;
const server = createServer((req, res) => {
  void (async () => {
    assert.equal(req.headers.authorization, 'Bearer fixture');
    const path = req.url.split('?')[0];
    const respond = (body, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const read = async () => {
      let text = '';
      for await (const chunk of req) text += chunk;
      return JSON.parse(text);
    };
    if (path === prefix + '/principal')
      return respond({ principalId, kind: 'machine', rights: ['evaluate', 'promote'] });
    if (path === prefix + '/bundles')
      return respond({ items: [{ id: bundleId, name: 'support-agent' }], nextCursor: null });
    if (path === learning && req.method === 'PUT') {
      enrolled = await read();
      assert.equal(enrolled.appPrincipalId, principalId);
      assert.equal(enrolled.heldOut.cases, 1);
      assert.match(enrolled.heldOut.digest, /^sha256:[0-9a-f]{64}$/);
      return respond({ ...enrolled, status: 'running', nextRound: 1, activeRound: null, rounds: [] });
    }
    if (path === learning)
      return respond({ error: { code: 'not_found', requestId: 'missing', message: 'Not enrolled' } }, 404);
    if (path === learning + '/evolve-cases' && req.method === 'POST') {
      uploaded = await read();
      return respond({ evolveRevision: 1, added: 1, retired: 0, liveCases: 1 });
    }
    if (path === learning + '/evolve-cases') return respond({ items: [], next: null, evolveRevision: 0 });
    if (path === learning + '/work') return respond({ bundleId, status: 'running', items: [] });
    if (path === learning + '/rounds') return respond({ items: [round], next: null });
    if (path === learning + '/rounds/' + roundId) return respond(round);
    throw new Error('Unexpected route: ' + path);
  })().catch(error => {
    failure ??= error;
    res.writeHead(500).end();
  });
});

await writeFile('acclimate.loop.ts', `
import { defineLoop, exact } from '@acclimate/sdk/learning';
const grade = (output: number, expected: number) => exact()(output, expected);
export default defineLoop({
  bundle: 'support-agent', channel: 'stable', grade,
  cases: [{ caseId: 'case-0', input: 1, expected: 1 }, { caseId: 'case-2', input: 2, expected: 2 }],
  execute: ({ input }) => ({ output: input }),
});
`);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const { stdout } = await promisify(execFile)(resolve('node_modules/.bin/acclimate'), ['learn', '--once'], {
    env: {
      ...process.env,
      ACCLIMATE_URL: 'http://127.0.0.1:' + server.address().port,
      ACCLIMATE_WORKSPACE: 'fixture',
      ACCLIMATE_TOKEN: 'fixture',
      ACCLIMATE_APP_PRINCIPAL: '',
      ACCLIMATE_ENROLL_TOKEN: '',
    },
    timeout: 10_000,
  });
  assert.ifError(failure);
  assert.equal(enrolled.setting.benchmark, 'inline');
  assert.deepEqual(uploaded, { cases: [{ caseId: 'case-0', input: 1, expected: 1 }], retire: [] });
  assert.match(stdout, /round 1 · incumbent 1\.00/);
  assert.match(stdout, /kept · held-out 1\.00/);
  console.log('Installed acclimate bin: TypeScript config, one-token enrollment and round progress passed.');
} finally {
  server.close();
  server.closeAllConnections();
}
