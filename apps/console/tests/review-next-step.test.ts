import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewNextStep } from '../src/lib/review-next-step';

test('reported evidence takes priority over active requests without promising a release', () => {
  const requests = [
    { status: 'running' as const, comparisonId: null },
    { status: 'completed' as const, comparisonId: 'comparison-one' },
  ];
  assert.match(reviewNextStep(requests, false, false), /^Reported evidence is available/);
  assert.equal(
    reviewNextStep(requests, true, false),
    'Inspect the reported evidence and its release eligibility below.',
  );
});

test('completed status without a comparison points to app logs, not evidence or approval', () => {
  assert.match(
    reviewNextStep([{ status: 'completed', comparisonId: null }], false, false),
    /No comparison was reported.*app logs/,
  );
});

test('active and requested handoffs keep execution with the application', () => {
  assert.match(
    reviewNextStep([{ status: 'running', comparisonId: null }], false, false),
    /last reported work running.*Check the app/,
  );
  assert.match(
    reviewNextStep([{ status: 'requested', comparisonId: null }], false, false),
    /Run the evaluator in your app.*frozen configuration/,
  );
});

test('an empty loaded page does not claim there are no older matching requests', () => {
  assert.match(reviewNextStep([], false, true), /Check older requests/);
  assert.match(reviewNextStep([], false, false), /^Review the saved changes/);
});
