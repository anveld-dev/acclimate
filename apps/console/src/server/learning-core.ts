import { ApiError, type AcclimateClient, type LearningRound } from '@acclimate/sdk';
import { readVersion } from './release-history';
import { consoleClient } from './console-client';
import { allPages } from './listing';
import type { Environment } from './selection';
import {
  enrollmentError,
  evolveCaseBody,
  type ActiveEvaluation,
  type LearningCommand,
  type LearningScope,
  type LearningReadOptions,
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

function failure(error: unknown, mutation = false) {
  return {
    ok: false as const,
    message:
      error instanceof ApiError && [401, 403].includes(error.status)
        ? 'Access denied. Check your workspace access.'
        : error instanceof ApiError && [400, 409].includes(error.status)
          ? error.message
          : mutation
            ? 'Could not confirm the change. Refresh the learning page before trying again.'
            : 'Could not load the learning loop. Refresh to try again.',
  };
}

async function readRoundDetail(
  env: Environment,
  { workspaceId, bundleId }: LearningScope,
  load: () => Promise<LearningRound>,
  fetcher: typeof fetch,
) {
  try {
    const {
      id,
      number,
      channel,
      channelRevision,
      parentVersionId,
      incumbentScore,
      candidates,
      decision,
      reason,
      selection,
      adoptedSample,
      adoptedVersionId,
    } = await load();
    const paths = new Set(
      candidates.flatMap(({ changes }) => changes?.files.map(({ path }) => path) ?? []),
    );
    const parent = paths.size
      ? await readVersion(
          { ...env, CONSOLE_WORKSPACE: workspaceId, CONSOLE_BUNDLE: bundleId },
          { versionId: parentVersionId },
          fetcher,
        )
      : null;
    const parentFiles = parent?.ok
      ? parent.payload.files
          .filter(({ path }) => paths.has(path))
          .map(({ path, text }) => ({ path, text }))
      : null;
    return {
      ok: true as const,
      round: {
        id,
        number,
        channel,
        channelRevision,
        incumbentScore,
        candidates,
        decision,
        reason,
        selection,
        adoptedSample,
        adoptedVersionId,
      },
      parentFiles,
    };
  } catch {
    return { ok: false as const, message: 'Could not load this learning round.' };
  }
}

async function readMemory(
  api: AcclimateClient,
  { workspaceId, bundleId }: LearningScope,
  revision: string,
) {
  const number = revision === 'latest' ? undefined : Number(revision);
  if (number !== undefined && (!/^\d+$/.test(revision) || !Number.isSafeInteger(number)))
    return { ok: false as const, message: 'Enter a nonnegative memory revision.' };
  try {
    return {
      ok: true as const,
      memory: await api.getLearningMemory(workspaceId, bundleId, { revision: number }),
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      return { ok: false as const, message: 'This memory revision is unavailable.' };
    return { ok: false as const, message: 'Could not load improvement memory.' };
  }
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

export async function readLearningState(
  env: Environment,
  scope: LearningScope,
  fetcher = fetch,
  options: LearningReadOptions = {},
) {
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
    const editsEnabled = env.CONSOLE_ALLOW_EDITS === 'true';
    const canManage = workspace.role === 'admin' && editsEnabled;
    const canEditCases = ['admin', 'editor'].includes(workspace.role) && editsEnabled;
    const [loop, channels] = await Promise.all([
      inspect(api, scope),
      allPages((cursor) => api.listChannels(workspaceId, bundleId, { cursor, limit: 100 })),
    ]);
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
    const loadRound = (id: string) => api.getLearningRound(workspaceId, bundleId, id);
    const activeRead = activeId ? loadRound(activeId) : null;
    const detailId = options.round;
    const [active, detail, memory] = await Promise.all([
      activeRead,
      loop && detailId
        ? uuid.test(detailId)
          ? readRoundDetail(
              env,
              scope,
              () => (detailId === activeId && activeRead ? activeRead : loadRound(detailId)),
              fetcher,
            )
          : { ok: false as const, message: 'Invalid learning round ID.' }
        : null,
      loop && options.memory ? readMemory(api, scope, options.memory) : null,
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
    return {
      ok: true as const,
      bundleName: bundle.name,
      loop,
      canManage,
      canEditCases,
      detail,
      memory,
      channels: channels.map(({ name }) => name),
      rounds,
      activeEvaluation,
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
      case 'addCase':
      case 'retireCase': {
        let body;
        try {
          body = evolveCaseBody(command);
        } catch (error) {
          return { ok: false as const, message: (error as Error).message };
        }
        const receipt = await api.addLearningEvolveCases(workspaceId, bundleId, body, key);
        return { ok: true as const, receipt };
      }
      default:
        return { ok: false as const, message: 'Invalid learning action.' };
    }
    return { ok: true as const };
  } catch (error) {
    return failure(error, true);
  }
}
