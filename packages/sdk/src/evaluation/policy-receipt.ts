import { isDeepStrictEqual } from 'node:util';
import { AcclimateClient, ApiError } from '../client.js';
import type { ComparisonPolicyReport, EvaluationHandoff } from '../types.js';
import type { PolicyVerdict } from './policy.js';

export type PolicyReceiptStatus =
  | { status: 'recorded' | 'read_only' }
  | { status: 'unconfirmed'; code: string };

export async function recordPolicyReceipt(
  client: AcclimateClient,
  handoff: EvaluationHandoff,
  verdict: PolicyVerdict,
): Promise<PolicyReceiptStatus> {
  const { policy, expectedBinding, comparisonId } = verdict;
  if (
    !policy.sha256 ||
    !expectedBinding.attemptId ||
    expectedBinding.requestId !== handoff.requestId ||
    comparisonId !== expectedBinding.comparisonId
  )
    return { status: 'unconfirmed', code: 'evidence.identity_mismatch' };
  const report: ComparisonPolicyReport = {
    requestId: handoff.requestId,
    attemptId: expectedBinding.attemptId,
    policy: { ...policy, sha256: policy.sha256 },
    verdict: verdict.verdict,
    checks: verdict.checks,
  };
  try {
    const receipts = await client.listComparisonPolicyReceipts(
      handoff.projectId,
      handoff.bundleId,
      comparisonId,
    );
    const existing = receipts.items.find((receipt) => receipt.policy.sha256 === policy.sha256);
    const receipt =
      existing ??
      (await client.reportComparisonPolicyReceipt(
        handoff.projectId,
        handoff.bundleId,
        comparisonId,
        report,
      ));
    if (
      receipt.comparisonId !== comparisonId ||
      receipt.reportedBy !== expectedBinding.submitter ||
      receipt.requestId !== report.requestId ||
      receipt.attemptId !== report.attemptId ||
      receipt.verdict !== report.verdict ||
      !isDeepStrictEqual(receipt.policy, report.policy) ||
      !isDeepStrictEqual(receipt.checks, report.checks)
    )
      return { status: 'unconfirmed', code: 'policy.receipt_conflict' };
    return { status: 'recorded' };
  } catch (error) {
    let code = 'policy.receipt_unavailable';
    if (error instanceof ApiError && (error.status === 401 || error.status === 403))
      code = 'auth.denied';
    if (error instanceof ApiError && error.status === 409) code = 'policy.receipt_conflict';
    return { status: 'unconfirmed', code };
  }
}
