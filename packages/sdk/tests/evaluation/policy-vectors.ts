import { readFileSync } from 'node:fs';

/** Expand the compact shared inference vectors into checkComparison inputs. */
const read = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../contracts/fixtures/evaluation-policy/${name}`, import.meta.url),
      'utf8',
    ),
  );
export const policyVectors = read('vectors.json');
export const inferenceVectors = read('inference-vectors.json');

type Reward = number | null | { taskFailed: number };
const outcome = (value: Reward) =>
  value === null
    ? {
        executionStatus: 'infrastructure_failed',
        gradingStatus: 'missing',
        reward: null,
        outputRef: null,
        error: 'execution_failed',
        usage: null,
      }
    : typeof value === 'object'
      ? {
          executionStatus: 'task_failed',
          gradingStatus: 'scored',
          reward: value.taskFailed,
          outputRef: null,
          error: null,
          usage: null,
        }
      : {
          executionStatus: 'completed',
          gradingStatus: 'scored',
          reward: value,
          outputRef: null,
          error: null,
          usage: null,
        };

export function expandInferenceVector(vector: any) {
  const { comparison, descriptor, binding, policy } = structuredClone(policyVectors.vectors[0]);
  delete policy.inference;
  comparison.results = vector.cases.flatMap(
    (item: { id: string; parent: Reward[]; candidate: Reward[] }) =>
      item.parent.map((parent, repetition) => ({
        caseId: item.id,
        repetition,
        parent: outcome(parent),
        candidate: outcome(item.candidate[repetition]),
      })),
  );
  descriptor.expectedCases = comparison.results.map(
    ({ caseId, repetition }: { caseId: string; repetition: number }) => ({ caseId, repetition }),
  );
  comparison.expectedCases = descriptor.expectedCases;
  return {
    comparison,
    expectedDescriptor: descriptor,
    expectedBinding: binding,
    policy: { ...policy, ...vector.policy },
    ...vector.options,
  };
}

export const summaryFields = [
  'parentMean',
  'candidateMean',
  'orientedMeanImprovement',
  'worstCaseRegression',
  'candidateTaskFailures',
  'protectedCandidateTaskFailures',
  'parentTaskFailures',
] as const;
