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
export const readLanding = createServerFn({ method: 'GET' })
  .validator((input: { legacy?: string; search?: Record<string, unknown> }) => input)
  .handler(async ({ data }) => {
    const [{ setResponseHeader }, { requestEnvironment }, { landingState }] = await Promise.all([
      import('@tanstack/react-start/server'),
      import('./selection'),
      import('./navigation-core'),
    ]);
    setResponseHeader('Cache-Control', 'private, no-store');
    return landingState(await requestEnvironment(), data);
  });
