import type { AcclimateClient } from '../client.js';
import type { Evaluation } from '../types.js';
import { evaluationMutationFor } from '../internal/http-bridge.js';
import { evaluationOperationPath } from '../internal/evaluation-transport.js';
import type {
  EvaluationMutationOperation,
  EvaluationMutationScope,
} from '../internal/evaluation-transport.js';
import { assertInstalledConfiguration, type InstalledAdapter } from './legacy-adapter.js';
import type { JournalScope } from './journal.js';
import { runCapturedEvaluation } from './runner.js';
import { EvaluationError } from './errors.js';
import { deepFreeze } from './definition.js';

export interface RunEvaluationOptions extends JournalScope {
  api: AcclimateClient;
  journalRoot: string;
  adapter: InstalledAdapter;
}

/** Keeps original descriptor and schema-1 identity while using the installed engine. */
export async function runEvaluation(options: RunEvaluationOptions): Promise<Evaluation> {
  const { api, projectId, bundleId, requestId, evaluatorPrincipalId, adapter } = options;
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
  assertInstalledConfiguration({ ...descriptor, expectedCases }, descriptor);
  let configuredUrl: string;
  try {
    configuredUrl = new URL(options.serviceUrl).toString().replace(/\/$/, '');
  } catch {
    throw new EvaluationError('config.url');
  }
  if (api.baseUrl !== configuredUrl) throw new EvaluationError('auth.principal_mismatch');
  const capabilities = await api.getEvaluationCapabilities(projectId);
  if (!capabilities.retainedEvaluationOperations)
    throw new EvaluationError('capabilities.unsupported');
  if (capabilities.principalId !== evaluatorPrincipalId || capabilities.projectId !== projectId)
    throw new EvaluationError('auth.principal_mismatch');
  if (!capabilities.writeEvaluation || !capabilities.readUnpublished)
    throw new EvaluationError('auth.denied');
  const mutate = evaluationMutationFor(api);
  const result = await runCapturedEvaluation({
    config: {
      schemaVersion: 1,
      serviceUrl: options.serviceUrl,
      projectId,
      evaluatorPrincipalId,
      evaluatorToken: 'unused-existing-client',
      journalRoot: options.journalRoot,
    },
    handoff: {
      schemaVersion: 1,
      serviceUrl: options.serviceUrl,
      projectId,
      bundleId,
      requestId,
      configuration: descriptor,
    },
    transport: {
      client: api,
      mutate: async <T>(
        operation: EvaluationMutationOperation,
        scope: EvaluationMutationScope,
        body: string,
        key: string,
      ) => (await mutate(evaluationOperationPath(operation, scope), body, key)) as T,
    },
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
    allowLegacyUnbound: true,
  });
  return result.evaluation;
}
