import { createHash } from 'node:crypto';

/** Fingerprint the exact request body recorded under a POST operation key. */
export function postFingerprint(path: string, body: string): string {
  return (
    'sha256:' +
    createHash('sha256')
      .update('POST\0')
      // The service stores retained operations under the original internal /v1/projects/
      // path. That is a database key, not a route; the SDK never calls /v1/projects.
      .update(path.replace(/^\/v1\/workspaces\//, '/v1/projects/'))
      .update('\0')
      .update(body, 'utf8')
      .digest('hex')
  );
}
