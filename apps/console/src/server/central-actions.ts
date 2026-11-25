import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { CentralRequest } from '../lib/central-learning';
export const centralAction = createServerFn({ method: 'POST' })
  .validator((data: CentralRequest) => data)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { centralRequest } = await import('./central-core');
    const { requestEnvironment } = await import('./selection');
    try {
      return {
        ok: true as const,
        value: await centralRequest(await requestEnvironment(), data),
      };
    } catch (e) {
      return {
        ok: false as const,
        message: e instanceof Error ? e.message : 'Learning request failed.',
      };
    }
  });
export async function learningRequest<T>(data: CentralRequest): Promise<T> {
  const result = await centralAction({ data });
  if (!result.ok) throw Error(result.message);
  return result.value as T;
}
