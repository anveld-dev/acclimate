import type { Release } from '@acclimate/sdk';

export function matchesRelease(item: Pick<Release, 'revision' | 'version'>, query: string) {
  const term = query.trim().toLowerCase();
  const explicitRevision = /^(?:revision\s+|#)(\d+)$/.exec(term);
  if (explicitRevision) return item.revision === explicitRevision[1];

  const digest = item.version.digest.toLowerCase();
  return (
    item.revision === term ||
    item.version.id.toLowerCase().startsWith(term) ||
    digest.startsWith(term) ||
    digest.replace(/^sha256:/, '').startsWith(term)
  );
}
