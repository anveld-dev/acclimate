import type { Comparison, EvaluationDescriptor } from '../types.js';
import { readCommandJson, readCommandText } from './cli-intents.js';
import { EvaluationUsageError, EXIT_CODES } from './errors.js';
import { parseEvaluationPolicy, type EvaluationPolicy } from './policy.js';
import { planEvaluation, PlanError } from './plan.js';

export const PLAN_USAGE =
  'plan --policy POLICY [--aa A_A_COMPARISON.json] [--effects 0,0.05] [--simulations N] [--seed N]';

/** `acclimate-eval plan --policy FILE [--aa FILE] [--effects 0,0.05] [--simulations N] [--seed N]` */
export async function planCommand(
  descriptor: EvaluationDescriptor,
  flags: Record<string, string | boolean>,
) {
  const text = (name: string) =>
    typeof flags[name] === 'string' ? (flags[name] as string) : undefined;
  const policyFile = text('policy');
  if (!policyFile)
    throw new EvaluationUsageError('usage.missing_flag', {
      field: '--policy',
      hint: PLAN_USAGE,
    });
  const integer = (name: string) => {
    const value = text(name);
    if (value === undefined) return undefined;
    if (!/^\d{1,10}$/.test(value))
      throw new EvaluationUsageError('usage.invalid_flag', {
        field: '--' + name,
        reason: 'Use a nonnegative integer.',
      });
    return Number(value);
  };
  const effects = text('effects')
    ?.split(',')
    .map((value) => {
      if (!/^-?\d+(\.\d+)?$/.test(value.trim()))
        throw new EvaluationUsageError('usage.invalid_flag', {
          field: '--effects',
          reason: 'Use comma-separated numbers, such as 0,0.05.',
        });
      return Number(value);
    });
  const { policy } = parseEvaluationPolicy(await readCommandText(policyFile), descriptor);
  const aa = text('aa');
  try {
    const plan = planEvaluation({
      policy,
      descriptor,
      ...(aa && { calibration: (await readCommandJson(aa, 64 * 1024 * 1024)) as Comparison }),
      ...(effects && { effects }),
      ...(integer('simulations') !== undefined && { simulations: integer('simulations') }),
      ...(integer('seed') !== undefined && { seed: integer('seed') }),
    });
    // Insufficient data for the declared inference is indeterminate, like the gate it predicts.
    return { status: plan.sufficient ? EXIT_CODES.ok : EXIT_CODES.indeterminate, result: plan };
  } catch (error) {
    if (error instanceof PlanError)
      throw new EvaluationUsageError('usage.invalid_flag', {
        field: aa ? '--aa' : '--effects',
        reason:
          'Use at most 16 effects within the metric scale, 0–5000 simulations, a seed below 2^32, and an A/A comparison with at least two cases.',
      });
    throw error;
  }
}

/** Doctor's policy summary: sufficiency, detectable effect and repetition warnings. No simulation. */
export function policyReadinessFor(policy: EvaluationPolicy, descriptor: EvaluationDescriptor) {
  const plan = planEvaluation({ policy, descriptor, simulations: 0, effects: [] });
  return {
    method: plan.method,
    confidence: plan.confidence,
    cases: plan.cases,
    repetitions: plan.repetitions,
    sufficient: plan.sufficient,
    minimumDetectableEffect: plan.minimumDetectableEffect,
    warnings: plan.warnings,
  };
}
