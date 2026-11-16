import { closeOperation } from './exact-operation';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { requestEnvironment, storeSelection, scopedEnvironment } from './selection';
import {
  authorizeSelection,
  createSetup,
  listSetup,
  setupError,
  setupClient,
  setupFailure,
} from './setup';
export const readSetup = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('Cache-Control', 'private, no-store');
  return listSetup(await requestEnvironment());
});
export const readWorkspaceBundles = createServerFn({ method: 'GET' })
  .validator((input: { projectId: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    return listSetup(
      scopedEnvironment(await requestEnvironment(), { projectId: data.projectId }),
      fetch,
      true,
    );
  });
export const chooseWorkspace = createServerFn({ method: 'POST' })
  .validator((input: unknown) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    try {
      const env = await requestEnvironment();
      const selection = await authorizeSelection(env, data);
      storeSelection(env, selection);
      return { ok: true as const, selection };
    } catch (error) {
      return { ok: false as const, message: setupError(error) };
    }
  });
export const createWorkspaceContent = createServerFn({ method: 'POST' })
  .validator((input: Parameters<typeof createSetup>[1]) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    try {
      const env = await requestEnvironment();
      const result = await createSetup(env, data);
      storeSelection(env, {
        projectId: data.projectId,
        bundleId: result.bundle.id,
        channel: data.channel,
      });
      return {
        ok: true as const,
        selection: { projectId: data.projectId, bundleId: result.bundle.id, channel: data.channel },
      };
    } catch (error) {
      return setupFailure(error);
    }
  });

export const reconcileSetup = createServerFn({ method: 'POST' })
  .validator((input: { projectId: string; key: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    try {
      const env = await requestEnvironment();
      const operation = await setupClient(env).getOperation(data.projectId, data.key);
      if (operation.status === 'committed' && 'bundle' in operation.result) {
        const result = operation.result;
        storeSelection(env, {
          projectId: data.projectId,
          bundleId: result.bundle.id,
          channel: result.resolution.channel,
        });
        return {
          ok: true as const,
          committed: true,
          selection: {
            projectId: data.projectId,
            bundleId: result.bundle.id,
            channel: result.resolution.channel,
          },
        };
      }
      return { ok: true as const, committed: false, closed: operation.status === 'closed' };
    } catch (error) {
      return { ok: false as const, message: setupError(error) };
    }
  });

export const closeSetup = createServerFn({ method: 'POST' })
  .validator((input: { projectId: string; key: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    try {
      const env = await requestEnvironment();
      const operation = await closeOperation(
        scopedEnvironment(env, { projectId: data.projectId }),
        data,
      );
      return { ok: true as const, operation };
    } catch (error) {
      return { ok: false as const, message: setupError(error) };
    }
  });
