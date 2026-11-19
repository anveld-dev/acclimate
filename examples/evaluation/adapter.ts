import type { ComparisonCase, ExecutionResult, GradeResult } from '@acclimate/sdk';
import type { VerifiedVersion } from '@acclimate/sdk';
import type { EvaluationDescriptor } from '@acclimate/sdk';

/** Installed application code supplies callbacks; a service request supplies identities only. */
export interface InstalledAdapter {
  describe(): EvaluationDescriptor;
  cases: readonly ComparisonCase<unknown, unknown>[];
  execute(input: {
    bundle: VerifiedVersion;
    caseId: string;
    repetition: number;
    snapshot: unknown;
    settings: unknown;
  }): Promise<ExecutionResult<unknown>>;
  grade(input: { output: unknown; caseId: string; repetition: number }): Promise<GradeResult>;
}
