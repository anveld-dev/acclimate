import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateRequest, fixtureIdentity } from './evaluation/tests/evaluate-request.js';
import { fixture, projectId, bundleId, requestId, evaluatorPrincipalId, serviceUrl } from './evaluation/fixture.js';
import type { ComparisonRequest } from '../packages/sdk/src/types.js';

test('named presence contract uses explicit private state and submits a bound complete report', async () => {
  const journalRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'acclimate-contract-'));
  const f = fixture(fixtureIdentity);
  try {
    await evaluateRequest(f.api, projectId, bundleId, requestId, { journalRoot, serviceUrl, evaluatorPrincipalId });
    const report = f.events.find((e) => e.kind === 'submit')!.body as ComparisonRequest;
    assert.equal(report.results.length, 4);
    assert.ok(report.results.every((r) => r.parent.reward === 1 && r.candidate.reward === 1));
    assert.deepEqual(report.evaluation, { requestId, attemptId: f.request.attemptId });
  } finally { await rm(journalRoot, { recursive: true, force: true }); }
});
