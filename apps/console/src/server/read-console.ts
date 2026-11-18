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

export const changeContent = createServerFn({ method: 'POST' })
  .validator((input: { scope: BundleScope } & Record<string, unknown>) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { editChannel } = await import('./edit-channel');
    return editChannel(bundleEnvironment(await requestEnvironment(), data.scope), data);
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

export const rollbackStoredVersion = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      versionId: string;
      expectedRevision: string;
      reason: string;
      key: string;
      scope: BundleScope;
    }) => input,
  )
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { editChannel } = await import('./edit-channel');
    return editChannel(bundleEnvironment(await requestEnvironment(), data.scope), {
      ...data,
      action: 'rollback',
    });
  });

// Internal audited release transport: the route is always derived from current explicit scope.
export const runReleaseOperation = createServerFn({ method: 'POST' })
  .validator((input: { scope: BundleScope; key: string; body: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { exactOperation } = await import('./exact-operation');
    const { ApiError } = await import('@acclimate/sdk');
    try {
      const env = bundleEnvironment(await requestEnvironment(), data.scope);
      if (env.CONSOLE_ALLOW_EDITS !== 'true')
        return { ok: false as const, message: 'Editing is disabled.', uncertain: false };
      const body = JSON.parse(data.body);
      if (
        typeof body.versionId !== 'string' ||
        typeof body.expectedRevision !== 'string' ||
        typeof body.unevaluatedReason !== 'string' ||
        !body.unevaluatedReason.trim() ||
        body.unevaluatedReason.length > 1100 ||
        Object.keys(body).some(
          (k) => !['versionId', 'expectedRevision', 'unevaluatedReason'].includes(k),
        )
      )
        return { ok: false as const, message: 'Invalid release request.', uncertain: false };
      const root = `/v1/workspaces/${encodeURIComponent(data.scope.projectId)}/bundles/${encodeURIComponent(data.scope.bundleId)}/channels/${encodeURIComponent(data.scope.channel)}/releases`;
      const promotion = await exactOperation<import('@acclimate/sdk').Release>(env, {
        projectId: data.scope.projectId,
        operationPath: root,
        key: data.key,
        body: data.body,
      });
      return { ok: true as const, promotion };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === 'revision_conflict')
        return {
          ok: false as const,
          message: 'The release changed since you opened this restore.',
          revisionChanged: true as const,
          uncertain: false,
        };
      return {
        ok: false as const,
        message: 'The release could not be confirmed. Reconcile or retry this exact operation.',
        // This endpoint also handles replay; an authorization denial cannot settle an earlier write.
        uncertain: true,
      };
    }
  });
export const reconcileReleaseOperation = createServerFn({ method: 'POST' })
  .validator((input: { scope: BundleScope; key: string; close?: boolean }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { lookupOperation, closeOperation } = await import('./exact-operation');
    try {
      const env = bundleEnvironment(await requestEnvironment(), data.scope);
      const operationPath = `/v1/workspaces/${encodeURIComponent(data.scope.projectId)}/bundles/${encodeURIComponent(data.scope.bundleId)}/channels/${encodeURIComponent(data.scope.channel)}/releases`;
      const operation = await (data.close ? closeOperation : lookupOperation)(env, {
        projectId: data.scope.projectId,
        operationPath,
        key: data.key,
      });
      return { ok: true as const, operation };
    } catch {
      return {
        ok: false as const,
        message: 'Recovery outcome unknown. Keep the operation pending.',
      };
    }
  });
