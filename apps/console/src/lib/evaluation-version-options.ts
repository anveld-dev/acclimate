/** Workspace only loaded requests into selector options; a direct selection is separate. */
export function evaluationVersionOptions(
  requests: ReadonlyArray<{ candidateVersionId: string }>,
  selectedCandidate: string,
) {
  const counts = new Map<string, number>();
  for (const request of requests) {
    counts.set(request.candidateVersionId, (counts.get(request.candidateVersionId) || 0) + 1);
  }
  return {
    versions: [...counts].map(([id, count]) => ({ id, count })),
    outside: selectedCandidate && !counts.has(selectedCandidate) ? selectedCandidate : '',
  };
}
