import { consoleClient } from './console-client';
import type { Environment } from './selection';
import type { ImportSummary, TaskReviewRequest } from '../lib/task-review';

export async function taskReviewRequest(
  env: Environment,
  data: TaskReviewRequest,
  fetcher = fetch,
) {
  const api = consoleClient(env, fetcher);
  const { workspaceId: ws, bundleId: bundle } = data;
  if (data.action !== 'imports' && env.CONSOLE_ALLOW_EDITS !== 'true')
    throw Error('Console edits are disabled.');
  switch (data.action) {
    case 'confirm':
      return api.confirmLearningTasks(ws, bundle, data.taskIds);
    case 'recheck':
      return api.recheckLearningTask(ws, bundle, data.id);
    case 'recheckAll':
      return api.recheckLearningTasks(ws, bundle, data.taskIds);
    case 'imports': {
      const page: { items: ImportSummary[] } | ImportSummary[] = await api.listLearningImports(
        ws,
        bundle,
      );
      return Array.isArray(page) ? page : page.items;
    }
    default:
      throw Error('Unknown task review action.');
  }
}
