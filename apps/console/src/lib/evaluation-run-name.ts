/** Content digests identify a dataset exactly but are not names a reader can scan. */
const digest = /^(?:sha256|sha384|sha512|blake3):([a-f0-9]{16,128})$/i;

function readable(revision: string) {
  return revision
    .replace(/[-_][a-f0-9]{12,64}$/i, '')
    .replace(/(\d)-(?=\d)/g, '$1–')
    .replace(/[-_]+/g, ' ')
    .replace(/\bpr\b/gi, 'PR')
    .replace(/\bgit\b/gi, 'Git')
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

/**
 * A short display name for an evaluation run. Named dataset revisions read as words.
 * Digest revisions use the evaluator configuration when it has a name, otherwise a short
 * digest. Callers keep the full revision available for copying and assistive text.
 */
export function evaluationRunName(revision: string, configId?: string) {
  const hashed = digest.exec(revision);
  if (hashed) {
    if (configId && /^[a-z][a-z0-9_-]+$/i.test(configId)) return readable(configId);
    return `Dataset ${hashed[1].slice(0, 8)}`;
  }
  if (!/^[a-z][a-z0-9_-]+$/i.test(revision)) return revision || 'Unavailable';
  return readable(revision);
}

/** A compact form of a dataset revision for secondary text. */
export function shortRevision(revision: string) {
  const hashed = digest.exec(revision);
  return hashed ? `${revision.slice(0, revision.indexOf(':'))}:${hashed[1].slice(0, 12)}` : revision;
}

/** Whether a dataset revision is a content digest rather than a readable name. */
export function isDigestRevision(revision: string) {
  return digest.test(revision);
}
