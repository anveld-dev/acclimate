/** Example descriptors use the supported public wire type; installed callbacks stay local. */
import type { EvaluationDescriptor } from '../../packages/sdk/src/types.js';
export type { EvaluationDescriptor } from '../../packages/sdk/src/types.js';

export const localEvaluationDescriptor: EvaluationDescriptor = {
  datasetRevision: 'payment-retry-scenarios-v1',
  graderRevision: 'payment-charge-traces-v1',
  runtime: {
    configId: 'payment-retry',
    configRevision: '1',
    app: 'payment-retry-simulator',
    model: 'none',
    sampling: 'deterministic',
    writes: 'simulated-only',
    maxAttempts: '3',
    concurrency: '1',
  },
  expectedCases: ['response-lost', 'transient-before-charge', 'clean'].flatMap((caseId) =>
    [0, 1].map((repetition) => ({ caseId, repetition })),
  ),
};

/** Presence is a named contract check, never a behavioral or native quality benchmark. */
export const presenceDescriptor: EvaluationDescriptor = {
  datasetRevision: 'bundle-contract-fixtures-v1',
  graderRevision: 'bundle-contract-grader-v1',
  runtime: {
    configId: 'presence-contract',
    configRevision: '1',
    app: 'bundle-contract-fixture-v1',
    model: 'none',
    writes: 'disabled',
    sampling: 'deterministic',
    concurrency: '1',
  },
  expectedCases: ['instructions-present', 'skills-present'].flatMap((caseId) =>
    [0, 1].map((repetition) => ({ caseId, repetition })),
  ),
};

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
