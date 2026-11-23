import type { AcclimateClient } from './client.js';
import { AcclimateUsageError } from './errors.js';
import type { LearningOutcomeRequest, VerifiedVersion } from './types.js';

interface LearningTarget {
  workspaceId: string;
  bundleId: string;
}

export const uuidPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function createLearningOutcomeReporter({
  client,
  workspaceId,
  bundleId,
}: LearningTarget & { client: AcclimateClient }) {
  return async (
    version: VerifiedVersion,
    body: Pick<LearningOutcomeRequest, 'outcomeId' | 'input' | 'expected' | 'output'>,
  ) => {
    if (!uuidPattern.test(body.outcomeId))
      throw new AcclimateUsageError('outcomeId must be a UUID', 'outcomeId');
    if (version.version.bundleId !== bundleId)
      throw new AcclimateUsageError(
        'The verified version belongs to a different bundle',
        'bundleId',
      );
    const { outcomeId, input, expected } = body;
    return client.reportLearningOutcome(workspaceId, bundleId, {
      outcomeId,
      input,
      expected,
      ...(body.output === undefined ? {} : { output: body.output }),
      versionId: version.version.id,
      digest: version.version.digest,
    });
  };
}
