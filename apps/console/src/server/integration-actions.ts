import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { ConnectionCommand, LearningRequest } from './integration-core';
export const readIntegrations = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('Cache-Control', 'private, no-store');
  const { requestEnvironment } = await import('./selection');
  const { readIntegrationState } = await import('./integration-core');
  return readIntegrationState(await requestEnvironment());
});
export const runIntegrationCommand = createServerFn({ method: 'POST' })
  .validator((input: ConnectionCommand) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { connectionCommand } = await import('./integration-core');
    return connectionCommand(await requestEnvironment(), data);
  });

export const readConnections = createServerFn({ method: 'GET' })
  .validator((input: { workspaceId: string; connectionId?: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { readConnectionsState } = await import('./integration-core');
    return readConnectionsState(await requestEnvironment(), data);
  });

export const runConnectionCommand = createServerFn({ method: 'POST' })
  .validator((input: ConnectionCommand) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { connectionCommand } = await import('./integration-core');
    return connectionCommand(await requestEnvironment(), data);
  });

export const readConnectionLearning = createServerFn({ method: 'GET' })
  .validator((input: Pick<LearningRequest, 'workspaceId' | 'connectionId'>) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { connectionLearning } = await import('./integration-core');
    return connectionLearning(await requestEnvironment(), { ...data, action: 'read' });
  });

export const runConnectionLearning = createServerFn({ method: 'POST' })
  .validator((input: Exclude<LearningRequest, { action: 'read' }>) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { connectionLearning } = await import('./integration-core');
    return connectionLearning(await requestEnvironment(), data);
  });

export const readLearningOutcome = createServerFn({ method: 'GET' })
  .validator((input: { workspaceId: string; connectionId: string; outcomeId: string }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { lookupLearningOutcome } = await import('./integration-core');
    return lookupLearningOutcome(await requestEnvironment(), data);
  });
