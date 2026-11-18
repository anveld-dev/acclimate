import type { EvaluationDescriptor } from '@acclimate/sdk';

export const appDescriptor: EvaluationDescriptor = {
  datasetRevision: 'installed-app-tasks-v1',
  graderRevision: 'installed-checks-v1',
  runtime: { configId: 'app-agent', configRevision: '1', execution: 'live' },
  expectedCases: ['instructions-present', 'more'].flatMap((caseId) =>
    [0, 1].map((repetition) => ({ caseId, repetition })),
  ),
};
