export function evaluationRunName(revision: string) {
  if (!/^[a-z][a-z0-9_-]+$/i.test(revision)) return revision || 'Unavailable';
  return revision
    .replace(/[-_][a-f0-9]{12,64}$/i, '')
    .replace(/(\d)-(?=\d)/g, '$1–')
    .replace(/[-_]+/g, ' ')
    .replace(/\bpr\b/gi, 'PR')
    .replace(/\bgit\b/gi, 'Git')
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());
}
