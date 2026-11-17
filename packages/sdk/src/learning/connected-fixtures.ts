import { createHash } from 'node:crypto';
import { bindEvaluationRuntime, captureDefinition } from '../evaluation/definition.js';
import { canonicalEvaluationJson } from '../evaluation/manifest.js';
import type { EvaluationApp } from '../evaluation/types.js';
import type { EvaluationDescriptor, LearningEvaluationDescriptor } from '../types.js';

// The service reconstructs these two runtime entries from the registered descriptor.
const datasetKey = 'acclimate.fixtures.v1.dataset';
const inputsKey = 'acclimate.fixtures.v1.inputs';
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

function capture<I, E, O>(app: EvaluationApp<I, E, O>) {
  const installed = captureDefinition(app);
  const cases = installed.cases.map(({ caseId, input, expected, repetitions }) => ({
    caseId,
    input: hash(canonicalEvaluationJson(input)),
    expected: hash(canonicalEvaluationJson(expected)),
    repetitions: repetitions ?? 1,
  }));
  const datasetDigest = hash(canonicalEvaluationJson(cases));
  const caseFingerprints = cases.map((item) => item.input);
  const registration: LearningEvaluationDescriptor = {
    ...structuredClone(installed.descriptor),
    fixtureProtocol: 'installed-v1',
    datasetDigest,
    caseFingerprints,
  };
  const bound = bindEvaluationRuntime(app, {
    [datasetKey]: datasetDigest,
    [inputsKey]: hash([...caseFingerprints].sort().join('\n')),
  });
  return { registration, bound };
}

/** Register the frozen fixture values without sending the private inputs or expected answers. */
export function connectedEvaluationDescriptor<I, E, O>(
  app: EvaluationApp<I, E, O>,
): LearningEvaluationDescriptor {
  return capture(app).registration;
}

/** Capture the installed fixture bytes once per app when a committed assignment is received. */
export function connectedFixtureBindings<I, E, O>(apps: readonly EvaluationApp<I, E, O>[]) {
  let committed: EvaluationApp<I, E, O>[] | undefined;
  return (request: EvaluationDescriptor): readonly EvaluationApp<I, E, O>[] => {
    if (!Object.hasOwn(request.runtime, datasetKey) && !Object.hasOwn(request.runtime, inputsKey))
      return apps;
    return (committed ??= apps.map((app) => capture(app).bound));
  };
}
