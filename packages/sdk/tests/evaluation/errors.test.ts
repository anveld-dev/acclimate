import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AcclimateError,
  AcclimateUsageError,
  AppSetupError,
  CallbackCancelled,
  DefinitionError,
  EvaluationBusyError,
  EvaluationError,
  EvaluationUsageError,
  EvaluatorConfigError,
  ExecutionUncertainError,
  OutputValidationError,
  PolicyError,
  AnalysisError,
  TransportError,
  defineEvaluation,
  exitCodeFor,
  toSafeDiagnostic,
  type EvaluationDefinition,
  type ExecuteInput,
} from '../../src/evaluation/index.js';
import { AcclimateClient, ApiError, DeliveryError, TaskExecutionError } from '../../src/index.js';
import { ERROR_CODES_PAGE, renderedPage } from '../../../../scripts/error-codes.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../contracts/fixtures/evaluation-errors/definition-mistakes.json', import.meta.url),
    'utf8',
  ),
) as { mistakes: Array<{ mistake: string; code: string; typescript: string }> };

function base(): EvaluationDefinition<unknown, unknown, unknown> {
  return {
    configId: 'errors',
    configRevision: '1',
    datasetRevision: '1',
    graderRevision: '1',
    runtime: { model: 'none' },
    execution: 'model-free',
    cases: [
      { caseId: 'a', input: { task: 1 }, expected: 1 },
      { caseId: 'b', input: { task: 2 }, expected: 2 },
    ],
    execute: () => ({ output: 1 }),
    grade: () => ({ reward: 1 }),
  };
}
const mistakes: Record<string, (d: any) => void> = {
  missing_grade: (d) => delete d.grade,
  misspelled_execution: (d) => (d.execution = 'modelfree'),
  empty_cases: (d) => (d.cases = []),
  duplicate_case_id: (d) => (d.cases[1].caseId = 'a'),
  blank_case_id: (d) => (d.cases[0].caseId = ' '),
  zero_repetitions: (d) => (d.cases[0].repetitions = 0),
  date_in_input: (d) => (d.cases[0].input = { when: new Date(0) }),
  empty_config_id: (d) => (d.configId = ''),
  reserved_runtime_key: (d) => (d.runtime = { configId: 'x' }),
  non_string_runtime_value: (d) => (d.runtime = { model: 3 }),
};

test('every definition mistake in the shared fixture names its field with the shared code', () => {
  assert.deepEqual(Object.keys(mistakes).sort(), fixture.mistakes.map((m) => m.mistake).sort());
  for (const expected of fixture.mistakes) {
    const definition = base();
    mistakes[expected.mistake](definition);
    assert.throws(
      () => defineEvaluation(definition as never),
      (error: unknown) => {
        assert.ok(error instanceof DefinitionError, expected.mistake);
        assert.equal(error.code, expected.code, expected.mistake);
        assert.equal(error.field, expected.typescript, expected.mistake);
        assert.equal(error.diagnostic.field, expected.typescript);
        assert.ok(error.reason.length > 0);
        assert.doesNotMatch(error.message, /not confirmed/);
        return true;
      },
    );
  }
});

test('the error-code reference page matches the SDK catalog', () => {
  const current = readFileSync(ERROR_CODES_PAGE, 'utf8');
  assert.equal(
    renderedPage(current),
    current,
    'Run npx tsx scripts/error-codes.ts --write to regenerate the error-code reference.',
  );
});

test('only TransportError is classified as an outage; usage and user bugs are not', () => {
  const unreachable = new TransportError('http://127.0.0.1:9', new TypeError('fetch failed'));
  const outage = toSafeDiagnostic(unreachable, 'preflight');
  assert.equal(outage.code, 'service.unavailable');
  assert.equal(outage.nextAction, 'check_service');
  assert.equal(outage.serviceUrl, 'http://127.0.0.1:9');
  assert.match(outage.hint!, /Check that the Acclimate service is running/);
  assert.equal(exitCodeFor(outage), 4);

  let bug: unknown;
  try {
    // A user bug such as reading a property of null must not look like an outage.
    bug = (JSON.parse('null') as { x: number }).x;
  } catch (error) {
    bug = error;
  }
  assert.ok(bug instanceof TypeError);
  assert.equal(toSafeDiagnostic(bug).code, 'internal.error');
  assert.equal(toSafeDiagnostic(new AcclimateUsageError('bad', 'baseUrl')).code, 'internal.error');
  assert.equal(toSafeDiagnostic(new AcclimateUsageError('bad', 'baseUrl')).field, 'baseUrl');
  const output = toSafeDiagnostic(new OutputValidationError('output.when', 'Convert Date.'));
  assert.equal(output.code, 'output.invalid');
  // Execution state still wins: an unknown error after callbacks started is uncertain.
  assert.equal(toSafeDiagnostic(bug, 'execute', 'may_have_started').code, 'execution.uncertain');
  assert.equal(exitCodeFor({ code: 'config.schema', executionState: 'report_saved' }), 5);
});

