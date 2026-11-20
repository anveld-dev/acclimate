import { heldOutDigest } from '@acclimate/sdk/learning';
import type { LearningEvolveCase } from '@acclimate/sdk';

export type Case = LearningEvolveCase<string, string>;
export function heldOut(cases: Case[]) {
  return { digest: heldOutDigest(cases), cases: cases.length };
}
export const fingerprint = (input: string) =>
  input.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');

export function meanScore(rows: { score: number }[]) {
  if (!rows.length) throw new Error('No rollout scores');
  return rows.reduce((sum, row) => sum + row.score, 0) / rows.length;
}
