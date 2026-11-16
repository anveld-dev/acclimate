export const graderRevision = 'retry-review-exact-finding-v1';
const expected: Record<string, boolean> = { 'checkout-retry': true, 'checkout-keyed': false };
// This rubric is independent of the version and rejects malformed responses as missing grades.
export function gradeFinding(caseId: string, output: string): { reward: number } {
  if (!(caseId in expected)) throw new Error(`No trusted expectation for ${caseId}`);
  const parsed: unknown = JSON.parse(output);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof (parsed as { unsafeRetry?: unknown }).unsafeRetry !== 'boolean'
  )
    throw new Error('Expected exactly a JSON object with boolean unsafeRetry');
  return { reward: Number((parsed as { unsafeRetry: boolean }).unsafeRetry === expected[caseId]) };
}
