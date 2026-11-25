/** A 0 to 1 score as a percentage with at most one decimal, such as 98.7%. */
export function percent(score: number | null | undefined): string {
  if (score === null || score === undefined || Number.isNaN(score)) return 'Not scored';
  const value = Math.round(score * 1000) / 10;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

/** The first eight characters of a UUID or digest, for display beside a copy button. */
export function shortId(id: string): string {
  const bare = id.startsWith('sha256:') ? id.slice('sha256:'.length) : id;
  return bare.slice(0, 8);
}
