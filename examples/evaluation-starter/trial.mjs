import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { compare } from '@acclimate/sdk';
import { runExistingAgent } from './agent.mjs';
import { cases, gradeResult } from './cases.mjs';

const bundleId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const candidateId = '33333333-3333-4333-8333-333333333333';
async function fixture(name, id, parentVersionId) {
  const payload = JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
  const digest = 'sha256:' + createHash('sha256').update(JSON.stringify(payload) + '\n').digest('hex');
  return { version: { id, bundleId, parentVersionId, digest, createdAt: '2026-11-16T00:00:00Z' }, payload };
}
const parent = await fixture('baseline.json', parentId, null);
const candidate = await fixture('candidate.json', candidateId, parentId);
const byId = new Map([[parentId, parent], [candidateId, candidate]]);
const report = await compare({
  parent, candidate,
  datasetRevision: 'payment-response-fixtures-1', graderRevision: 'single-charge-result-1',
  runtime: { app: 'offline-starter-fixture', model: 'none' },
  cases: cases.map(item => ({ caseId: item.caseId, snapshot: item.input, settings: item.expected })),
  execute: async ({ version, snapshot, signal }) => ({
    output: await runExistingAgent({ bundle: byId.get(version.version.id), task: snapshot, signal }),
  }),
  grade: async ({ output, caseId }) => gradeResult(output, cases.find(item => item.caseId === caseId).expected),
});
const mean = side => report.results.reduce((sum, pair) => sum + pair[side].reward, 0) / report.results.length;
assert.equal(mean('parent'), 0.5);
assert.equal(mean('candidate'), 1);
console.log(JSON.stringify({
  simulated: true, claim: 'deterministic application wiring only',
  tasks: report.results.length, parentMean: mean('parent'), candidateMean: mean('candidate'),
  serviceMutation: false, releaseEvidence: false,
}));
