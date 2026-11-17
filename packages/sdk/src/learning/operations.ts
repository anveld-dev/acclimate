import type { Comparison } from '../types.js';
import type { LearningOperation, WorkReceipt } from './types.js';

export class LearningError extends Error {
  constructor(readonly code: string) { super(`Learning: ${code}`); this.name = 'LearningError'; }
}
export function operationRuntime(operation: Readonly<LearningOperation>): Record<string, string> {
  return {
    'acclimate.learning.schema': '1',
    'acclimate.learning.definition': operation.definitionDigest,
    'acclimate.learning.stage': operation.kind,
    ...(operation.auditCohort ? { 'acclimate.learning.auditCohort': operation.auditCohort.digest } : {}),
  };
}
export function validateComparisonBinding(comparison: Comparison, operation: LearningOperation): void {
  const candidate = operation.candidate;
  if (!candidate || !comparison || comparison.parentVersionId !== operation.baseline.version.id ||
      comparison.parentDigest !== operation.baseline.version.digest ||
      comparison.candidateVersionId !== candidate.id || comparison.candidateDigest !== candidate.digest ||
      !comparison.evaluation?.requestId || !comparison.evaluation.attemptId ||
      Object.entries(operationRuntime(operation)).some(([key, value]) => comparison.runtime?.[key] !== value))
    throw new LearningError('comparison-binding');
}
export function validateWorkReceipt(receipt: WorkReceipt, operation: LearningOperation): void {
  if (!receipt || receipt.operationId !== operation.id ||
      !['pending', 'unknown', 'succeeded', 'failed'].includes(receipt.status) ||
      typeof receipt.executionSettled !== 'boolean' ||
      !(receipt.costMicroUsd === null || (Number.isSafeInteger(receipt.costMicroUsd) && receipt.costMicroUsd >= 0)))
    throw new LearningError('receipt-invalid');
  if (receipt.status === 'succeeded') {
    if (!receipt.executionSettled || !receipt.output) throw new LearningError('receipt-unsettled');
    if (operation.kind === 'propose') {
      if (receipt.output.kind !== 'proposal') throw new LearningError('receipt-kind');
      const candidate = receipt.output.candidate;
      if (candidate.bundleId !== operation.scope.bundleId || candidate.parentVersionId !== operation.baseline.version.id ||
          !candidate.id || !/^sha256:[a-f0-9]{64}$/.test(candidate.digest))
        throw new LearningError('candidate-binding');
    } else {
      if (receipt.output.kind !== 'evaluation') throw new LearningError('receipt-kind');
      validateComparisonBinding(receipt.output.comparison, operation);
    }
  }
}
