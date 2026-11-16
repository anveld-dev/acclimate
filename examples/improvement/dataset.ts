// Saved application-selected snapshots; expected answers live only in grader.ts.
export const datasetRevision = 'retry-review-snapshots-v1';
export const cases: Array<{
  caseId: string;
  snapshot: { diff: string };
  settings: Record<string, never>;
}> = [
  {
    caseId: 'checkout-retry',
    snapshot: {
      diff: 'async function checkout(requestId, amount) { return retry(() => chargeCard({ amount })); }',
    },
    settings: {},
  },
  {
    caseId: 'checkout-keyed',
    snapshot: {
      diff: 'async function checkout(requestId, amount) { return retry(() => chargeCard({ amount, idempotencyKey: requestId })); }',
    },
    settings: {},
  },
];
