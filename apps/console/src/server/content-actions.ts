import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { DraftCommand } from './drafts';
import type { BundleScope } from './selection';
export const runDraftCommand = createServerFn({ method: 'POST' })
  .validator((input: DraftCommand & { scope: BundleScope }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment, bundleEnvironment } = await import('./selection');
    const { draftCommand } = await import('./drafts');
    return draftCommand(bundleEnvironment(await requestEnvironment(), data.scope), data);
  });
