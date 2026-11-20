import {
  requestEnvironment,
  bundleEnvironment,
  storeSelection,
  type BundleScope,
} from './selection';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';

export const readConsole = createServerFn({ method: 'GET' })
  .validator((input: { scope: BundleScope }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { readChannel } = await import('./channel');
    const env = bundleEnvironment(await requestEnvironment(), data.scope);
    const state = await readChannel(env);
    if (state.status === 'ready') storeSelection(env, data.scope);
    return state;
  });

export const readStoredVersion = createServerFn({ method: 'GET' })
  .validator((input: { versionId: string; scope: BundleScope }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { readVersion } = await import('./version-workflows');
    return readVersion(bundleEnvironment(await requestEnvironment(), data.scope), data);
  });

export const readReleaseHistory = createServerFn({ method: 'GET' })
  .validator((input: { beforeRevision: string; scope: BundleScope }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { readHistory } = await import('./version-workflows');
    return readHistory(bundleEnvironment(await requestEnvironment(), data.scope), data);
  });
