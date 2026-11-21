import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gradeAgreement, passAtK, repeatGrade } from '../../src/evaluation/grading.js';

const vectors = JSON.parse(
  readFileSync(
    new URL('./fixtures/grading.json', import.meta.url),
    'utf8',
  ),
);

test('pass@k matches the unbiased estimator and the shared vectors', () => {
  for (const { n, successes, k, value } of vectors.passAtK)
    assert.ok(Math.abs(passAtK(n, successes, k) - value) < 1e-12, `${n} ${successes} ${k}`);
  assert.equal(passAtK(5, 0, 3), 0);
  assert.equal(passAtK(5, 3, 3), 1);
  assert.throws(() => passAtK(3, 1, 4), RangeError);
});

test('repeated grading combines rewards and components and reports agreement', async () => {
  for (const vector of vectors.repeatGrade) {
    let call = 0;
    const result = await repeatGrade(() => vector.calls[call++], {
      repetitions: vector.calls.length,
      combine: vector.combine,
    });
    assert.deepEqual({ reward: result.reward, agreement: result.agreement }, vector.expected);
    if (vector.components)
      assert.deepEqual((result.explanation as any).components, vector.components);
  }
  await assert.rejects(
    repeatGrade(() => ({ reward: NaN }), { repetitions: 2 }),
    RangeError,
  );
  let tie = 0;
  await assert.rejects(
    repeatGrade(() => ({ reward: tie++ % 2 }), { repetitions: 2, combine: 'majority' }),
    RangeError,
  );
  assert.throws(() => gradeAgreement([1], 1), RangeError);
});
