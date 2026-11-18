import { createHash } from 'node:crypto';

/** Fingerprint the exact request body recorded under a POST operation key. */
export function postFingerprint(path: string, body: string): string {
  return (
    'sha256:' +
    createHash('sha256')
      .update('POST\0')
      .update(path)
      .update('\0')
      .update(body, 'utf8')
      .digest('hex')
  );
}
