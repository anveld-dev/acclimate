import type { Comparison, EvaluationDescriptor } from '../types.js';
import { readCommandJson, readCommandText } from './cli-intents.js';
import { EvaluationError } from './errors.js';
import { parseEvaluationPolicy, type EvaluationPolicy } from './policy.js';
import { planEvaluation, PlanError } from './plan.js';

/** `acclimate-eval plan --policy FILE [--aa FILE] [--effects 0,0.05] [--simulations N] [--seed N]` */
export async function planCommand(
  descriptor: EvaluationDescriptor,
  flags: Record<string, string | boolean>,
) {
  const text = (name: string) =>
    typeof flags[name] === 'string' ? (flags[name] as string) : undefined;
  const policyFile = text('policy');
  if (!policyFile) throw new EvaluationError('config.schema');
  const integer = (name: string) => {
    const value = text(name);
    if (value === undefined) return undefined;
    if (!/^\d{1,10}$/.test(value)) throw new EvaluationError('config.schema');
    return Number(value);
  };
  const effects = text('effects')
    ?.split(',')
    .map((value) => {
      if (!/^-?\d+(\.\d+)?$/.test(value.trim())) throw new EvaluationError('config.schema');
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
    return { status: plan.sufficient ? 0 : 3, result: plan };
  } catch (error) {
    if (error instanceof PlanError) throw new EvaluationError('config.schema');
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
