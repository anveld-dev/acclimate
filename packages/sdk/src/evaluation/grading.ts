import type { EvaluationGradeResult, Json } from './types.js';

/**
 * Grader helpers that run inside your `grade` callback. They need no service support: the
 * aggregate becomes the scalar reward, and the per-call detail goes into `explanation` so a
 * review export or `observations` for analysis can carry it.
 */

/** A grade with optional named numeric components, for example correctness and citation quality. */
export interface ComponentGrade {
  reward: number;
  components?: Record<string, number>;
  explanation?: Json;
}

export interface RepeatedGradeOptions {
  /** Grader calls per output. 2 to 15. */
  repetitions: number;
  /** How to combine the rewards. Default `mean`; `majority` expects rewards of 0 or 1. */
  combine?: 'mean' | 'median' | 'majority';
}

export interface GradeAgreement {
  repetitions: number;
  /** Share of grader calls that agree with the combined reward (exact match). */
  agreement: number;
  /** Sample standard deviation of the rewards across calls. */
  sd: number;
  /** Smallest and largest reward across calls. */
  range: [number, number];
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function combine(values: number[], method: RepeatedGradeOptions['combine']): number {
  if (method === 'median') {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }
  if (method === 'majority') {
    if (!values.every((value) => value === 0 || value === 1))
      throw new RangeError('Majority grading needs rewards of 0 or 1');
    const ones = values.filter((value) => value === 1).length;
    if (ones * 2 === values.length) throw new RangeError('Use an odd number of grader calls');
    return ones * 2 > values.length ? 1 : 0;
  }
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Agreement of repeated grader calls around their combined reward. */
export function gradeAgreement(rewards: number[], combined: number): GradeAgreement {
  if (!Array.isArray(rewards) || rewards.length < 2 || !rewards.every(finite) || !finite(combined))
    throw new RangeError('Agreement needs at least two finite rewards');
  let total = 0;
  for (const value of rewards) total += value;
  const mean = total / rewards.length;
  let squares = 0;
  for (const value of rewards) squares += (value - mean) * (value - mean);
  return {
    repetitions: rewards.length,
    agreement: rewards.filter((value) => value === combined).length / rewards.length,
    sd: Math.sqrt(squares / (rewards.length - 1)),
    range: [Math.min(...rewards), Math.max(...rewards)],
  };
}

/**
 * Call a grader several times and combine the rewards. Components are averaged per name.
 * The result's `explanation` records every call and the agreement statistic.
 */
export async function repeatGrade(
  grade: () => Promise<ComponentGrade> | ComponentGrade,
  options: RepeatedGradeOptions,
): Promise<EvaluationGradeResult & { agreement: GradeAgreement }> {
  const repetitions = options.repetitions;
  if (!Number.isInteger(repetitions) || repetitions < 2 || repetitions > 15)
    throw new RangeError('repetitions must be an integer from 2 to 15');
  const calls: ComponentGrade[] = [];
  for (let index = 0; index < repetitions; index++) {
    const result = await grade();
    if (!result || !finite(result.reward)) throw new RangeError('Each grade needs a finite reward');
    if (result.components && !Object.values(result.components).every(finite))
      throw new RangeError('Grade components must be finite numbers');
    calls.push(result);
  }
  const rewards = calls.map((call) => call.reward);
  const reward = combine(rewards, options.combine ?? 'mean');
  const names = [...new Set(calls.flatMap((call) => Object.keys(call.components ?? {})))].sort();
  const components = Object.fromEntries(
    names.map((name) => {
      const values = calls.flatMap((call) =>
        call.components && name in call.components ? [call.components[name]] : [],
      );
      return [name, combine(values, 'mean')];
    }),
  );
  const agreement = gradeAgreement(rewards, reward);
  return {
    reward,
    agreement,
    explanation: {
      combine: options.combine ?? 'mean',
      rewards,
      ...(names.length && { components }),
      agreement: { ...agreement, range: [...agreement.range] },
      calls: calls.map((call) => call.explanation ?? null),
    } as Json,
  };
}

/**
 * Unbiased pass@k for one case from `n` attempts with `successes` passing attempts
 * (Chen et al. 2021): 1 - C(n - c, k) / C(n, k). Use it to turn repetitions of a binary reward
 * into the probability that at least one of k attempts passes.
 */
export function passAtK(n: number, successes: number, k: number): number {
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(successes) ||
    !Number.isInteger(k) ||
    n < 1 ||
    k < 1 ||
    k > n ||
    successes < 0 ||
    successes > n
  )
    throw new RangeError('pass@k needs integers with 1 <= k <= n and 0 <= successes <= n');
  if (n - successes < k) return 1;
  let failure = 1;
  for (let index = n - successes + 1; index <= n; index++) failure *= 1 - k / index;
  return 1 - failure;
}
