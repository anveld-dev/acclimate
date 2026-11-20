import type { EvaluationDescriptor } from '../../packages/sdk/src/types.js';

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
