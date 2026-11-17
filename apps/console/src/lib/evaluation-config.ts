import type { BundlePayload, EvaluationDescriptor } from '@acclimate/sdk';
import {
  validateEvaluationDescriptor,
  evaluationDescriptorDifferences,
} from '@acclimate/sdk/validation';
import {
  localEvaluationDescriptor,
  presenceDescriptor,
  nativeReviewDescriptor,
} from './evaluation-presets.js';

export const evaluationPresets = {
  'payment-retry': localEvaluationDescriptor,
  'presence-contract': presenceDescriptor,
  'codex-luna-review': nativeReviewDescriptor,
} as const;
export type EvaluationPreset = keyof typeof evaluationPresets;
export type EvaluationChoice = EvaluationPreset | 'custom' | '';

/** Public intent only. Requests cannot load adapters, endpoints, code or credentials. */
export function evaluationConfiguration(value: unknown): EvaluationDescriptor {
  return validateEvaluationDescriptor(value);
}

export function selectedEvaluationConfiguration(
  choice: EvaluationChoice,
  publicJson: string,
): EvaluationDescriptor {
  if (!choice) throw new Error('Choose your app’s evaluator or an explicit example.');
  if (choice === 'custom') {
    let value: unknown;
    try {
      value = JSON.parse(publicJson);
    } catch {
      throw new Error('Paste the public JSON from your app’s describe command.');
    }
    return evaluationConfiguration(value);
  }
  return evaluationConfiguration(evaluationPresets[choice]);
}

/** This known example measures declarative policy, never an arbitrary instruction edit. */
export function paymentSimulatorIssue(payload: BundlePayload): string | undefined {
  const file = payload.files.find((item) => item.path === 'payment-policy.json');
  try {
    const value: unknown = file && JSON.parse(file.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    const policy = value as Record<string, unknown>;
    if (
      Object.keys(policy).sort().join(',') !== 'idempotency,maxAttempts' ||
      !Number.isInteger(policy.maxAttempts) ||
      Number(policy.maxAttempts) < 1 ||
      Number(policy.maxAttempts) > 3 ||
      !['request', 'attempt', 'none'].includes(String(policy.idempotency))
    )
      throw Error();
  } catch {
    return 'This example needs valid payment-policy.json data. Choose your app’s evaluator to measure instruction changes.';
  }
}

export function isPaymentSimulatorConfiguration(configuration: EvaluationDescriptor): boolean {
  return evaluationDescriptorDifferences(configuration, localEvaluationDescriptor).length === 0;
}

export function applicationEvaluatorRunCommand(
  configuration: EvaluationDescriptor,
  language: 'javascript' | 'python' = 'javascript',
) {
  const entry = language === 'python' ? 'python3 acclimate_eval.py' : 'node acclimate-eval.mjs';
  return `${entry} run --config /absolute/private/evaluator.json --handoff evaluation-request.json${configuration.runtime.execution === 'live' ? ' --live' : ''}`;
}

/** An app-owned public handoff: never credentials, a private path or an internal endpoint. */
export function evaluationHandoff(
  serviceUrl: string,
  projectId: string,
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
      projectId,
      bundleId,
      requestId,
      configuration: structuredClone({
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

/** Optional checkout setup example. Matching describes compatibility, never installed availability. */
export function includedEvaluatorSetupCommand(
  bundleId: string,
  requestId: string,
  descriptor: EvaluationDescriptor,
): string | null {
  if (
    ![bundleId, requestId].every((value) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value),
    )
  )
    return null;
  for (const [name, preset] of Object.entries(evaluationPresets)) {
    if (evaluationDescriptorDifferences(descriptor, preset).length) continue;
    const suffix = ` --adapter ${name}${name === 'codex-luna-review' ? ' --live' : ''}`;
    return `npm run evaluate:app -- --config /absolute/private/evaluator.json --bundleID ${bundleId} --requestID ${requestId}${suffix}`;
  }
  return null;
}
