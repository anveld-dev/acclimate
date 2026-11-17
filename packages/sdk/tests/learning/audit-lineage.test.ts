import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openAuditLineage } from '../../src/learning/audit-lineage.js';
import { sha256Bytes } from '../../src/learning/identity.js';

test('a durable audit claim serializes overlapping campaigns and supports same-work recovery', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'audit-lineage-'));
  try {
    const scope = { projectId: 'p', bundleId: 'bundle', taskFamilyId: 'family', partitionId: 'first', policyEpoch: 'a' };
    const first = await openAuditLineage(directory, scope);
    const second = await openAuditLineage(directory, { ...scope, taskFamilyId: 'renamed', policyEpoch: 'b' });
    const cohort = (id: string) => ({ id, digest: sha256Bytes(id), cases: [{
      caseFingerprint: sha256Bytes(id), familyFingerprint: sha256Bytes('protected family'),
    }] });
    const candidates = [cohort('first'), cohort('second')];
    assert.equal(await first.select(candidates), candidates[0]);
    assert.equal(await second.select(candidates.slice(1)), candidates[1]);
    const claims = await Promise.all([first.claim(candidates[0]!, 'one'), second.claim(candidates[1]!, 'two')]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims[0] ? 0 : 1;
    const winnerId = winner === 0 ? 'one' : 'two';
    const recovered = await openAuditLineage(directory, scope);
    assert.equal(await recovered.claim(candidates[winner]!, winnerId), true);
    assert.equal(await recovered.select(candidates), undefined);
    await assert.rejects(recovered.claim(candidates[1 - winner]!, winnerId), /audit-lineage-conflict/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
