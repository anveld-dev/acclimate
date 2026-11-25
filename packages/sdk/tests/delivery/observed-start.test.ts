import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeStartOnce, observeOptional } from '../../../../examples/optional-receipts.js';

test('Codex reports started once only after the observed turn.started event', () => {
  let starts = 0;
  const observe = observeStartOnce(
    (event) => event.type === 'turn.started',
    () => {
      starts++;
    },
  );
  observe({ type: 'thread.started' });
  observe({ type: 'turn.failed' });
  assert.equal(starts, 0);
  observe({ type: 'turn.started' });
  observe({ type: 'turn.started' });
  assert.equal(starts, 1);
});

test('Cursor requires an observed RUNNING status and reporting cannot break execution', async () => {
  let starts = 0;
  const observe = observeStartOnce(
    (event) => event.type === 'status' && event.status === 'RUNNING',
    () => {
      starts++;
      throw new Error('optional observer failed');
    },
  );
  observe({ type: 'system' });
  observe({ type: 'status', status: 'CREATING' });
  assert.equal(starts, 0);
  assert.doesNotThrow(() => observe({ type: 'status', status: 'RUNNING' }));
  observe({ type: 'status', status: 'RUNNING' });
  assert.equal(starts, 1);
  observeOptional(() => Promise.reject(new Error('optional async observer failed')));
  await new Promise<void>((r) => setImmediate(r));
});
