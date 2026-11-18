import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindEvaluationRepetitions, captureDefinition } from '../../src/evaluation/definition.js';
import { defineEvaluation } from '../../src/evaluation/index.js';
import { connectedEvaluationDescriptor } from '../../src/learning/index.js';
import { connectedFixtureBindings } from '../../src/learning/connected-fixtures.js';
import { evaluationDescriptorDifferences } from '../../src/validation.js';

function invoice(
  input = { status: 'paid' },
  expected = 'archive',
  repetitions = 1,
  caseId = 'invoice',
) {
  return defineEvaluation({
    configId: 'billing',
    configRevision: 'v1',
    datasetRevision: 'invoices',
    graderRevision: 'v1',
    execution: 'model-free',
    runtime: {},
    cases: [{ caseId, input, expected, repetitions }],
    async execute() {
      throw new Error('fixture callbacks should not run during binding');
    },
    async grade() {
      throw new Error('fixture callbacks should not run during binding');
    },
  });
}

test('connected commitments bind fixture values, labels and repetitions while detecting input aliases', () => {
  const app = invoice();
  const original = connectedEvaluationDescriptor(app);
  const changedAnswer = connectedEvaluationDescriptor(invoice(undefined, 'escalate'));
  const renamed = connectedEvaluationDescriptor(invoice(undefined, undefined, 1, 'alias'));
  const repeated = connectedEvaluationDescriptor(invoice(undefined, undefined, 2));
  assert.deepEqual(original, connectedEvaluationDescriptor(invoice()));
  for (const changed of [changedAnswer, renamed, repeated]) {
    assert.notEqual(original.datasetDigest, changed.datasetDigest);
    assert.deepEqual(original.caseFingerprints, changed.caseFingerprints);
  }
  const drift = invoice({ status: 'overdue' });
  assert.notDeepEqual(
    original.caseFingerprints,
    connectedEvaluationDescriptor(drift).caseFingerprints,
  );
  assert(!JSON.stringify(original).includes('archive'));
  assert(!JSON.stringify(original).includes('paid'));
  assert.equal(original.fixtureProtocol, 'installed-v1');
  // Stable installed-v1 vectors also guard persisted enrollments across SDK upgrades.
  assert.equal(
    original.datasetDigest,
    '00314db3c8cafe3991c1d237371899ebc2b555d9259a6eeb138d1ccb01300889',
  );
  assert.deepEqual(original.caseFingerprints, [
    '17edd1d1906a30242510fe2bbf1e58c7fd7b28debf7d8a5373ef3649d4dbae65',
  ]);

  // The ordinary descriptor remains usable by previously registered, manually reviewed requests.
  assert.equal(connectedFixtureBindings([app])(app.descriptor)[0], app);
  const enrollment = {
    ...original,
    runtime: {
      ...original.runtime,
      'acclimate.fixtures.v1.dataset': original.datasetDigest,
      'acclimate.fixtures.v1.inputs':
        '0b5c74939d2ab57293b9786b5101fbdf5e8fc086918e12aeae119d027c375fe3',
    },
  };
  const bound = connectedFixtureBindings([app])(enrollment)[0]!;
  assert.equal(bound.descriptor.runtime['acclimate.fixtures.v1.dataset'], original.datasetDigest);
  assert.deepEqual(
    evaluationDescriptorDifferences(
      bound.descriptor,
      connectedFixtureBindings([drift])(bound.descriptor)[0]!.descriptor,
    ),
    ['runtime'],
  );
  assert.deepEqual(evaluationDescriptorDifferences(enrollment, bound.descriptor), []);
  enrollment.runtime['acclimate.fixtures.v1.inputs'] = '0'.repeat(64);
  assert.deepEqual(evaluationDescriptorDifferences(enrollment, bound.descriptor), ['runtime']);
});

test('a planned inventory changes trial counts while retaining the installed fixture commitment', () => {
  const original = invoice();
  const captured = captureDefinition(original);
  const app = defineEvaluation({
    configId: 'billing',
    configRevision: 'v1',
    datasetRevision: 'invoices',
    graderRevision: 'v1',
    execution: captured.execution,
    runtime: {},
    cases: [
      ...captured.cases,
      { caseId: 'refund', input: { status: 'refunded' }, expected: 'archive' },
    ],
    execute: captured.execute,
    grade: captured.grade,
  });
  const registration = connectedEvaluationDescriptor(app);
  const bound = connectedFixtureBindings([app])({
    ...app.descriptor,
    runtime: {
      ...app.descriptor.runtime,
      'acclimate.fixtures.v1.dataset': registration.datasetDigest!,
    },
  })[0]!;
  const expectedCases = [
    ...bound.descriptor.expectedCases,
    { caseId: 'refund', repetition: 1 },
    { caseId: 'refund', repetition: 2 },
  ];
  const planned = bindEvaluationRepetitions(bound, expectedCases);
  assert.deepEqual(planned.descriptor.runtime, bound.descriptor.runtime);
  assert.deepEqual(planned.descriptor.expectedCases, expectedCases);
  assert.deepEqual(
    captureDefinition(planned).cases.map((item) => item.repetitions),
    [1, 3],
  );
  assert.deepEqual(connectedEvaluationDescriptor(app), registration);
  assert.equal(bindEvaluationRepetitions(bound, [...expectedCases, expectedCases[0]!]), bound);
  assert.equal(bindEvaluationRepetitions(bound, [{ caseId: 'unknown', repetition: 0 }]), bound);
});
