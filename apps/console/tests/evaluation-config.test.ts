import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluationConfiguration,
  evaluationPresets,
  evaluationHandoff,
  includedEvaluatorSetupCommand,
  selectedEvaluationConfiguration,
  paymentSimulatorIssue,
  applicationEvaluatorRunCommand,
} from '../src/lib/evaluation-config';

const bundle = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('compatible included profiles offer only explicit setup-required examples with a private config placeholder', () => {
  const native = evaluationConfiguration(evaluationPresets['codex-luna-review']);
  assert.equal(native.runtime.model, 'gpt-6-luna');
  assert.equal(native.expectedCases.length, 2);
  assert.match(
    includedEvaluatorSetupCommand(bundle, request, native)!,
    /^npm run evaluate:app -- --config \/absolute\/private\/evaluator.json /,
  );
  assert.match(
    includedEvaluatorSetupCommand(bundle, request, native)!,
    /--adapter codex-luna-review --live$/,
  );
  assert.match(
    includedEvaluatorSetupCommand(bundle, request, evaluationPresets['presence-contract'])!,
    /--adapter presence-contract$/,
  );
  native.runtime.maxTurns = '400';
  assert.equal(includedEvaluatorSetupCommand(bundle, request, native), null);
  assert.equal(
    includedEvaluatorSetupCommand('invalid; command', request, evaluationPresets['payment-retry']),
    null,
  );
});

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
  assert.equal(includedEvaluatorSetupCommand(bundle, request, frozen), null);
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
    evaluationHandoff(
      'https://api.example.test',
      'project',
      bundle,
      request,
      evaluationPresets['payment-retry'],
    ),
  );
  assert.deepEqual(handoff, {
    schemaVersion: 1,
    serviceUrl: 'https://api.example.test',
    projectId: 'project',
    bundleId: bundle,
    requestId: request,
    configuration: evaluationPresets['payment-retry'],
  });
  assert.equal('adapter' in handoff, false);
  assert.equal('evaluatorToken' in handoff, false);
  assert.equal('journalRoot' in handoff, false);
  for (const url of [
    'http://api.internal:3000',
    'https://user:secret@api.example.test',
    'https://api.example.test?token=secret',
  ])
    assert.throws(() =>
      evaluationHandoff(url, 'project', bundle, request, evaluationPresets['payment-retry']),
    );
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
  assert.deepEqual(handoff.configuration, legacy);
  assert.equal(includedEvaluatorSetupCommand(bundle, request, legacy), null);
});

test('new authoring starts with an explicit evaluator choice and actionable example prerequisites', () => {
  assert.throws(() => selectedEvaluationConfiguration('', ''), /Choose/);
  assert.throws(() => selectedEvaluationConfiguration('custom', '{bad'), /describe/);
  assert.equal(
    selectedEvaluationConfiguration('presence-contract', '').runtime.configId,
    'presence-contract',
  );
  assert.match(
    paymentSimulatorIssue({
      schemaVersion: 1,
      files: [{ path: 'AGENTS.md', kind: 'instruction', text: 'Review' }],
    })!,
    /payment-policy\.json/,
  );
  assert.equal(
    paymentSimulatorIssue({
      schemaVersion: 1,
      files: [
        {
          path: 'payment-policy.json',
          kind: 'memory',
          text: '{"maxAttempts":2,"idempotency":"request"}',
        },
      ],
    }),
    undefined,
  );
  assert.match(
    paymentSimulatorIssue({
      schemaVersion: 1,
      files: [
        {
          path: 'payment-policy.json',
          kind: 'memory',
          text: '{"maxAttempts":99,"idempotency":"request"}',
        },
      ],
    })!,
    /valid/,
  );
  assert.equal(
    applicationEvaluatorRunCommand(evaluationPresets['presence-contract']),
    'node acclimate-eval.mjs run --config /absolute/private/evaluator.json --handoff evaluation-request.json',
  );
  assert.match(
    applicationEvaluatorRunCommand({
      ...evaluationPresets['presence-contract'],
      runtime: { ...evaluationPresets['presence-contract'].runtime, execution: 'live' },
    }),
    / --live$/,
  );
});
