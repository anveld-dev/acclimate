import { createHash } from 'node:crypto';

/** Fingerprint the exact request body the service records under a POST operation key and route. */
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
