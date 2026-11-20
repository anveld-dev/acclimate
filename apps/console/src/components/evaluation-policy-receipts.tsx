import { ReceiptTime } from './receipt-time';
import { useEffect, useState } from 'react';
import type { ComparisonPolicyReceipt } from '@acclimate/sdk';
import { runImprovement } from '../server/improvement-actions';
import type { BundleScope } from '../server/selection';

type Receipts = { comparison: ComparisonPolicyReceipt[]; blockers: ComparisonPolicyReceipt[] };

export function usePolicyReceipts(
  scope: BundleScope,
  actor: string,
  service: string,
  candidate: string,
  comparison?: string,
) {
  const key = JSON.stringify([
    actor,
    service,
    scope.workspaceId,
    scope.bundleId,
    scope.channel,
    candidate,
    comparison,
  ]);
  const [value, setValue] = useState<{ key: string; receipts: Receipts }>();
  const [failed, setFailed] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!candidate) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await runImprovement({
          data: { action: 'policyReceipts', candidate, comparison, scope },
        });
        if (!result.ok || !result.receipts) throw Error();
        if (active) {
          setValue({ key, receipts: result.receipts });
          setFailed('');
        }
      } catch {
        if (active) setFailed(key);
      } finally {
        if (active) timer = setTimeout(load, 12000);
      }
    }
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, revision]);
  return {
    receipts: value?.key === key ? value.receipts : undefined,
    failed: failed === key,
    refresh: () => setRevision((n) => n + 1),
  };
}

const checkNames: Record<string, string> = {
  'policy.minimum_mean_improvement': 'Minimum mean improvement',
  'policy.non_inferiority': 'Audit non-inferiority bound',
  'policy.step_non_inferiority': 'Step non-inferiority bound',
  'policy.development_benefit': 'Development step benefit',
  'policy.protected_case_threshold': 'Protected case threshold',
  'policy.minimum_cost_savings': 'Minimum cost savings',
  'inference.minimum_cases': 'Too few cases for the policy test',
  'inference.minimum_repetitions': 'Too few repetitions for the policy test',
  'inference.zero_variance': 'No observed variation and no SD floor',
  'policy.maximum_case_regression': 'Maximum per-case regression',
  'policy.maximum_regressed_cases': 'Maximum net regressed cases',
  'policy.candidate_threshold': 'Candidate quality threshold',
  'policy.maximum_candidate_task_failures': 'Maximum candidate task failures',
  'policy.maximum_candidate_cost': 'Maximum candidate cost',
  'policy.maximum_cost_increase': 'Maximum cost increase',
  'evidence.incomplete': 'Incomplete evidence',
  'analysis.nonfinite': 'Unrepresentable numeric result',
  'cost.unknown': 'Unknown measured cost',
};

const statistic = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(4))) : '—';

/** One line naming the test, bound, threshold and sample behind a recorded verdict. */
export function receiptInferenceText(receipt: ComparisonPolicyReceipt) {
  const inference = receipt.inference;
  if (!inference) return 'No statistics recorded with this receipt';
  if (inference.method === 'none') return 'Point estimate for these cases · no confidence bound';
  const confidence =
    typeof inference.confidence === 'number'
      ? `${Math.round(inference.confidence * 1000) / 10}%`
      : '—';
  return `paired-t ${confidence} · lower bound ${statistic(inference.lowerBound)} vs threshold ${statistic(
    inference.threshold,
  )} · ${statistic(inference.n)} cases · sd ${statistic(inference.sd)} (floor ${statistic(
    inference.sdFloor,
  )})`;
}

export function PolicyReceiptList({ receipts }: { receipts: ComparisonPolicyReceipt[] }) {
  return (
    <ul className="space-y-2">
      {receipts.map((receipt) => (
        <li key={receipt.comparisonId + receipt.policy.sha256} className="rounded-md border p-3">
          <strong>
            {{ pass: 'Passed', fail: 'Failed', indeterminate: 'Indeterminate' }[receipt.verdict]}
          </strong>
          {' · '}
          {receipt.policy.id} · revision {receipt.policy.revision}
          {[
            ...new Set(
              receipt.checks.filter((check) => check.result !== 'pass').map((check) => check.code),
            ),
          ].map((code) => (
            <div key={code}>{checkNames[code] ?? code}</div>
          ))}
          <div className="text-muted-foreground">{receiptInferenceText(receipt)}</div>
          {receipt.policyPin === 'mismatched' && (
            <div>Checked with a policy other than the one pinned before the run</div>
          )}
          <details className="mt-1 text-muted-foreground">
            <summary>Policy check details</summary>
            <p className="break-all">
              Reported by {receipt.reportedBy} · <ReceiptTime value={receipt.receivedAt} />
            </p>
            <p className="break-all">Comparison {receipt.comparisonId}</p>
            <p className="break-all">Policy digest {receipt.policy.sha256}</p>
          </details>
        </li>
      ))}
    </ul>
  );
}
