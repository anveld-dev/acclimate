#!/usr/bin/env node
// An offline stand-in for an installed evaluator CLI. It lets this repository's CI exercise the
// GitHub Action and wrapper without a service or model. ACCLIMATE_FAKE_VERDICT selects pass or fail.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [command, ...flags] = process.argv.slice(2);
const flag = (name) => {
  const at = flags.indexOf('--' + name);
  return at < 0 ? undefined : flags[at + 1];
};
const verdict = process.env.ACCLIMATE_FAKE_VERDICT === 'fail' ? 'fail' : 'pass';
const ids = {
  requestId: '00000000-0000-4000-8000-000000000001',
  candidateVersionId: '00000000-0000-4000-8000-000000000002',
  parentVersionId: '00000000-0000-4000-8000-000000000004',
  comparisonId: '00000000-0000-4000-8000-000000000003',
  candidateDigest: 'sha256:' + '3'.repeat(64),
};
const print = (value, status = 0) => {
  console.log(JSON.stringify(value));
  process.exit(status);
};

if (command === 'describe') print({ runtime: { configId: 'offline-fake', execution: 'model-free' } });
if (command === 'doctor') print({ schemaVersion: 1, status: 'ready', authorization: 'verified', checks: [] });
if (command === 'request') {
  mkdirSync(dirname(flag('out')), { recursive: true, mode: 0o700 });
  writeFileSync(flag('out'), JSON.stringify({ schemaVersion: 1, bundleId: flag('bundle'), requestId: ids.requestId }));
  print({ schemaVersion: 1, status: 'requested', ...ids });
}
if (command === 'status') print({ schemaVersion: 1, status: 'completed', ...ids, attemptId: ids.requestId });
if (command === 'run') print({ schemaVersion: 1, status: 'completed', ...ids });
if (command === 'check') {
  const failed = verdict === 'fail';
  print({
    schemaVersion: 1, verdict, code: failed ? 'policy.fail' : 'policy.pass', comparisonId: ids.comparisonId,
    policy: { id: 'offline', revision: '1', sha256: null },
    counts: { distinctCases: 2, expectedPairs: 2, comparablePairs: 2 },
    summary: { parentMean: 1, candidateMean: failed ? 0.5 : 1, orientedMeanImprovement: failed ? -0.5 : 0 },
    checks: [{ code: 'policy.minimum_mean_improvement', result: failed ? 'fail' : 'pass' }],
    cases: [{ caseId: 'refund-flow', parentMean: 1, candidateMean: failed ? 0 : 1,
      orientedMeanImprovement: failed ? -1 : 0 }],
  }, failed ? 2 : 0);
}
if (command === 'export') {
  mkdirSync(flag('out'), { recursive: true, mode: 0o700 });
  writeFileSync(join(flag('out'), 'manifest.json'), '{}');
  print({ schemaVersion: 1, status: 'exported' });
}
if (command === 'verify-export') print({ schemaVersion: 1, status: 'verified' });
console.error(JSON.stringify({ schemaVersion: 1, command, error: { code: 'config.schema' } }));
process.exit(1);
