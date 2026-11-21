import { OutputValidationError } from './errors.js';
import type { Usage } from './types.js';

const usageKeys = ['inputTokens', 'outputTokens', 'costUsd'] as const;
/** Validate reported usage. Malformed usage is an output error, never silently dropped. */
export function reportedUsage(value: unknown): Usage | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new OutputValidationError('usage', 'Return usage as { inputTokens, outputTokens, costUsd }.');
  const unknown = Object.keys(value).find((key) => !(usageKeys as readonly string[]).includes(key));
  if (unknown)
    throw new OutputValidationError(
      `usage.${unknown.slice(0, 64)}`,
      'Unknown usage key. Use inputTokens, outputTokens and costUsd.',
    );
  const result: Usage = {};
  for (const key of usageKeys) {
    const n = (value as Record<string, unknown>)[key];
    if (n !== undefined) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
        throw new OutputValidationError(`usage.${key}`, 'Use a finite, nonnegative number.');
      result[key] = n;
    }
  }
  return result;
}
