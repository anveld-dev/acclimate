import type { Evaluation } from '@acclimate/sdk';

/** Describe the available evidence, without treating app status as approval. */
export function reviewNextStep(
  requests: readonly Pick<Evaluation, 'status' | 'comparisonId'>[],
  selectedComparison: boolean,
  hasOlderRequests: boolean,
): string {
  if (selectedComparison) return 'Inspect the reported evidence and its release eligibility below.';
  if (requests.some((request) => request.comparisonId))
    return 'Reported evidence is available. Inspect a result before choosing a release.';
  if (requests.some((request) => request.status === 'running'))
    return 'Your app last reported work running. Check the app for its current status.';
  if (requests.some((request) => request.status === 'requested'))
    return 'A request is ready. Run the evaluator in your app with its request ID and frozen configuration.';
  if (requests.length)
    return 'No comparison was reported for these requests. Check request details and app logs before trying again.';
  if (hasOlderRequests)
    return 'No matching request is on this page. Check older requests or set up a new evaluation.';
  return 'Review the saved changes, then set up an evaluation to run in your app.';
}
