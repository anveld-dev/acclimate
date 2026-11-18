import type { loadApplication as load } from '@acclimate/sdk/evaluation/app-cli';

export type { ApplicationAdapter } from '@acclimate/sdk/evaluation';
export function loadApplication(): ReturnType<typeof load>;
export function main(argv?: string[]): Promise<number>;
