import type { EvaluationDescriptor } from '../../../../examples/evaluation/descriptor.js';
import { localEvaluationDescriptor, presenceDescriptor, nativeReviewDescriptor } from '../../../../examples/evaluation/descriptor.js';
import { assertInstalledConfiguration } from '../../../../examples/evaluation/adapter.js';

export const evaluationPresets = {
  'payment-retry': localEvaluationDescriptor,
  'presence-contract': presenceDescriptor,
  'codex-luna-review': nativeReviewDescriptor,
} as const;
export type EvaluationPreset = keyof typeof evaluationPresets;
const bytes = (value: string) => new TextEncoder().encode(value).length;
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && !!value.trim() && bytes(value) <= limit;
}

/** Public intent only. Requests cannot load adapters, endpoints, code or credentials. */
export function evaluationConfiguration(value: unknown): EvaluationDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Use an evaluation configuration object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['datasetRevision', 'graderRevision', 'runtime', 'expectedCases'].includes(key)) ||
      !text(input.datasetRevision, 1024) || !text(input.graderRevision, 1024))
    throw Error('Configuration needs bounded dataset and grader revisions, runtime and expectedCases.');
  if (!input.runtime || typeof input.runtime !== 'object' || Array.isArray(input.runtime))
    throw Error('Configuration runtime must be an object of public string settings.');
  const runtime = input.runtime as Record<string, unknown>;
  const entries = Object.entries(runtime);
  if (!entries.length || entries.length > 64 || entries.some(([key,value]) => !text(key,128) || !text(value,4096)) ||
      !text(runtime.configId,128) || !text(runtime.configRevision,1024))
    throw Error('Runtime needs configId, configRevision and bounded public string settings.');
  if (!Array.isArray(input.expectedCases) || !input.expectedCases.length || input.expectedCases.length > 1000)
    throw Error('Declare between 1 and 1000 case/repetition pairs.');
  const seen = new Set<string>();
  const expectedCases = input.expectedCases.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid case identity.');
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => key !== 'caseId' && key !== 'repetition') || !text(row.caseId,1024) ||
        typeof row.repetition !== 'number' || !Number.isInteger(row.repetition) || row.repetition < 0 || row.repetition > 0xffffffff)
      throw Error('Each case needs a bounded caseId and nonnegative integer repetition.');
    const key = JSON.stringify([row.caseId,row.repetition]);
    if (seen.has(key)) throw Error('Case/repetition pairs must be unique.');
    seen.add(key);
    return { caseId: row.caseId, repetition: row.repetition };
  });
  return { datasetRevision: input.datasetRevision, graderRevision: input.graderRevision,
    runtime: Object.fromEntries(entries) as Record<string,string>, expectedCases };
}

/** An app-owned public handoff: never credentials, a private path or an internal endpoint. */
export function evaluationHandoff(serviceUrl: string, projectId: string, bundleId: string, requestId: string, descriptor: EvaluationDescriptor): string {
  const url = new URL(serviceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw Error('Evaluation handoff requires the configured public HTTPS API URL.');
  // Existing service requests may predate configId/configRevision. Preserve their
  // exact public descriptor; the stricter authoring validator is for new requests.
  return JSON.stringify({ schemaVersion: 1, serviceUrl, projectId, bundleId, requestId,
    configuration: structuredClone({ datasetRevision: descriptor.datasetRevision, graderRevision: descriptor.graderRevision,
      runtime: descriptor.runtime, expectedCases: descriptor.expectedCases }) }, null, 2);
}

/** Optional checkout setup example. Matching describes compatibility, never installed availability. */
export function includedEvaluatorSetupCommand(bundleId: string, requestId: string, descriptor: EvaluationDescriptor): string | null {
  if (![bundleId,requestId].every(value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))) return null;
  for (const [name,preset] of Object.entries(evaluationPresets)) {
    try { assertInstalledConfiguration(descriptor,preset); }
    catch { continue; }
    const suffix = ` --adapter ${name}${name === 'codex-luna-review' ? ' --live' : ''}`;
    return `npm run evaluate:app -- --config /absolute/private/evaluator.json --bundleID ${bundleId} --requestID ${requestId}${suffix}`;
  }
  return null;
}
