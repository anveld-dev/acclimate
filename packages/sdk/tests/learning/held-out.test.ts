import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { heldOutDigest } from '../../src/learning/index.js';

test('the held-out commitment matches the shared fixture independently of case order', async () => {
  const data = JSON.parse(
    await readFile(
      new URL('../../../../contracts/fixtures/learning-held-out-v1.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(heldOutDigest(data.cases), data.digest);
  assert.equal(heldOutDigest([...data.cases].reverse()), data.digest);
});
