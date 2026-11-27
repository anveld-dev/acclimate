import type { LearningEvaluation } from '@anveld/acclimate-sdk';

export type LearningScope = { workspaceId: string; bundleId: string };
export type LearningReadOptions = { round?: string; memory?: string };
export const activeRoundStates = [
  'scoring_incumbent',
  'proposing',
  'screening',
  'evaluating',
  'selecting',
  'scoring_held_out',
] as const;
export type ActiveEvaluation = Pick<
  LearningEvaluation,
  'role' | 'sample' | 'split' | 'status' | 'cases' | 'reportedCases'
>;