test('client argument checks raise AcclimateUsageError naming the argument', () => {
  assert.throws(
    () => new AcclimateClient({ baseUrl: 'https://x.test', token: '', scope: 's' }),
    (error: unknown) => error instanceof AcclimateUsageError && error.field === 'token',
  );
  assert.throws(
    () => new AcclimateClient({ baseUrl: 'not a url', token: 't', scope: 's' }),
    (error: unknown) => error instanceof AcclimateUsageError && error.field === 'baseUrl',
  );
  assert.throws(
    () => new AcclimateClient({ baseUrl: 'https://x.test', token: 't', scope: 's', retries: 9 }),
    (error: unknown) => error instanceof AcclimateUsageError && error.field === 'retries',
  );
});

test('the client wraps network failures in TransportError and keeps the cause', async () => {
  const cause = new TypeError('fetch failed');
  const client = new AcclimateClient({
    baseUrl: 'http://127.0.0.1:9',
    token: 't',
    scope: 's',
    fetch: async () => {
      throw cause;
    },
  });
  await assert.rejects(client.getEvaluationCapabilities('p'), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.code, 'transport.unreachable');
    assert.equal(error.serviceUrl, 'http://127.0.0.1:9');
    assert.equal(error.cause, cause);
    return true;
  });
});

test('every thrown SDK error class shares the AcclimateError base and a string code', () => {
  const instances: AcclimateError[] = [
    new ApiError(404, 'not_found', 'missing', 'r'),
    new DeliveryError('invalid_payload', 'bad'),
    new AcclimateUsageError('bad'),
    new TransportError('https://x.test', new Error('down')),
    new EvaluationError('config.schema'),
    new ExecutionUncertainError(),
    new OutputValidationError('output', 'bad'),
    new DefinitionError('cases', 'bad'),
    new AppSetupError('bad'),
    new EvaluationUsageError('usage.unknown_flag'),
    new EvaluatorConfigError('config.missing'),
    new EvaluationBusyError(),
    new PolicyError('policy.invalid', [], { field: 'metric.directon', reason: 'Unknown field.' }),
    new AnalysisError('analysis.invalid_config'),
    new TaskExecutionError(),
  ];
  for (const error of instances) {
    assert.ok(error instanceof AcclimateError, error.name);
    assert.equal(typeof error.code, 'string');
  }
  const policy = instances.find((error) => error instanceof PolicyError) as PolicyError;
  assert.ok(policy instanceof EvaluationError);
  assert.equal(policy.diagnostic.field, 'metric.directon');
  assert.match(policy.message, /metric\.directon/);
  assert.ok(!((new CallbackCancelled() as unknown) instanceof AcclimateError));
});

test('execute input exposes the bundle instructions, skills and memory files', async () => {
  const seen: Array<Pick<ExecuteInput, 'instructions' | 'skillFiles' | 'memoryFiles'>> = [];
  const { captureDefinition } = await import('../../src/evaluation/definition.js');
  const app = defineEvaluation({
    ...base(),
    execute: (run) => {
      seen.push({ instructions: run.instructions, skillFiles: run.skillFiles, memoryFiles: run.memoryFiles });
      return { output: 1 };
    },
  });
  await captureDefinition(app).execute({
    version: {
      version: {} as never,
      payload: {
        schemaVersion: 1,
        files: [
          { path: 'AGENTS.md', kind: 'instruction', text: 'Be brief.' },
          { path: 'skills/a.md', kind: 'skill', text: 'skill' },
          { path: 'more.md', kind: 'instruction', text: 'Cite sources.' },
          { path: 'memory.md', kind: 'memory', text: 'remember' },
        ],
      },
      resolvedAt: 0,
      stale: false,
    },
    caseId: 'a',
    repetition: 0,
    input: null,
    signal: new AbortController().signal,
    context: {} as never,
  });
  assert.equal(seen[0].instructions, 'Be brief.\n\nCite sources.');
  assert.deepEqual(seen[0].skillFiles.map((file) => file.path), ['skills/a.md']);
  assert.deepEqual(seen[0].memoryFiles.map((file) => file.path), ['memory.md']);
});
