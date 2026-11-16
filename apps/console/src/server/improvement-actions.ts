import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { BundleScope } from './selection';
export const runImprovement = createServerFn({ method: 'POST' })
  .validator((input: Record<string, unknown> & { scope: BundleScope }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const [{ improvement }, { requestEnvironment, bundleEnvironment }] = await Promise.all([
      import('./improvement'),
      import('./selection'),
    ]);
    return improvement(bundleEnvironment(await requestEnvironment(), data.scope), data);
  });
