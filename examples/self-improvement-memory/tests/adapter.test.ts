import assert from 'node:assert/strict';
import test from 'node:test';
import { requestGuard, type OptimizerData } from '../adapter.js';
import { IntegrityError } from '../conditions.js';

const evolve = [{ caseId: 'cli-1', input: 'Shared input.', expected: 'a' }];
const held = [
  { caseId: 'h-87654321', input: 'Private  Input.', expected: 'b' },
  { caseId: 'h-12345678', input: 'Shared input.', expected: 'a' },
];
const clean: OptimizerData = {
  setting: { policyModel: 'fixture' },
  harness: { files: [] },
  feedback: { cases: evolve },
  history: [],
  improvementMemory: { problems: [] },
};
const check = requestGuard(evolve, held, ['B', 'fixture-1234']);
test('K1 admits only the fenced keys for each optimizer kind and allows shared evolve input', () => {
  check('propose', clean);
  check('propose', { ...clean, parserError: 'Retry formatting.' });
  check('screen', { ...clean, candidates: [] });
  check('select', { ...clean, candidates: [] });
  assert.throws(() => check('propose', { ...clean, candidates: [] }), IntegrityError);
  assert.throws(
    () => check('screen', { ...clean, candidates: [], parserError: 'Unexpected' }),
    IntegrityError,
  );
  assert.throws(
    () => check('select', { ...clean, candidates: [], unexplained: [] } as OptimizerData),
    IntegrityError,
  );
});
test('K1 refuses held-out IDs, normalized private inputs, condition codes and bundle names', () => {
  for (const text of ['h-87654321', 'prefix PRIVATE input. suffix', 'B', 'fixture-1234']) {
    assert.throws(() => check('propose', { ...clean, history: [{ text }] }), IntegrityError);
  }
});
