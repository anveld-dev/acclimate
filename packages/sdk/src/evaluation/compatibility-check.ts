import { compatibilityIssues, type CompatibilityIssue } from '../compatibility.js';
import type { BundlePayload, CompatibilityTarget } from '../types.js';
import { captureDefinition } from './definition.js';
import { EvaluationError } from './errors.js';
import type { EvaluationApp } from './types.js';

export interface PayloadCompatibility {
  /** The native harnesses the application declares. Empty when it declares none. */
  targets: readonly CompatibilityTarget[];
  issues: Array<CompatibilityIssue & { target: CompatibilityTarget }>;
}

/** Check a payload against every native harness the application declares. */
export function payloadCompatibility(
  app: EvaluationApp<any, any, any>,
  payload: BundlePayload,
): PayloadCompatibility {
  const targets = captureDefinition(app).compatibilityTargets ?? [];
  return {
    targets,
    issues: targets.flatMap((target) =>
      compatibilityIssues(payload, target).map((issue) => ({ ...issue, target })),
    ),
  };
}

/**
 * Fail before any request or callback when the payload breaks a declared harness rule. The
 * reason names each rule code, for example `[skill_metadata]`, and the file.
 */
export function assertPayloadCompatible(
  app: EvaluationApp<any, any, any>,
  payload: BundlePayload,
  flag: string,
): void {
  const { issues } = payloadCompatibility(app, payload);
  if (!issues.length) return;
  throw new EvaluationError('payload.incompatible', {
    field: flag,
    reason: issues
      .slice(0, 5)
      .map((issue) => `${issue.target} [${issue.code}] ${issue.path ?? ''} ${issue.message}`.replace(/\s+/g, ' '))
      .join('; '),
    hint: 'Fix the named files, or change compatibilityTarget if the application no longer prepares this harness.',
  });
}
