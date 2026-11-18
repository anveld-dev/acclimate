import { evaluationDescriptorDifferences } from '../../packages/sdk/src/validation.js';
import type { AcclimateClient } from '../../packages/sdk/src/client.js';
import type { Evaluation } from '../../packages/sdk/src/types.js';
import { evaluationTransportForClient } from '../../packages/sdk/src/internal/evaluation-transport.js';
import type { InstalledAdapter } from './adapter.js';
import type { JournalScope } from '../../packages/sdk/src/evaluation/journal.js';
import { runCapturedEvaluation, verifyEvaluatorAuthority } from '../../packages/sdk/src/evaluation/runner.js';
import { EvaluationError } from '../../packages/sdk/src/evaluation/errors.js';
import { deepFreeze } from '../../packages/sdk/src/evaluation/definition.js';

export interface RunEvaluationOptions extends JournalScope {
  api: AcclimateClient;
  journalRoot: string;
  adapter: InstalledAdapter;
}

export async function runEvaluation(options: RunEvaluationOptions): Promise<Evaluation> {
  const { api, projectId, bundleId, requestId, adapter } = options;
  const execute = adapter.execute.bind(adapter),
    grade = adapter.grade.bind(adapter);
  const descriptor = deepFreeze(structuredClone(adapter.describe()));
  const cases = structuredClone(adapter.cases);
  if (!Array.isArray(cases) || !cases.length || cases.length > 1000)
    throw new EvaluationError('config.schema');
  const expectedCases = cases.flatMap((item) => {
    const repetitions = item.repetitions ?? 1;
    if (
      typeof item.caseId !== 'string' ||
      !item.caseId.trim() ||
      !Number.isInteger(repetitions) ||
      repetitions < 1 ||
      repetitions > 1000
    )
      throw new EvaluationError('config.schema');
    return Array.from({ length: repetitions }, (_, repetition) => ({
      caseId: item.caseId,
      repetition,
    }));
  });
  if (
    expectedCases.length > 1000 ||
    new Set(expectedCases.map((x) => JSON.stringify(x))).size !== expectedCases.length
  )
    throw new EvaluationError('config.schema');
  if (evaluationDescriptorDifferences({ ...descriptor, expectedCases }, descriptor).length)
    throw new EvaluationError('descriptor.mismatch');
  let configuredUrl: string;
  try {
    configuredUrl = new URL(options.serviceUrl).toString().replace(/\/$/, '');
  } catch {
    throw new EvaluationError('config.url');
  }
  if (api.baseUrl !== configuredUrl) throw new EvaluationError('auth.principal_mismatch');
  await verifyEvaluatorAuthority(api, options);
  const result = await runCapturedEvaluation({
    config: options,
    handoff: {
      schemaVersion: 1,
      serviceUrl: options.serviceUrl,
      projectId,
      bundleId,
      requestId,
      configuration: descriptor,
    },
    transport: evaluationTransportForClient(api, projectId),
    captured: {
      descriptor,
      execution: 'model-free',
      cases: deepFreeze(
        cases.map((item) => ({
          caseId: item.caseId,
          input: { snapshot: item.snapshot, settings: item.settings },
          expected: null,
          repetitions: item.repetitions,
        })),
      ),
      execute: async ({ bundle, caseId, repetition, input }) =>
        execute({ bundle, caseId, repetition, snapshot: input.snapshot, settings: input.settings }),
      grade: async ({ output, caseId, repetition }) => grade({ output, caseId, repetition }),
    },
  });
  return result.evaluation;
}
