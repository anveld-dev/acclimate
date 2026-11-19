import type { Evaluation } from '@acclimate/sdk';

type Attempt = Pick<
  Evaluation,
  'id' | 'parentVersionId' | 'candidateDigest' | 'createdAt' | 'runName' | 'retryOf'
>;

/** The evaluator's own name for a run, such as the CLI `--name`, when it recorded one. */
export function runLabel(request: Pick<Evaluation, 'runName'> | undefined): string | undefined {
  const name = request?.runName?.trim();
  return name ? name : undefined;
}

/**
 * Keep the newest attempt at each parent and candidate content and nest the others under it.
 *
 * A retry saves the same candidate content as a new version, so its earlier attempts
 * would otherwise sit beside it as separate changes. Requests that name a `retryOf`
 * predecessor join that predecessor's group even if a later edit changed the parent.
 */
export function groupAttempts<T>(
  items: readonly T[],
  request: (item: T) => Attempt | undefined,
): { item: T; earlier: T[] }[] {
  const byRequest = new Map<string, T>();
  for (const item of items) {
    const value = request(item);
    if (value) byRequest.set(value.id, item);
  }
  const key = (item: T, seen = new Set<string>()): string | undefined => {
    const value = request(item);
    if (!value) return undefined;
    const prior = value.retryOf ? byRequest.get(value.retryOf) : undefined;
    if (prior !== undefined && prior !== item && !seen.has(value.id)) {
      seen.add(value.id);
      return key(prior, seen);
    }
    return `${value.parentVersionId}\u0000${value.candidateDigest}`;
  };
  const groups = new Map<string, T[]>();
  const result: { item: T; earlier: T[] }[] = [];
  for (const item of items) {
    const group = key(item);
    if (group === undefined) {
      result.push({ item, earlier: [] });
      continue;
    }
    const members = groups.get(group);
    if (members) members.push(item);
    else {
      const created = [item];
      groups.set(group, created);
      result.push({ item, earlier: created });
    }
  }
  const newestFirst = (a: T, b: T) =>
    Date.parse(request(b)!.createdAt) - Date.parse(request(a)!.createdAt);
  return result.map((entry) => {
    if (!request(entry.item)) return entry;
    const [latest, ...earlier] = [...entry.earlier].sort(newestFirst);
    return { item: latest, earlier };
  });
}
