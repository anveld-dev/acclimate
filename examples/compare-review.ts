import { createHash } from 'node:crypto';
import { compare } from '../packages/sdk/src/compare.js';
import type { BundlePayload, VersionMetadata } from '../packages/sdk/src/types.js';

// A deterministic wiring example, not a model benchmark. The fake executor reads
// each version's skill text; the grader checks findings against separate truth.
function payload(skill: string): BundlePayload {
  return {
    schemaVersion: 1,
    files: [
      {
        path: 'skills/retry-review/SKILL.md',
        kind: 'skill',
        text: `---\nname: retry-review\ndescription: Review retry behavior.\n---\n${skill}\n`,
      },
    ],
  };
}
const parentPayload = payload('Review writes for bugs.');
const candidatePayload = payload('Inspect retrying writes for a missing idempotencyKey.');
function metadata(
  id: string,
  parentVersionId: string | null,
  content: BundlePayload,
): VersionMetadata {
  return {
    id,
    bundleId: 'fixture-reviewer',
    parentVersionId,
    digest: `sha256:${createHash('sha256')
      .update(`${JSON.stringify(content)}\n`)
      .digest('hex')}`,
    createdAt: '2026-11-13T00:00:00Z',
  };
}
const parent = metadata('fixture-v7', null, parentPayload);
const candidate = metadata('fixture-v8', parent.id, candidatePayload);
const contentByVersion = new Map([
  [parent.id, parentPayload],
  [candidate.id, candidatePayload],
]);
const truth = new Map([
  ['safe-write', false],
  ['unsafe-write', true],
]);
const report = await compare({
  parent: { version: parent },
  candidate: { version: candidate },
  cases: [
    {
      caseId: 'safe-write',
      snapshot: { diff: 'retry(() => chargePayment(amount, { idempotencyKey: requestId }))' },
      settings: { mode: 'fixture' },
      repetitions: 2,
    },
    {
      caseId: 'unsafe-write',
      snapshot: { diff: 'retry(() => chargePayment(amount))' },
      settings: { mode: 'fixture' },
    },
  ],
  datasetRevision: 'saved-prs-fixture-v1',
  runtime: { executor: 'deterministic-skill-fixture', model: 'none' },
  graderRevision: 'hidden-finding-fixture-v1',
  concurrency: 2,
  execute: async ({ version, caseId, snapshot }) => {
    const content = contentByVersion.get(version.version.id)!;
    const checksRetries = content.files.some((file) => file.text.includes('idempotencyKey'));
    const foundUnsafeRetry =
      checksRetries &&
      snapshot.diff.includes('retry(') &&
      !snapshot.diff.includes('idempotencyKey');
    return {
      output: { foundUnsafeRetry },
      outputRef: `fixture://${version.version.id}/${caseId}`,
      usage: null,
    };
  },
  grade: async ({ output, caseId }) => ({
    reward: output.foundUnsafeRetry === truth.get(caseId) ? 1 : 0,
  }),
});

// Upload real application reports with submitComparison(client, project, bundle, report, key).
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
