import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, DeliveryError } from '../../src/validation.js';
import {
  DeliveryError as CacheError,
  validatePayload as cacheValidation,
} from '../../src/cache.js';

test('browser and delivery validation share errors and enforce UTF-8 byte limits', () => {
  assert.equal(DeliveryError, CacheError);
  assert.equal(validatePayload, cacheValidation);
  const payload = {
    schemaVersion: 1,
    files: [{ path: 'memory/context.md', kind: 'memory', text: '😀'.repeat(65536) }],
  };
  validatePayload(payload);
  payload.files[0].text += '\ud800';
  assert.throws(
    () => validatePayload(payload),
    (error) => error instanceof CacheError && error.code === 'invalid_payload',
  );
});
