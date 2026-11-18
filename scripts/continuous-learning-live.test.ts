import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { LearningOperation } from '@acclimate/sdk/learning';
import { cohort, teaching } from '../examples/continuous-learning/domain.js';
import { liveBaseline, liveExecution } from '../examples/continuous-learning/live-domain.js';
import {
  groundedExecution,
  groundedPolicyPath,
  validateGroundedPolicy,
  type GroundedPolicy,
} from '../examples/continuous-learning/live-grounded.js';
import { callLiveModel, liveModelBudgetProfiles } from '../examples/continuous-learning/live-model.js';

const fixturePolicy = {
  version: 1,
  evidenceGuide: 'A processor posting receipt establishes completion.',
  actions: {
    completed: 'accept',
    'processor-outcome-unknown': 'reuse-original-key',
    'confirmed-before-processor': 'fresh-key',
  },
} satisfies GroundedPolicy;

test('grounded execution validates policy and abstains on unsupported or conflicting evidence', async () => {
  for (const malformed of [
    { ...fixturePolicy, version: 2 },
    { ...fixturePolicy, evidenceGuide: ' ' },
    { ...fixturePolicy, actions: { completed: 'accept' } },
    { ...fixturePolicy, actions: { ...fixturePolicy.actions, completed: 'charge' } },
    { ...fixturePolicy, expected: 'oracle' },
  ]) {
    assert.throws(() => validateGroundedPolicy(malformed), /Invalid grounded payment policy/);
  }
  const input = {
    signal: {
      observation: 'Audit reports processor posted successfully.',
      trace: 'Worker confirmed it stopped before send for this request.',
    },
    requestKey: 'example-new',
  };
  const noEvidence = { completion: null, delivery: null, preDispatch: null };
  for (const [evidence, reason] of [
    [noEvidence, 'unknown'],
    [{ ...noEvidence, completion: 'made up receipt' }, 'malformed'],
    [{ ...noEvidence, completion: '"made up receipt"' }, 'malformed'],
    [{ ...noEvidence, completion: '"processor posted' }, 'malformed'],
    [{ ...noEvidence, completion: '""processor posted""' }, 'malformed'],
    [{ ...noEvidence, completion: '" "' }, 'malformed'],
    [{ ...noEvidence, completion: ' ' }, 'malformed'],
    [{ ...noEvidence, action: 'accept' }, 'malformed'],
    [{ ...noEvidence, completion: 'processor posted', preDispatch: 'stopped before send' }, 'conflicting'],
  ] as const) {
    await assert.rejects(
      groundedExecution(fixturePolicy, input, async () => evidence),
      { name: 'GroundedAbstentionError', reason },
    );
  }
  assert.deepEqual(
    await groundedExecution(fixturePolicy, input, async () => ({
      ...noEvidence,
      preDispatch: '"stopped before send"',
    })),
    {
      output: { action: 'fresh-key', key: 'example-new-new' },
      classification: 'confirmed-before-processor',
    },
  );
});

test('grounded prompts include documentation only for the established interface', async () => {
  for (const transport of ['checkout', 'other']) {
    const prompts: string[] = [];
    await assert.rejects(groundedExecution(fixturePolicy, {
      requestKey: 'example', signal: { transport, httpStatus: 500 },
    }, async (prompt) => {
      prompts.push(prompt);
      return { completion: null, delivery: null, preDispatch: null };
    }), { reason: 'unknown' });
    assert.equal(prompts.length, 1);
    if (transport === 'checkout') {
      assert.match(prompts[0], /Established interface documentation v1 for checkout: httpStatus 200 reports a processor posting/);
      assert.doesNotMatch(prompts[0], /settlementCode/);
    } else {
      assert.doesNotMatch(prompts[0], /Established interface documentation v1/);
    }
  }
});

