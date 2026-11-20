import { createHash } from 'node:crypto';
import { canonicalEvaluationJson } from '../evaluation/manifest.js';
import type { LearningEvolveCase } from '../types.js';

const hash = (value: unknown) =>
  createHash('sha256').update(canonicalEvaluationJson(value)).digest('hex');

export function heldOutDigest(cases: readonly LearningEvolveCase<unknown, unknown>[]): string {
  const identities = cases.map(({ caseId, input, expected }) => ({
    caseId,
    input: hash(input),
    expected: hash(expected),
  }));
  identities.sort((a, b) => Buffer.compare(Buffer.from(a.caseId), Buffer.from(b.caseId)));
  return 'sha256:' + hash(identities);
}
