/** Keep older pages in place while discovering new head rows. */
export function mergeHistory<T extends { id: string }>(
  previous: readonly T[],
  incoming: readonly T[],
  olderPage = false,
): T[] {
  const incomingById = new Map(incoming.map((row) => [row.id, row]));
  if (olderPage)
    return [
      ...previous.map((row) => incomingById.get(row.id) || row),
      ...incoming.filter((row) => !previous.some((old) => old.id === row.id)),
    ];
  return [...incoming, ...previous.filter((row) => !incomingById.has(row.id))];
}
/** Direct reads are independent of head pagination and bounded to four concurrent requests. */
export async function refreshKnownActive<T extends { id: string; status: string }>(
  rows: readonly T[],
  read: (id: string) => Promise<T | undefined>,
  isCurrent: () => boolean,
): Promise<T[]> {
  const active = rows.filter((row) => ['requested', 'queued', 'running'].includes(row.status));
  const refreshed: T[] = [];
  for (let offset = 0; offset < active.length && isCurrent(); offset += 4) {
    const result = await Promise.all(active.slice(offset, offset + 4).map((row) => read(row.id)));
    if (!isCurrent()) return [];
    for (const row of result) if (row) refreshed.push(row as T);
  }
  return refreshed;
}
