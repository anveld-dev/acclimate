import type { Evaluation } from '@acclimate/sdk';

/** Short visual IDs are display aids; actionable names retain the full identity. */
export function evaluationRequestLabels(
  request: Pick<Evaluation, 'id' | 'datasetRevision' | 'status' | 'runName'>,
  selected: boolean,
) {
  const run = request.runName?.trim() ? `run ${request.runName.trim()}, ` : '';
  const identity = `${run}${request.datasetRevision}, request ${request.id}`;
  return {
    // The service records intent; this state says nothing about app preflight/readiness.
    status: request.status.charAt(0).toUpperCase() + request.status.slice(1),
    details: `Details for ${identity} · ${request.status}`,
    inspect: `Inspect evidence for ${identity}${selected ? ' · Selected evidence' : ''}`,
  };
}
