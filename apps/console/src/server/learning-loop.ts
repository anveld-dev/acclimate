import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { LearningCommand, LearningScope } from '../lib/learning';

export const readLearningLoop = createServerFn({ method: 'GET' })
  .validator((scope: LearningScope) => scope)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { readLearningState } = await import('./learning-core');
    return readLearningState(await requestEnvironment(), data);
  });

export const runLearningLoop = createServerFn({ method: 'POST' })
  .validator((input: { scope: LearningScope; command: LearningCommand }) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { runLearningCommand } = await import('./learning-core');
    return runLearningCommand(await requestEnvironment(), data.scope, data.command);
  });

export const readLearningChannel = createServerFn({ method: 'GET' })
  .validator((scope: LearningScope) => scope)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { readLearningBinding } = await import('./learning-core');
    return readLearningBinding(await requestEnvironment(), data);
  });
