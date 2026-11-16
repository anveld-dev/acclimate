import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluationVersionOptions } from '../src/lib/evaluation-version-options';

test('loaded versions count requests without treating a direct selection as another page', () => {
  const loaded = [
    { candidateVersionId: 'second' },
    { candidateVersionId: 'first' },
    { candidateVersionId: 'second' },
  ];
  assert.deepEqual(evaluationVersionOptions(loaded, 'outside'), {
    versions: [
      { id: 'second', count: 2 },
      { id: 'first', count: 1 },
    ],
    outside: 'outside',
  });
  assert.deepEqual(
    evaluationVersionOptions([...loaded, { candidateVersionId: 'outside' }], 'outside'),
    {
      versions: [
        { id: 'second', count: 2 },
        { id: 'first', count: 1 },
        { id: 'outside', count: 1 },
      ],
      outside: '',
    },
  );
  assert.deepEqual(evaluationVersionOptions([], ''), { versions: [], outside: '' });
  assert.deepEqual(evaluationVersionOptions([], 'unevaluated'), {
    versions: [],
    outside: 'unevaluated',
  });
});
