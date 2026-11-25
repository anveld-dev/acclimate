/** Collect an internal listing without allowing cursor cycles or unbounded reads. */
export async function allPages<T>(
  read: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null | undefined }>,
  maxPages = 1000,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; ; pageNumber++) {
    if (pageNumber >= maxPages) throw new Error('Listing exceeds safe page limit');
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (!cursor) return items;
    if (seen.has(cursor)) throw new Error('Repeated listing cursor');
    seen.add(cursor);
  }
}
