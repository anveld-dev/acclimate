import { createHash } from 'node:crypto';
import type { BundlePayload } from './types.js';
import { DeliveryError, validatePayload } from './validation.js';

/** Verify immutable bytes before decoding or interpreting their bundle content. */
export function verifyPayloadBytes(bytes: Uint8Array, expectedDigest: string): BundlePayload {
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== expectedDigest)
    throw new DeliveryError(
      'digest_mismatch',
      'Downloaded payload SHA-256 does not match version metadata',
    );
  const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  validatePayload(payload);
  return payload;
}
