import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { CentralRequest } from '../lib/central-learning';
export const centralAction = createServerFn({ method: 'POST' })
  .validator((data: CentralRequest) => data)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { centralRequest } = await import('./central-core');
    const { requestEnvironment } = await import('./selection');
    return centralRequest(await requestEnvironment(), data);
  });
export async function learningRequest<T>(data: CentralRequest): Promise<T> {
  const result = await centralAction({ data });
  return JSON.parse(result || 'null');
}
