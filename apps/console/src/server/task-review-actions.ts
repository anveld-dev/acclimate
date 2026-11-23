import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { TaskReviewRequest } from '../lib/task-review';
export const taskReviewAction = createServerFn({ method: 'POST' })
  .validator((data: TaskReviewRequest) => data)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { taskReviewRequest } = await import('./task-review-core');
    const { requestEnvironment } = await import('./selection');
    try {
      return {
        ok: true as const,
        value: await taskReviewRequest(await requestEnvironment(), data),
      };
    } catch (e) {
      return {
        ok: false as const,
        message: e instanceof Error ? e.message : 'Task request failed.',
      };
    }
  });
export async function taskReviewRequest<T>(data: TaskReviewRequest): Promise<T> {
  const result = await taskReviewAction({ data });
  if (!result.ok) throw Error(result.message);
  return result.value as T;
}
