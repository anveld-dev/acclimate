import test from 'node:test';
import assert from 'node:assert/strict';
import { withNativeSessionInputs } from '../examples/native-session-lifetime.js';
import { ExecutionUncertainError } from '../examples/native-session-lifetime.js';

test('native session inputs survive an unconfirmed SDK failure and expose only a safe uncertainty', async () => {
  let cleaned = 0;
  await assert.rejects(
    withNativeSessionInputs(
      {
        cleanup: async () => {
          cleaned++;
        },
      },
      async () => {
        throw new Error('provider-private-canary');
      },
    ),
    (error) =>
      error instanceof ExecutionUncertainError &&
      !error.message.includes('provider-private-canary'),
  );
  assert.equal(cleaned, 0);
});

test('native session inputs remain alive during work and clean after its confirmed result', async () => {
  const order: string[] = [];
  const output = await withNativeSessionInputs(
    {
      cleanup: async () => {
        order.push('cleanup');
      },
    },
    async () => {
      order.push('started');
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(order, ['started']);
      order.push('settled');
      return 'result';
    },
  );
  assert.equal(output, 'result');
  assert.deepEqual(order, ['started', 'settled', 'cleanup']);
});
