import type { AcclimateClient } from '../client.js';
import type { EvaluationProgressRequest } from '../types.js';
import { assertGuidedTarget } from '../evaluation-validation.js';

export interface EvaluationProgressScope {
  projectId: string;
  bundleId: string;
  requestId: string;
  attemptId: string;
}
export type EvaluationProgressUpdate = Omit<EvaluationProgressRequest, 'attemptId'>;

/** App-owned, awaited callback reporting. No timers, execution or lifecycle control.
 * Every failure returns false; callers must never use this result to replay work.
 * Own the monotonically increasing sequence in your app, including after restart.
 */
export function createEvaluationProgressReporter(
  client: AcclimateClient,
  scope: EvaluationProgressScope,
) {
  // Snapshot public identity without retaining caller-owned mutable objects.
  const bound = { ...scope };
  return {
    async report(update: EvaluationProgressUpdate): Promise<boolean> {
      try {
        assertGuidedTarget(bound);
        if (
          !bound.attemptId ||
          new TextEncoder().encode(bound.attemptId).length > 128 ||
          !Number.isSafeInteger(update.sequence) ||
          update.sequence < 1 ||
          !['preparing', 'executing', 'grading', 'submitting'].includes(update.phase) ||
          !Number.isInteger(update.total) ||
          update.total < 1 ||
          update.total > 2000 ||
          !Number.isInteger(update.completed) ||
          update.completed < 0 ||
          update.completed > update.total
        )
          return false;
        const report: EvaluationProgressRequest = {
          attemptId: bound.attemptId,
          sequence: update.sequence,
          phase: update.phase,
          completed: update.completed,
          total: update.total,
        };
        if (update.case !== undefined) {
          const { caseId, repetition } = update.case;
          if (
            typeof caseId !== 'string' ||
            !caseId.trim() ||
            new TextEncoder().encode(caseId).length > 1024 ||
            !Number.isInteger(repetition) ||
            repetition < 0 ||
            repetition > 0xffffffff
          )
            return false;
          report.case = { caseId, repetition };
        }
        if (new TextEncoder().encode(JSON.stringify(report)).length > 2048) return false;
        await client.reportEvaluationProgress(
          bound.projectId,
          bound.bundleId,
          bound.requestId,
          report,
        );
        return true;
      } catch {
        // Never expose private exception text or interfere with the callback.
        return false;
      }
    },
  };
}
