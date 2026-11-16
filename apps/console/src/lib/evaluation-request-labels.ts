import type { Evaluation } from '@acclimate/sdk';

/** Short visual IDs are display aids; actionable names retain the full identity. */
export function evaluationRequestLabels(
  request: Pick<Evaluation, 'id' | 'datasetRevision' | 'status'>,
  selected: boolean,
) {
  const identity = `${request.datasetRevision}, request ${request.id}`;
  return {
    details: `Details for ${identity} · ${request.status}`,
    inspect: `Inspect evidence for ${identity}${selected ? ' · Selected evidence' : ''}`,
  };
}
