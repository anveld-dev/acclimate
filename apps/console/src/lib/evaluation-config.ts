import type { EvaluationDescriptor } from '@acclimate/sdk';
import { nativeReviewDescriptor } from '../../../../examples/evaluation/descriptor';
import {
  evaluationDescriptorDifferences,
  validateEvaluationDescriptor,
} from '@acclimate/sdk/validation';

export function evaluationConfiguration(value: unknown): EvaluationDescriptor {
  return validateEvaluationDescriptor(value);
}

export function parseEvaluationConfiguration(publicJson: string): EvaluationDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(publicJson);
  } catch {
    throw new Error('Paste the public JSON from your app’s describe command.');
  }
  return evaluationConfiguration(value);
}

export type EvaluatorLanguage = 'javascript' | 'python';

export function applicationEvaluatorCommand(
  language: EvaluatorLanguage,
  command: 'describe' | 'doctor' | 'compare' | 'check',
  live = false,
) {
  const entry = language === 'python' ? 'python -m acclimate' : 'npx --no-install acclimate-eval';
  if (command === 'describe') return entry + ' describe';
  const args = '--config /absolute/private/evaluator.json --handoff handoff.json';
  const extra =
    command === 'compare' && live
      ? ' --live'
      : command === 'check'
        ? ' --policy quality-policy.json'
        : '';
  return `${entry} ${command} ${args}${extra}`;
}

/** Match the full installed native definition before offering its checkout-specific command. */
export function isCheckoutCodexEvaluator(configuration: EvaluationDescriptor): boolean {
  return evaluationDescriptorDifferences(configuration, nativeReviewDescriptor).length === 0;
}

export function checkoutCodexRunCommand(bundleId: string, requestId: string): string | undefined {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!uuid.test(bundleId) || !uuid.test(requestId)) return;
  return `npm run evaluate:app -- --config /absolute/private/evaluator.json --bundleID ${bundleId} --requestID ${requestId} --adapter codex-luna-review --live`;
}

export const checkoutCodexCheckCommand =
  'npm run --silent evaluate:app -- check --config /absolute/private/evaluator.json --handoff handoff.json --policy quality-policy.json';

/** An app-owned public handoff: never credentials, a private path or an internal endpoint. */
export function evaluationHandoff(
  serviceUrl: string,
  workspaceId: string,
  bundleId: string,
  requestId: string,
  descriptor: EvaluationDescriptor,
): string {
  const url = new URL(serviceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw Error('Evaluation handoff requires the configured public HTTPS API URL.');
  // Existing service requests may predate configId/configRevision. Preserve their
  // exact public descriptor; the stricter authoring validator is for new requests.
  return JSON.stringify(
    {
      schemaVersion: 1,
      serviceUrl,
      workspaceId,
      bundleId,
      requestId,
      descriptor: structuredClone({
        datasetRevision: descriptor.datasetRevision,
        graderRevision: descriptor.graderRevision,
        runtime: descriptor.runtime,
        expectedCases: descriptor.expectedCases,
      }),
    },
    null,
    2,
  );
}
