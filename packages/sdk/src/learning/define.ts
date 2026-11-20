import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertJson } from '../evaluation/definition.js';
import { canonicalEvaluationJson } from '../evaluation/manifest.js';
import type { Json } from '../evaluation/types.js';
import type { LearningEvolveCase, LearningSetting } from '../types.js';
import { heldOutDigest } from './held-out.js';
import type { LearningLoopApp } from './loop.js';
import { caseIdPattern } from './outcomes.js';

export type LoopExecute<I = Json, O = unknown> = LearningLoopApp<I, unknown, O>['execute'];

export interface LoopAgent<I = Json, O = string> {
  model: string;
  execute: LoopExecute<I, O>;
}

export type LoopGrade<O, E> = (
  output: O,
  expected: E,
  context: { caseId: string; rollout: number; signal: AbortSignal },
) => number | { score: number; passed: boolean } | Promise<number | { score: number; passed: boolean }>;

export type LoopCase<I = Json, E = Json> = Omit<LearningEvolveCase<I, E>, 'caseId'> & {
  caseId?: string;
};

export type LoopConfig<I = Json, E = Json, O = unknown> = {
  bundle: string;
  channel: string;
  cases: string | readonly LoopCase<I, E>[];
  split?: number;
  grade: LoopGrade<NoInfer<O>, NoInfer<E>>;
  setting?: Partial<LearningSetting>;
  caseConcurrency?: number;
  live?: boolean;
} & (
  | { agent: LoopAgent<NoInfer<I>, O>; execute?: never }
  | { execute: LoopExecute<NoInfer<I>, O>; agent?: never }
);

export function defineLoop<I = Json, E = Json, O = unknown>(config: LoopConfig<I, E, O>): LoopConfig<I, E, O> {
  return config;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export async function loadLoop<I, E, O>(config: LoopConfig<I, E, O>, directory: string) {
  const { bundle, channel, agent, execute, grade, split = 0.5, caseConcurrency = 1 } = config;
  if (!bundle?.trim() || !channel?.trim() || typeof grade !== 'function' ||
      (agent ? typeof agent.execute !== 'function' || !!execute : typeof execute !== 'function'))
    throw new Error('Define a bundle, channel, grade and either an agent or execute callback.');
  if (!(split > 0 && split < 1) || !Number.isSafeInteger(caseConcurrency) || caseConcurrency < 1)
    throw new Error('Use a split between 0 and 1 and a positive integer caseConcurrency.');

  const filename = typeof config.cases === 'string' ? path.resolve(directory, config.cases) : undefined;
  let cases: unknown = config.cases;
  if (filename) {
    const extension = path.extname(filename);
    if (extension !== '.json' && extension !== '.jsonl')
      throw new Error('Use a .json or .jsonl cases file.');
    const text = await readFile(filename, 'utf8');
    try {
      cases = extension === '.json'
        ? JSON.parse(text)
        : text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    } catch {
      throw new Error('The cases file contains invalid JSON.');
    }
  }
  if (!Array.isArray(cases)) throw new Error('Cases must be an array.');
  const seen = new Set<string>();
  const heldOut: LearningEvolveCase<I, E>[] = [];
  const evolve: LearningEvolveCase[] = [];
  // Convert the binary64 threshold to the same integer scale as the full digest.
  const threshold = BigInt(Math.ceil(split * 2 ** 256));
  for (const entry of cases as LoopCase<I, E>[]) {
    if (!entry || typeof entry !== 'object') throw new Error('Each case needs input and expected.');
    const { input, expected } = entry;
    assertJson(input, 64 * 1024);
    assertJson(expected, 64 * 1024);
    const caseId = entry.caseId === undefined ? hash(canonicalEvaluationJson(input)) : entry.caseId;
    if (typeof caseId !== 'string' || !caseIdPattern.test(caseId) || caseId.startsWith('outcome:') || seen.has(caseId))
      throw new Error('Use unique case IDs of 1–128 letters, digits or ._:- characters without the outcome: prefix.');
    seen.add(caseId);
    const item = { caseId, input: structuredClone(input), expected: structuredClone(expected) };
    if (BigInt('0x' + hash(caseId)) < threshold) heldOut.push(item);
    else evolve.push(item);
  }
  if (!evolve.length || !heldOut.length || heldOut.length > 10_000)
    throw new Error('The split needs at least one evolve case and between 1 and 10,000 held-out cases.');

  const live = config.live ?? Boolean(agent);
  const setting = {
    domain: bundle,
    benchmark: filename ? path.basename(filename) : 'inline',
    policyModel: agent?.model ?? (live ? 'custom' : 'model-free'),
    ...config.setting,
  };
  if (Object.values(setting).some(value =>
    typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256))
    throw new Error('Each setting field must contain 1–256 bytes.');
  const app: LearningLoopApp<I, E, O> = {
    execution: live ? 'live' : 'model-free',
    heldOut,
    execute: agent ? agent.execute.bind(agent) : execute!,
    async grade({ output, expected, caseId, rollout, signal }) {
      const result = await grade(output, expected, { caseId, rollout, signal });
      return typeof result === 'number' ? { score: result, passed: result === 1 } : result;
    },
  };
  return {
    bundle, channel, evolve, app, live, setting, caseConcurrency,
    commitment: { digest: heldOutDigest(heldOut), cases: heldOut.length },
  };
}
