import { createHash } from 'node:crypto';

export const sourceModel = 'gpt-6-luna';
export const optimizerModel = 'gpt-6.2-astra';
export const optimizerReasoningEffort = 'high';
export const targetModel = 'gpt-6.2-sol';
export const taskEffort = 'low';

export interface ProxyIdentity {
  baseURL: string;
  revision: string;
  configSha256: string;
}

export function completionEndpoint(baseURL: string) {
  return baseURL + '/chat/completions';
}

export function proxyKey() {
  const key = process.env.SIM_PROXY_API_KEY;
  if (!key?.trim()) throw new IntegrityError('K1: SIM_PROXY_API_KEY is required');
  return key;
}

export const setting = (policyModel: string) => ({
  domain: 'cli-support',
  benchmark: 'llm-0.38-argv',
  policyModel,
});
export const conditions = {
  source: { start: 'baseline', model: sourceModel, continued: false },
  full: { start: 'source-final', model: targetModel, continued: true },
  transfer: { start: 'source-final', model: targetModel, continued: false },
  cold: { start: 'baseline', model: targetModel, continued: false },
} as const;
export type Condition = keyof typeof conditions;
export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

export function ordered<T>(items: readonly T[], ...seed: (string | number)[]): T[] {
  return items
    .map((item, index) => ({ item, key: sha256(JSON.stringify([...seed, index])) }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ item }) => item);
}

export class IntegrityError extends Error {}
