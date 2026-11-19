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
    scope.projectId,
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
  'policy.maximum_case_regression': 'Maximum per-case regression',
  'policy.candidate_threshold': 'Candidate quality threshold',
  'policy.maximum_candidate_task_failures': 'Maximum candidate task failures',
  'policy.maximum_candidate_cost': 'Maximum candidate cost',
  'policy.maximum_cost_increase': 'Maximum cost increase',
  'evidence.incomplete': 'Incomplete evidence',
  'analysis.nonfinite': 'Unrepresentable numeric result',
  'cost.unknown': 'Unknown measured cost',
};

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
