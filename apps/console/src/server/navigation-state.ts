import { createServerFn } from '@tanstack/react-start';
export type { NavigationState } from './navigation-core';
export const readNavigation = createServerFn({ method: 'GET' })
  .validator((input: { path: string }) => input)
  .handler(async ({ data }) => {
    const [{ setResponseHeader }, { requestEnvironment }, { navigationState }] = await Promise.all([
      import('@tanstack/react-start/server'),
      import('./selection'),
      import('./navigation-core'),
    ]);
    setResponseHeader('Cache-Control', 'private, no-store');
    return navigationState(await requestEnvironment(), data.path);
  });
