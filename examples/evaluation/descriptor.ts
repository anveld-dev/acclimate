/** Example descriptors use the supported public wire type; installed callbacks stay local. */
import type { EvaluationDescriptor } from '@acclimate/sdk';
export type { EvaluationDescriptor } from '@acclimate/sdk';

export const nativeReviewDescriptor: EvaluationDescriptor = {
  datasetRevision: 'retry-review-snapshots-v1',
  graderRevision: 'retry-review-exact-finding-v1',
  runtime: {
    configId: 'codex-luna-review',
    configRevision: '1',
    app: 'service-proposer-review-v1',
    model: 'gpt-6-luna',
    sampling: 'reasoning-low',
    writes: 'disabled',
    network: 'disabled',
    maxTurns: '4',
    turnTimeoutMs: '110000',
    concurrency: '1',
  },
  expectedCases: ['checkout-retry', 'checkout-keyed'].map((caseId) => ({ caseId, repetition: 0 })),
};
