import type { AcclimateClient } from '../client.js';
import { AcclimateUsageError } from '../errors.js';
import { assertJson } from '../evaluation/definition.js';
import type {
  LearningEvolveCasesRequest,
  LearningOutcomeRequest,
  VerifiedVersion,
} from '../types.js';

interface LearningTarget {
  workspaceId: string;
  bundleId: string;
}

export const caseIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
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

export async function addEvolveCases(
  client: AcclimateClient,
  { workspaceId, bundleId }: LearningTarget,
  body: LearningEvolveCasesRequest,
  key?: string,
) {
  const { cases = [], retire = [] } = body;
  const ids = [...cases.map(({ caseId }) => caseId), ...retire];
  if (
    !ids.length ||
    cases.length > 100 ||
    retire.length > 100 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !caseIdPattern.test(id)) ||
    cases.some(({ caseId }) => caseId.startsWith('outcome:'))
  )
    throw new AcclimateUsageError(
      'Use up to 100 additions and 100 retirements with unique, valid case IDs',
      'cases',
    );
  for (const { input, expected } of cases) {
    assertJson(input, 64 * 1024);
    assertJson(expected, 64 * 1024);
  }
  return client.addLearningEvolveCases(workspaceId, bundleId, body, key);
}
