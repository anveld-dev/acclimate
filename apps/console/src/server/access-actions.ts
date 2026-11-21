import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { AccessCommand } from './access-core';
export const readWorkspaceAccess = createServerFn({ method: 'GET' })
  .validator((input: { workspaceId: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { readWorkspaceAccessState } = await import('./access-core');
    return readWorkspaceAccessState(await requestEnvironment(), data.workspaceId);
  });
export const runAccessCommand = createServerFn({ method: 'POST' })
  .validator((input: AccessCommand) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { accessCommand } = await import('./access-core');
    return accessCommand(await requestEnvironment(), data);
  });

export const readWorkspaceMembers = createServerFn({ method: 'GET' })
  .validator((input: { workspaceId: string; cursor?: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { readMembershipPage } = await import('./access-core');
    return readMembershipPage(await requestEnvironment(), data.workspaceId, data.cursor);
  });
