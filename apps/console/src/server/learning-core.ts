import { AcclimateClient, ApiError } from '@acclimate/sdk';
import { consoleClient } from './console-client';
import { allPages } from './listing';
import { accessTransport } from './access-core';
import type { MachineToken } from './machine-token-core';
import type { Environment } from './selection';
import {
  enrollmentError,
  evolveCaseBody,
  type CaseSummary,
  type ActiveEvaluation,
  type LearningCommand,
  type LearningScope,
} from '../lib/learning';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function validateScope({ workspaceId, bundleId }: LearningScope) {
  if (
    typeof workspaceId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(workspaceId) ||
    ['.', '..'].includes(workspaceId) ||
    typeof bundleId !== 'string' ||
    !uuid.test(bundleId)
  )
    throw new Error('Invalid learning scope');
}

async function inspect(api: AcclimateClient, { workspaceId, bundleId }: LearningScope) {
  try {
    return await api.getLearningLoop(workspaceId, bundleId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'not_found')
      return null;
    throw error;
  }
}

function failure(error: unknown, mutation = false, appPrincipal = false) {
  return {
    ok: false as const,
    message:
      error instanceof ApiError && [401, 403].includes(error.status)
        ? appPrincipal
          ? 'The app principal token was refused.'
          : 'Access denied. Check your workspace access.'
        : error instanceof ApiError && [400, 409].includes(error.status) && !appPrincipal
          ? error.message
          : error instanceof ApiError && error.status === 409 && appPrincipal
            ? 'This case ID is already in use. Choose a new ID for a different case.'
            : mutation
              ? 'Could not confirm the change. Refresh the learning page before trying again.'
              : 'Could not load the learning loop. Refresh to try again.',
  };
}

export async function readLearningBinding(env: Environment, scope: LearningScope, fetcher = fetch) {
  try {
    validateScope(scope);
    const loop = await inspect(consoleClient(env, fetcher), scope);
    return loop?.channel ?? null;
  } catch {
    return null;
  }
}

export async function readLearningState(env: Environment, scope: LearningScope, fetcher = fetch) {
  try {
    validateScope(scope);
    const api = consoleClient(env, fetcher);
    const { workspaceId, bundleId } = scope;
    const [workspaces, bundles] = await Promise.all([
      allPages((cursor) => api.listWorkspaces({ cursor, limit: 100 })),
      allPages((cursor) => api.listBundles(workspaceId, { cursor, limit: 100 })),
    ]);
    const workspace = workspaces.find(({ id }) => id === workspaceId);
    const bundle = bundles.find(({ id }) => id === bundleId);
    if (!workspace || !bundle)
      return { ok: false as const, message: 'This bundle is unavailable.' };
    const canManage = workspace.role === 'admin' && env.CONSOLE_ALLOW_EDITS === 'true';
    const [loop, channels] = await Promise.all([
      inspect(api, scope),
      allPages((cursor) => api.listChannels(workspaceId, bundleId, { cursor, limit: 100 })),
    ]);
    const needsEnrollment = !loop || loop.status === 'stopped';
    const principals =
      canManage && needsEnrollment
        ? await accessTransport(
            env,
            fetcher,
          )(`/v1/workspaces/${encodeURIComponent(workspaceId)}/machine-tokens`)
            .then(({ items }: { items: MachineToken[] }) =>
              items
                .filter(
                  ({ status, rights }) =>
                    status === 'active' &&
                    (rights.includes('evaluate') || rights.includes('write')),
                )
                .map(({ name, principalId }) => ({ name, principalId })),
            )
            .catch(() => [])
        : [];
    const rounds = loop
      ? await allPages(async (before) => {
          const page = await api.listLearningRounds(workspaceId, bundleId, {
            limit: 100,
            before: before ? Number(before) : undefined,
          });
          return { items: page.items, nextCursor: page.next == null ? null : String(page.next) };
        })
      : [];
    const activeId = loop?.activeRound?.id;
    const lastScoredId = rounds.find((round) => round.incumbentScore !== null)?.id;
    const [active, lastScored] = await Promise.all([
      activeId ? api.getLearningRound(workspaceId, bundleId, activeId) : null,
      lastScoredId && lastScoredId !== activeId
        ? api.getLearningRound(workspaceId, bundleId, lastScoredId)
        : null,
    ]);
    const openEvaluation = active?.evaluations.find(
      ({ status }) => status === 'queued' || status === 'running',
    );
    const activeEvaluation: ActiveEvaluation | null = openEvaluation
      ? {
          role: openEvaluation.role,
          sample: openEvaluation.sample,
          split: openEvaluation.split,
          status: openEvaluation.status,
          cases: openEvaluation.cases,
          reportedCases: openEvaluation.reportedCases,
        }
      : null;
    let caseSnapshot: { roundNumber: number; revision: number; cases: CaseSummary[] } | null = null;
    for (const round of [active, lastScored]) {
      const cases = round?.evaluations.find(
        ({ split, role }) => split === 'evolve' && role === 'incumbent',
      )?.caseSummaries;
      if (round && cases?.length) {
        caseSnapshot = {
          roundNumber: round.number,
          revision: round.evolveRevision,
          cases: cases.map(({ caseId, passedRollouts, meanScore }) => ({
            caseId,
            passedRollouts,
            meanScore,
          })),
        };
        break;
      }
    }
    return {
      ok: true as const,
      bundleName: bundle.name,
      loop,
      canManage,
      channels: channels.map(({ name }) => name),
      principals,
      rounds,
      activeEvaluation,
      caseSnapshot,
    };
  } catch (error) {
    return failure(error);
  }
}

