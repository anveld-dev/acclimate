import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluationConfiguration,
  evaluationHandoff,
  applicationEvaluatorCommand,
  parseEvaluationConfiguration,
  isCheckoutCodexEvaluator,
  checkoutCodexRunCommand,
} from '../src/lib/evaluation-config';
import { appDescriptor } from './fixtures/app-evaluator';
import { nativeReviewDescriptor } from '../../../examples/evaluation/descriptor';

const bundle = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('custom public configuration is cloned without granting executable adapter loading', () => {
  const input = {
    datasetRevision: 'mine-v1',
    graderRevision: 'checks-v2',
    runtime: { configId: 'my-app', configRevision: '1', model: 'none' },
    expectedCases: [{ caseId: 'checkout', repetition: 0 }],
  };
  const frozen = evaluationConfiguration(input);
  input.runtime.configRevision = '2';
  input.expectedCases[0].caseId = 'changed';
  assert.equal(frozen.runtime.configRevision, '1');
  assert.equal(frozen.expectedCases[0].caseId, 'checkout');
  assert.equal(isCheckoutCodexEvaluator(frozen), false);
  for (const bad of [
    null,
    [],
    { ...input, adapterUrl: 'file:///tmp/code' },
    { ...input, runtime: {} },
    { ...input, expectedCases: [input.expectedCases[0], input.expectedCases[0]] },
    { ...input, expectedCases: [{ caseId: 'x', repetition: -1 }] },
  ]) {
    assert.throws(() => evaluationConfiguration(bad));
  }
});

test('default public handoff identifies the actual public API and exact request without runner authority', () => {
  const handoff = JSON.parse(
    evaluationHandoff('https://api.example.test', 'project', bundle, request, appDescriptor),
  );
  assert.deepEqual(handoff, {
    schemaVersion: 1,
    serviceUrl: 'https://api.example.test',
    workspaceId: 'project',
    bundleId: bundle,
    requestId: request,
    descriptor: appDescriptor,
  });
  assert.equal('adapter' in handoff, false);
  assert.equal('evaluatorToken' in handoff, false);
  assert.equal('journalRoot' in handoff, false);
  for (const url of [
    'http://api.internal:3000',
    'https://user:secret@api.example.test',
    'https://api.example.test?token=secret',
  ])
    assert.throws(() => evaluationHandoff(url, 'project', bundle, request, appDescriptor));
});

test('historical public configuration remains inspectable without inventing new adapter settings', () => {
  const legacy = {
    datasetRevision: 'old-data',
    graderRevision: 'old-grader',
    runtime: { model: 'none' },
    expectedCases: [{ caseId: 'old-case', repetition: 0 }],
  };
  const handoff = JSON.parse(
    evaluationHandoff('https://api.example.test', 'project', bundle, request, legacy),
  );
  assert.deepEqual(handoff.descriptor, legacy);
});

test('handoff commands follow the installed evaluator and require live opt-in where declared', () => {
  assert.throws(() => parseEvaluationConfiguration('{bad'), /describe/);
  assert.deepEqual(parseEvaluationConfiguration(JSON.stringify(appDescriptor)), appDescriptor);
  for (const [language, entry] of [
    ['javascript', 'npx --no-install acclimate-eval'],
    ['python', 'python -m acclimate'],
  ] as const) {
    assert.equal(applicationEvaluatorCommand(language, 'describe'), entry + ' describe');
    assert.equal(
      applicationEvaluatorCommand(language, 'compare', true),
      entry + ' compare --config /absolute/private/evaluator.json --handoff handoff.json --live',
    );
    assert.doesNotMatch(applicationEvaluatorCommand(language, 'compare'), /--live/);
    assert.match(
      applicationEvaluatorCommand(language, 'check'),
      /check .* --policy quality-policy.json$/,
    );
  }
  assert.equal(isCheckoutCodexEvaluator(nativeReviewDescriptor), true);
  assert.equal(
    isCheckoutCodexEvaluator({ ...nativeReviewDescriptor, graderRevision: 'different' }),
    false,
  );
  assert.match(checkoutCodexRunCommand(bundle, request)!, /--adapter codex-luna-review --live$/);
  assert.equal(checkoutCodexRunCommand(bundle, 'bad id'), undefined);
});