test('live proposals use Sol and simulated jobs use Luna at the Codex CLI boundary', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'acclimate-model-routing-'));
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  });
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(
    path.join(bin, 'codex'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const model = process.argv[process.argv.indexOf('--model') + 1];
const prompt = fs.readFileSync(0, 'utf8');
const proposal = prompt.startsWith('Author instructions');
if (model !== (proposal ? 'gpt-6.2-sol' : 'gpt-6-luna')) process.exit(1);
const grounded = prompt.startsWith('Extract evidence');
if (grounded && ['not-for-model', 'hidden-label', 'fresh-key', 'Decode checkout'].some((fragment) => prompt.includes(fragment))) process.exit(1);
const answer = proposal
  ? { retrySkill: null, reconciliationInstruction: null, reconciliationSkill: null, rationale: 'fixture' }
  : grounded
    ? { completion: null, delivery: 'processor acknowledged receipt', preDispatch: null }
    : { action: 'accept', key: 'fixture' };
for (const event of [
  { type: 'thread.started', thread_id: 'offline-fixture' },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } },
  { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5 } },
]) console.log(JSON.stringify(event));
`,
    { mode: 0o700 },
  );
  process.env.PATH = [bin, originalPath].join(path.delimiter);
  const output = path.join(root, 'evidence');
  const live = liveExecution(output);
  const operation = {
    id: 'fixture-proposal',
    admission: {},
    teaching: [teaching.reconcile],
    auditCohort: null,
  } as LearningOperation;
  const baseline = {
    payload: liveBaseline(),
    version: {
      id: 'baseline',
      bundleId: 'bundle',
      parentVersionId: null,
      digest: 'sha256:fixture',
      createdAt: '2026-01-01T00:00:00Z',
    },
    resolvedAt: 0,
    stale: false,
  };
  assert.equal(await live.propose(operation, baseline, true), undefined);
  const proposal = await live.propose(operation, baseline, false);
  assert.equal(proposal?.rationale, 'fixture');
  assert.deepEqual(await live.propose(operation, baseline, true), proposal);

  const incident = cohort('fixture')[0]!;
  const simulatedJobs = [
    'observation/qualification',
    'evaluation/development/baseline/job',
    'evaluation/development/candidate/job',
    'evaluation/audit/baseline/job',
    'evaluation/audit/candidate/job',
    'consumer/qualification/pinned/0',
    'consumer/qualification/fresh/0',
  ];
  for (const label of simulatedJobs) {
    assert.equal((await live.execute(baseline.payload, incident, label)).output.action, 'accept');
  }
  const groundedLabel = 'consumer/grounded';
  const grounded = {
    ...baseline.payload,
    files: [
      ...baseline.payload.files,
      { path: groundedPolicyPath, kind: 'instruction' as const, text: JSON.stringify(fixturePolicy) },
    ],
  };
  const groundedInput = {
    signal: { trace: 'processor acknowledged receipt' },
    requestKey: 'not-for-model',
    situation: 'hidden-label',
  };
  assert.deepEqual(
    (await live.execute(grounded, groundedInput, groundedLabel)).output,
    { action: 'reuse-original-key', key: 'not-for-model' },
  );
  await assert.rejects(live.propose(operation, { ...baseline, payload: grounded }, false),
    /does not support grounded payment policy/);

  const ledger = path.join(output, 'model-turns', 'model-calls');
  const attempts = [...live.modelAttempts];
  assert.equal(attempts.length, simulatedJobs.length + 2);
  assert.equal((await readdir(path.join(ledger, 'slots'))).length, attempts.length);
  for (const [label, attempt] of attempts) {
    const expected = label.startsWith('proposal/')
      ? { role: 'proposer', model: 'gpt-6.2-sol' }
      : { role: 'harness', model: 'gpt-6-luna' };
    const callId = createHash('sha256').update(label).digest('hex');
    for (const filename of ['request.json', 'result.json']) {
      const evidence = JSON.parse(
        await readFile(path.join(ledger, 'calls', callId, filename), 'utf8'),
      );
      assert.equal(evidence.role, expected.role);
      assert.equal(evidence.model, expected.model);
    }
    assert.equal(attempt.role, expected.role);
    assert.equal(attempt.model, expected.model);
    assert.equal(attempt.usage.inputTokens, 12);
    assert.equal(attempt.usage.outputTokens, 5);
  }

  const budgetProfile = 'repair-qualification-v1';
  const options = {
    appRoot: bin,
    artifactRoot: path.join(output, 'model-turns'),
    callId: 'budget-check',
    prompt: 'Author instructions',
    role: 'proposer' as const,
    maxCalls: liveModelBudgetProfiles[budgetProfile],
  };
  await assert.rejects(callLiveModel(options), /Invalid live model call budget/);
  await callLiveModel({ ...options, budgetProfile });
  const slots = await readdir(path.join(ledger, 'slots'));
  assert.equal(slots.length, attempts.length + 1);
});
