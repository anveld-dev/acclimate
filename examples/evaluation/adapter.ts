import type { ComparisonCase, ExecutionResult, GradeResult } from '../../packages/sdk/src/compare.js';
import type { VerifiedBundle } from '../../packages/sdk/src/types.js';
import type { EvaluationDescriptor } from './descriptor.js';

/** Installed application code supplies callbacks; a service request supplies identities only. */
export interface InstalledAdapter {
  describe(): EvaluationDescriptor;
  cases: readonly ComparisonCase<unknown, unknown>[];
  execute(input: {
    bundle: VerifiedBundle; caseId: string; repetition: number; snapshot: unknown; settings: unknown;
  }): Promise<ExecutionResult<unknown>>;
  grade(input: { output: unknown; caseId: string; repetition: number }): Promise<GradeResult>;
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalized(v)]));
  return value;
}

export function assertInstalledConfiguration(request: EvaluationDescriptor, installed: EvaluationDescriptor) {
  const identity = (value: EvaluationDescriptor) => ({
    datasetRevision: value.datasetRevision,
    graderRevision: value.graderRevision,
    runtime: value.runtime,
    expectedCases: [...value.expectedCases].sort((a, b) => a.caseId.localeCompare(b.caseId) || a.repetition - b.repetition),
  });
  if (JSON.stringify(normalized(identity(request))) !== JSON.stringify(normalized(identity(installed))))
    throw new Error('Request does not match installed fixture/application configuration');
}
