import { canonicalOperationPath } from '../lib/operation-target';
import { ApiError } from '@acclimate/sdk';
import { consoleClient } from './console-client';
import { evaluationConfiguration } from '../lib/evaluation-config';
import type {
  Comparison,
  ComparisonPolicyReceipt,
  Evaluation,
  Proposal,
  Release,
  Page,
  VersionMetadata,
  BundlePayload,
  EvaluationProgressView,
} from '@acclimate/sdk';
import { exactOperation, lookupOperation, closeOperation } from './exact-operation';
import { readChannel } from './channel';
import { readVersion } from './version-workflows';

type Env = Record<string, string | undefined>;
export type ImprovementResult =
  | { ok: false; message: string; code?: 'policy_override_required' }
  | {
      ok: true;
      outcome?: Awaited<ReturnType<typeof lookupOperation>>;
      result?: Proposal | Evaluation | Release;
      resultKind?: 'proposal' | 'request' | 'promotion';
      command?: { operationPath: string; body: string };
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
      promotion?: Release;
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
    // A frozen command reconciles before reading mutable channel/draft state.
    if (['submitFrozen', 'lookupFrozen', 'closeFrozen'].includes(String(input.action))) {
      const p = env.CONSOLE_PROJECT,
        b = env.CONSOLE_BUNDLE,
        channel = env.CONSOLE_CHANNEL;
      if (!p || !b || !channel || env.CONSOLE_ALLOW_EDITS !== 'true') throw Error('scope');
      const prefix = `/v1/workspaces/${encodeURIComponent(p)}/bundles/${encodeURIComponent(b)}`;
      const operationPath = String(input.operationPath),
        key = String(input.key);
      const target = canonicalOperationPath(operationPath);
      const allowed = [
        prefix + '/proposals',
        prefix + '/evaluation-requests',
        prefix + `/channels/${encodeURIComponent(channel)}/releases`,
      ];
      const draftPublish =
        target.startsWith(prefix + `/channels/${encodeURIComponent(channel)}/drafts/`) &&
        /^[-a-f0-9]{36}\/publish$/i.test(
          target.slice((prefix + `/channels/${encodeURIComponent(channel)}/drafts/`).length),
        );
      if (!allowed.includes(target) && !draftPublish) throw Error('route');
      if (input.action === 'lookupFrozen')
        return {
          ok: true as const,
          outcome: await lookupOperation(env, { projectId: p, operationPath, key }, fetcher),
        };
      if (input.action === 'closeFrozen')
        return {
          ok: true as const,
          outcome: await closeOperation(env, { projectId: p, operationPath, key }, fetcher),
        };
      if (typeof input.body !== 'string') throw Error('body');
      const parsed = JSON.parse(input.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('body');
      if (operationPath.endsWith('/evaluation-requests') && parsed.requireBoundEvidence !== true)
        throw Error('binding required');
      if (operationPath.endsWith('/proposals')) {
        const disclosure = input.disclosure as Record<string, unknown> | undefined;
        if (
          !disclosure ||
          disclosure.consent !== true ||
          disclosure.wholeParentBundle !== true ||
          !Array.isArray(disclosure.authorizedEvidence) ||
          JSON.stringify(disclosure.authorizedEvidence) !== JSON.stringify(parsed.evidence)
        )
          throw Error(
            'Confirm the parent-bundle and selected-evidence disclosure before submitting.',
          );
      }

      const value = await exactOperation<Proposal | Evaluation | Release>(
        env,
        { projectId: p, operationPath, key, body: input.body },
        fetcher,
      );
      return {
        ok: true as const,
        result: value,
        resultKind: operationPath.endsWith('/proposals')
          ? 'proposal'
          : operationPath.endsWith('/evaluation-requests')
            ? 'request'
            : 'promotion',
      };
    }
    if (input.action === 'evaluate' && input.configuration === undefined)
      return {
        ok: false,
        message: 'Provide the public configuration from your installed application evaluator.',
      };
    const state = await readChannel(env, fetcher);
    if (state.status !== 'ready')
      return { ok: false as const, message: 'Select a configured channel first.' };
    const api = client(env, fetcher),
      p = state.projectId,
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
    if (!state.canEdit)
      return { ok: false as const, message: 'Editing is disabled for this console.' };
    if (typeof input.key !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.key))
      throw new Error('key');
    const key = input.key;
    if (input.action === 'propose') {
      if (
        input.consent !== true ||
        input.parentVersionId !== state.resolution.version.id ||
        typeof input.hypothesis !== 'string' ||
        !input.hypothesis.trim() ||
        !Array.isArray(input.allowedPaths) ||
        !input.allowedPaths.length ||
        !input.allowedPaths.every(
          (path) => typeof path === 'string' && state.payload.files.some((f) => f.path === path),
        ) ||
        !Array.isArray(input.evidence) ||
        !input.evidence.every((e) => typeof e === 'string')
      )
        throw new Error('proposal');
      return {
        ok: true as const,
        command: {
          operationPath: `/v1/workspaces/${encodeURIComponent(p)}/bundles/${encodeURIComponent(b)}/proposals`,
          body: JSON.stringify({
            parentVersionId: state.resolution.version.id,
            allowedPaths: input.allowedPaths as string[],
            hypothesis: input.hypothesis.trim(),
            evidence: input.evidence as string[],
          }),
        },
      };
    }
    if (input.action === 'evaluate' || input.action === 'publish') {
      const candidate = await readVersion(env, { versionId: input.versionId }, fetcher);
      if (
        !candidate.ok ||
        candidate.version.parentVersionId !== state.resolution.version.id ||
        input.expectedRevision !== state.resolution.revision
      )
        throw new Error('stale');
      if (input.action === 'evaluate') {
        const configuration = evaluationConfiguration(input.configuration);
        return {
          ok: true as const,
          command: {
            operationPath: `/v1/workspaces/${encodeURIComponent(p)}/bundles/${encodeURIComponent(b)}/evaluation-requests`,
            body: JSON.stringify({
              ...configuration,
              requireBoundEvidence: true,
              parentVersionId: state.resolution.version.id,
              parentDigest: state.resolution.version.digest,
              candidateVersionId: candidate.version.id,
              candidateDigest: candidate.version.digest,
              ...(typeof input.proposalId === 'string' && input.proposalId
                ? { proposalId: input.proposalId }
                : {}),
            }),
          },
        };
      }
      const evidence = typeof input.comparisonId === 'string' && input.comparisonId.trim();
      if (!evidence && (typeof input.reason !== 'string' || !input.reason.trim()))
        throw new Error('reason');
      const release = evidence
        ? {
            comparisonId: evidence,
            ...(input.policyOverride ? { policyOverride: input.policyOverride } : {}),
          }
        : { unevaluatedReason: String(input.reason).trim() };
      if (typeof input.draftId === 'string' && input.draftId) {
        const draft = await api.getDraft(p, b, state.channel, input.draftId);
        if (
          draft.snapshotVersion.id !== candidate.version.id ||
          draft.generation !== input.generation
        )
          throw new Error('draft changed');
        return {
          ok: true as const,
          command: {
            operationPath: `/v1/workspaces/${encodeURIComponent(p)}/bundles/${encodeURIComponent(b)}/channels/${encodeURIComponent(state.channel)}/drafts/${encodeURIComponent(draft.id)}/publish`,
            body: JSON.stringify({
              ...release,
              expectedGeneration: draft.generation,
              expectedRevision: state.resolution.revision,
            }),
          },
        };
      }
      return {
        ok: true as const,
        command: {
          operationPath: `/v1/workspaces/${encodeURIComponent(p)}/bundles/${encodeURIComponent(b)}/channels/${encodeURIComponent(state.channel)}/releases`,
          body: JSON.stringify({
            ...release,
            versionId: candidate.version.id,
            expectedRevision: state.resolution.revision,
          }),
        },
      };
    }
    if (
      input.action === 'interrupt' &&
      typeof input.id === 'string' &&
      typeof input.reason === 'string' &&
      input.reason.trim()
    )
      return {
        ok: true as const,
        request: await api.interruptEvaluation(
          p,
          b,
          input.id,
          { reason: input.reason.trim() },
          key,
        ),
      };
    if (
      input.action === 'abandon' &&
      typeof input.id === 'string' &&
      typeof input.reason === 'string' &&
      input.reason.trim()
    )
      return {
        ok: true as const,
        request: await api.abandonEvaluation(p, b, input.id, { reason: input.reason.trim() }, key),
      };
    throw new Error('invalid');
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.code === 'policy_override_required'
    ) {
      return {
        ok: false,
        code: 'policy_override_required',
        message:
          'Release blocked by a reported policy verdict. Review the current receipts and acknowledge them before publishing.',
      };
    }
    return {
      ok: false as const,
      message:
        'The operation could not be confirmed. Check scope, permissions and current revision; refresh before retrying. No execution or release is assumed.',
    };
  }
}