export type LearningState = Awaited<ReturnType<typeof readLearningState>>;

export async function runLearningCommand(
  env: Environment,
  scope: LearningScope,
  command: LearningCommand,
  fetcher = fetch,
) {
  try {
    validateScope(scope);
    if (env.CONSOLE_ALLOW_EDITS !== 'true')
      return { ok: false as const, message: 'Changes are disabled for this console.' };
    const api = consoleClient(env, fetcher);
    const { workspaceId, bundleId } = scope;
    const key = crypto.randomUUID();
    switch (command?.action) {
      case 'enroll': {
        const error = enrollmentError(command.body);
        if (error) return { ok: false as const, message: error };
        const { channel, appPrincipalId, setting, heldOut } = command.body;
        await api.enrollLearningLoop(
          workspaceId,
          bundleId,
          {
            channel,
            appPrincipalId,
            setting: {
              domain: setting.domain,
              benchmark: setting.benchmark,
              policyModel: setting.policyModel,
            },
            heldOut: { digest: heldOut.digest, cases: heldOut.cases },
          },
          key,
        );
        break;
      }
      case 'pause':
        await api.pauseLearningLoop(workspaceId, bundleId, key);
        break;
      case 'resume':
        await api.resumeLearningLoop(workspaceId, bundleId, key);
        break;
      case 'stop':
        await api.stopLearningLoop(workspaceId, bundleId, key);
        break;
      case 'addCase': {
        const workspaces = await allPages((cursor) => api.listWorkspaces({ cursor, limit: 100 }));
        if (!workspaces.some(({ id, role }) => id === scope.workspaceId && role === 'admin'))
          return {
            ok: false as const,
            message: 'Only workspace administrators can submit cases from the console.',
          };
        if (typeof command.token !== 'string' || !command.token.trim())
          return { ok: false as const, message: 'Enter the enrolled app principal token.' };
        let body;
        try {
          body = evolveCaseBody(command);
        } catch (error) {
          return { ok: false as const, message: (error as Error).message };
        }
        const app = new AcclimateClient({
          baseUrl: env.CONSOLE_SERVICE_URL!,
          token: command.token.trim(),
          scope: 'learning-case',
          fetch: fetcher,
          retries: 0,
          timeoutMs: 5000,
        });
        const receipt = await app.addLearningEvolveCases(workspaceId, bundleId, body, key);
        return { ok: true as const, receipt };
      }
      default:
        return { ok: false as const, message: 'Invalid learning action.' };
    }
    return { ok: true as const };
  } catch (error) {
    return failure(error, true, command?.action === 'addCase');
  }
}
