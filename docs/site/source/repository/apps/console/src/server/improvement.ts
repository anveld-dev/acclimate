import { consoleClient } from './console-client';
import type {
  Comparison,
  ComparisonPolicyReceipt,
  Evaluation,
  Proposal,
  Page,
  VersionMetadata,
  BundlePayload,
  EvaluationProgressView,
} from '@acclimate/sdk';
import { readChannel } from './channel';
import { readVersion } from './version-workflows';

type Env = Record<string, string | undefined>;
export type ImprovementResult =
  | { ok: false; message: string }
  | {
      ok: true;
      proposals?: Page<Proposal>;
      requests?: Page<Evaluation>;
      proposal?: Proposal;
      request?: Evaluation;
      progress?: EvaluationProgressView;
      candidate?: { version: VersionMetadata; payload: BundlePayload };
      parent?: VersionMetadata;
      parentPayload?: BundlePayload;
      comparison?: Comparison;
      receipts?: { comparison: ComparisonPolicyReceipt[]; blockers: ComparisonPolicyReceipt[] };
    };
export function comparisonSummary(report: Comparison) {
  const outcomes = report.results.flatMap((pair) => [pair.parent, pair.candidate]);
  const scoredPairs = report.results.filter((pair) =>
    [pair.parent, pair.candidate].every((o) => o.gradingStatus === 'scored' && o.reward !== null),
  ).length;
  return {
    expectedPairs: report.expectedCases.length,
    scoredPairs,
    missingGrades:
      outcomes.filter((o) => o.gradingStatus !== 'scored' || o.reward === null).length +
      Math.max(0, report.expectedCases.length - report.results.length) * 2,
    executionFailures: outcomes.filter((o) => o.executionStatus !== 'completed').length,
    costUsd:
      outcomes.length === report.expectedCases.length * 2 &&
      outcomes.every((o) => o.usage?.costUsd !== undefined)
        ? outcomes.reduce((sum, o) => sum + o.usage!.costUsd!, 0)
        : null,
  };
}
function client(env: Env, fetcher: typeof fetch) {
  return consoleClient(env, fetcher);
}
export async function improvement(
  env: Env,
  input: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<ImprovementResult> {
  try {
    const state = await readChannel(env, fetcher);
    if (state.status !== 'ready')
      return { ok: false as const, message: 'Select a configured channel first.' };
    const api = client(env, fetcher),
      p = state.workspaceId,
      b = state.bundleId;
    if (input.action === 'list' || input.action === 'proposals' || input.action === 'requests')
      return {
        ok: true as const,
        ...(input.action !== 'requests'
          ? {
              proposals: await api.listProposals(p, b, {
                limit: 20,
                cursor: typeof input.proposalCursor === 'string' ? input.proposalCursor : undefined,
              }),
            }
          : {}),
        ...(input.action !== 'proposals'
          ? {
              requests: await api.listEvaluations(p, b, {
                limit: 20,
                cursor: typeof input.requestCursor === 'string' ? input.requestCursor : undefined,
              }),
            }
          : {}),
      };
    if (input.action === 'request') {
      const [request, progress] = await Promise.all([
        api.getEvaluation(p, b, String(input.id)),
        api.getEvaluationProgress(p, b, String(input.id)).catch(() => undefined),
      ]);
      // Activity is optional observational data; its failure cannot hide durable request state.
      return { ok: true as const, request, ...(progress ? { progress } : {}) };
    }
    if (input.action === 'proposal')
      return { ok: true as const, proposal: await api.getProposal(p, b, String(input.id)) };
    if (input.action === 'candidate') {
      const candidate = await readVersion(env, { versionId: input.versionId }, fetcher);
      if (!candidate.ok) return candidate;
      if (!candidate.version.parentVersionId) throw new Error('candidate has no parent');
      const parent = await readVersion(
        env,
        { versionId: candidate.version.parentVersionId },
        fetcher,
      );
      if (!parent.ok) return parent;
      return {
        ok: true as const,
        candidate,
        parent: parent.version,
        parentPayload: parent.payload,
      };
    }
    if (input.action === 'policyReceipts') {
      const [comparison, candidate] = await Promise.all([
        input.comparison
          ? api.listComparisonPolicyReceipts(p, b, String(input.comparison))
          : Promise.resolve({ items: [] }),
        api.listCandidatePolicyReceipts(p, b, String(input.candidate)),
      ]);
      return { ok: true, receipts: { comparison: comparison.items, blockers: candidate.items } };
    }
    if (input.action === 'comparison')
      return { ok: true as const, comparison: await api.getComparison(p, b, String(input.id)) };
    return { ok: false, message: 'Changes are released by connected learning.' };
  } catch {
    return { ok: false, message: 'Could not read this change. Check access and try again.' };
  }
}
