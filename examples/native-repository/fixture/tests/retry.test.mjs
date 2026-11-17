import assert from 'node:assert/strict';
import test from 'node:test';
import { retryKey } from '../src/retry.js';

test('a retry retains the request identity', () => {
  assert.equal(retryKey('payment-31', 1), retryKey('payment-31', 2));
});
