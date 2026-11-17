import type { ChannelResolution, Comparison, VersionMetadata } from '../types.js';
import { hashArtifact } from './identity.js';
import type { DevelopmentProposalFeedback } from './types.js';

export interface DevelopmentHistory {
  scopeDigest: string;
  entries: DevelopmentProposalFeedback[];
}

const maximumEntries = 5;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const validHistoryCandidateId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128;

export function validDevelopmentHistory(value: DevelopmentHistory): boolean {
  return !!value && /^sha256:[a-f0-9]{64}$/.test(value.scopeDigest) && validDevelopmentFeedback(value.entries);
}

export function validDevelopmentFeedback(entries: readonly DevelopmentProposalFeedback[]): boolean {
  return Array.isArray(entries) && entries.length <= maximumEntries && entries.every(entry => !!entry &&
      Object.keys(entry).length === 7 && ['rejected', 'indeterminate', 'failed'].includes(entry.verdict) &&
      validHistoryCandidateId(entry.candidateId) &&
      typeof entry.candidateDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(entry.candidateDigest) &&
      count(entry.totalPairs) && count(entry.scoredPairs) && count(entry.improvedPairs) && count(entry.regressedPairs) &&
      entry.scoredPairs <= entry.totalPairs && entry.improvedPairs + entry.regressedPairs <= entry.scoredPairs);
}

/** Keep every admitted string within the existing proposal service limits. */
export function proposalEvidence(teaching: readonly string[], summary: string): string[] | null {
  if (Buffer.byteLength(summary) > 4096) return null;
  if (teaching.length < 20) return [...teaching, summary];
  const index = teaching.findIndex(entry => Buffer.byteLength(entry + '\n\n' + summary) <= 4096);
  if (index === -1) return null;
  return teaching.map((entry, position) => position === index ? entry + '\n\n' + summary : entry);
}

export function developmentHistoryScope(definitionDigest: string, baseline: ChannelResolution, controlsDigest: string,
                                        teaching: readonly string[]): string {
  return hashArtifact({ definitionDigest, controlsDigest, teaching, channel: baseline.channel, revision: baseline.revision,
    versionId: baseline.version.id, versionDigest: baseline.version.digest }).sha256;
}

export function recordDevelopment(history: DevelopmentHistory | undefined, scopeDigest: string,
                                  verdict: DevelopmentProposalFeedback['verdict'], candidate: VersionMetadata,
                                  comparison?: Comparison, direction: 'higher' | 'lower' = 'higher'): DevelopmentHistory {
  const entry: DevelopmentProposalFeedback = {
    verdict, candidateId: candidate.id, candidateDigest: candidate.digest,
    totalPairs: comparison?.expectedCases.length ?? 0, scoredPairs: 0, improvedPairs: 0, regressedPairs: 0,
  };
  const expected = new Set(comparison?.expectedCases.map(key => JSON.stringify([key.caseId, key.repetition])));
  for (const { caseId, repetition, parent, candidate } of comparison?.results ?? []) {
    if (!expected.delete(JSON.stringify([caseId, repetition])) ||
        parent.executionStatus === 'infrastructure_failed' || candidate.executionStatus === 'infrastructure_failed' ||
        parent.gradingStatus !== 'scored' || candidate.gradingStatus !== 'scored' || parent.reward === null ||
        candidate.reward === null || !Number.isFinite(parent.reward) || !Number.isFinite(candidate.reward)) continue;
    entry.scoredPairs++;
    if (candidate.reward === parent.reward) continue;
    if ((candidate.reward > parent.reward) === (direction === 'higher')) entry.improvedPairs++;
    else entry.regressedPairs++;
  }
  const entries = history?.scopeDigest === scopeDigest ? history.entries : [];
  return { scopeDigest, entries: [...entries.slice(1 - maximumEntries), entry] };
}
