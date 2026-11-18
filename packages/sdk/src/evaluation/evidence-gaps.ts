import type { CaseKey, Outcome } from '../types.js';

type Stage = 'collection' | 'execute' | 'grade' | 'metric' | 'usage';
export interface EvidenceGaps {
  total: number;
  rows: Array<CaseKey & { side: 'parent' | 'candidate'; stage: Stage; reason: string }>;
}

export function addGap(
  gaps: EvidenceGaps,
  key: CaseKey,
  side: 'parent' | 'candidate',
  stage: Stage,
  reason: string,
) {
  gaps.total++;
  if (gaps.rows.length < 32)
    gaps.rows.push({ caseId: key.caseId, repetition: key.repetition, side, stage, reason });
}

/** Only the runner's fixed categories may enter a public diagnostic. */
export function scalarGap(outcome?: Outcome): [Stage, string] | undefined {
  if (!outcome) return ['collection', 'missing_pair'];
  if (outcome.executionStatus === 'infrastructure_failed') {
    const code = outcome.error;
    return [
      'execute',
      code &&
      ['output_invalid', 'output_reference_invalid', 'cancelled', 'execution_failed'].includes(code)
        ? code
        : 'infrastructure_failed',
    ];
  }
  if (outcome.gradingStatus === 'failed') return ['grade', 'grading_failed'];
  if (outcome.gradingStatus === 'missing' && outcome.executionStatus === 'task_failed')
    return ['execute', 'task_failed'];
  if (outcome.gradingStatus === 'missing') return ['grade', 'missing_grade'];
  if (!Number.isFinite(outcome.reward)) return ['grade', 'invalid_reward'];
}
