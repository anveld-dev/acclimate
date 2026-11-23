import { ApiError } from '@acclimate/sdk';
import { consoleClient } from './console-client';
import type { Environment } from './selection';
import type { CentralRequest } from '../lib/central-learning';
import { allPages } from './listing';

export async function centralRequest(env: Environment, data: CentralRequest, fetcher = fetch) {
  const api = consoleClient(env, fetcher);
  const ws = data.workspaceId;
  const bundle = data.bundleId ?? '';
  if (
    !['provider', 'loop', 'tasks', 'evidence', 'trial', 'progress', 'export', 'usage'].includes(
      data.action,
    ) &&
    env.CONSOLE_ALLOW_EDITS !== 'true'
  )
    throw Error('Console edits are disabled.');
  switch (data.action) {
    case 'loop':
      return api.getLearningLoop(ws, bundle);
    case 'provider':
      return api.getModelProvider(ws);
    case 'saveProvider':
      try {
        return await api.setModelProvider(ws, data.body);
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 403)
            throw Error('A workspace administrator must change the provider.');
          if (error.code === 'provider-unavailable')
            throw Error(
              'The service cannot store provider keys. Ask the operator to check the encryption key.',
            );
          if (error.code === 'invalid_content')
            throw Error('Check the provider settings. ' + error.message);
        }
        throw error;
      }
    case 'configure':
      return api.enrollLearningLoop(ws, bundle, data.body);
    case 'start':
      return api.startLearningLoop(ws, bundle);
    case 'stop':
      return api.stopLearningLoop(ws, bundle);
    case 'pause':
      return api.pauseLearningLoop(ws, bundle);
    case 'rollback': {
      const request = data.body;
      const round = await api.getLearningRound(ws, bundle, request.roundId);
      const head = await api.inspectSource(ws, bundle, round.channel);
      if (head?.version.id === round.parentVersionId)
        return { message: 'The previous version is already live. No rollback was needed.' };
      if (!round.adoptedVersionId || head?.version.id !== round.adoptedVersionId)
        throw Error('This round is no longer the current release. Refresh the channel history.');
      await api.rollbackLearningRound(ws, bundle, request);
      return {
        message: 'Rollback request completed. Check the release history for the resulting version.',
      };
    }
    case 'create':
      return api.createLearningTask(ws, bundle, data.body);
    case 'edit':
      return api.editLearningTask(ws, bundle, data.id, data.body);
    case 'retire':
      return api.retireLearningTask(ws, bundle, data.id);
    case 'try':
      return api.tryLearningTask(ws, bundle, data.id);
    case 'trial':
      return api.getLearningTrial(ws, bundle, data.id);
    case 'progress':
      return api.getLearningImport(ws, bundle, data.id);
    case 'evidence':
      return api.getLearningRound(ws, bundle, data.id, { evaluation: data.evaluation });
    case 'export':
      return api.exportHeldOutTasks(ws, bundle);
    case 'usage':
      return api.getLearningUsage(ws, bundle);
    case 'tasks':
      return allPages(async (after) => {
        const page = await api.listLearningTasks(ws, bundle, { after, limit: 100 });
        return { items: page.items, nextCursor: page.next };
      });
    case 'unblock':
      return api.unblockLearningVersion(ws, bundle, data.id);
    default:
      throw Error('Unknown learning action.');
  }
}
