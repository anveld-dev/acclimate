import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import type { LearningReadOptions, LearningScope } from '../lib/learning';

export const readLearningLoop = createServerFn({ method: 'GET' })
  .validator((input: LearningScope & LearningReadOptions) => input)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { readLearningState } = await import('./learning-core');
    return readLearningState(await requestEnvironment(), data, fetch, data);
  });

export const readLearningChannel = createServerFn({ method: 'GET' })
  .validator((scope: LearningScope) => scope)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const { requestEnvironment } = await import('./selection');
    const { readLearningBinding } = await import('./learning-core');
    return readLearningBinding(await requestEnvironment(), data);
  });
