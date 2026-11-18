import type { ComparisonCase, ExecutionResult, GradeResult } from '../../packages/sdk/src/compare.js';
import type { VerifiedBundle } from '../../packages/sdk/src/types.js';
import type { EvaluationDescriptor } from '../../packages/sdk/src/types.js';

/** Installed application code supplies callbacks; a service request supplies identities only. */
export interface InstalledAdapter {
  describe(): EvaluationDescriptor;
  cases: readonly ComparisonCase<unknown, unknown>[];
  execute(input: {
    bundle: VerifiedBundle;
    caseId: string;
    repetition: number;
    snapshot: unknown;
    settings: unknown;
  }): Promise<ExecutionResult<unknown>>;
  grade(input: { output: unknown; caseId: string; repetition: number }): Promise<GradeResult>;
}
