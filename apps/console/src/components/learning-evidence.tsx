import { useState } from 'react';
import type { LearningRound, LearningRollout } from '@acclimate/sdk';
import type { LearningScope } from '../lib/learning';
import { Button } from './ui/button';
import { learningRequest } from '../server/central-actions';

type Evidence = { caseId: string; rollouts: LearningRollout[] }[];
export function LearningEvidence({
  scope,
  roundIds,
  evaluation,
  taskId,
}: {
  scope: LearningScope;
  roundIds: string[];
  evaluation?: string;
  taskId?: string;
}) {
  const [result, setResult] = useState<Evidence>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setMessage('');
    try {
      for (const id of roundIds) {
        const round = await learningRequest<LearningRound>({
          ...scope,
          action: 'evidence',
          id,
          evaluation,
        });
        const match = round.evaluations
          .slice()
          .reverse()
          .find(
            (e) =>
              e.split === 'evolve' &&
              (evaluation
                ? e.id === evaluation
                : e.caseSummaries?.some((c) => c.caseId === taskId)),
          );
        if (!match) continue;
        const report = evaluation
          ? match.report
          : (
              await learningRequest<LearningRound>({
                ...scope,
                action: 'evidence',
                id,
                evaluation: match.id,
              })
            ).evaluations.find((e) => e.id === match.id)?.report;
        const cases = report?.cases.filter((c) => !taskId || c.caseId === taskId);
        if (cases?.length) {
          setResult(cases);
          return;
        }
      }
      setMessage('No recorded rollout evidence.');
    } catch {
      setMessage('Could not load rollout evidence.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button variant="outline" disabled={busy} onClick={() => void load()}>
        {busy ? 'Loading evidence…' : taskId ? 'Show last rollout' : 'Show per-task results'}
      </Button>
      {message && <p role="status">{message}</p>}
      {result?.map((c) => (
        <details key={c.caseId}>
          <summary>
            {c.caseId} · {c.rollouts.filter((r) => r.passed).length} of {c.rollouts.length} passed
          </summary>
          {c.rollouts.map((r, i) => (
            <RolloutEvidence key={i} r={r} i={i} />
          ))}
        </details>
      ))}
    </div>
  );
}

export function RolloutEvidence({ r, i }: { r: LearningRollout; i: number }) {
  return (
    <div className="rounded border p-2">
      <p>
        Rollout {i + 1} · {r.error ? 'Error' : r.passed ? 'Passed' : 'Failed'} · score {r.score}
      </p>
      <pre className="whitespace-pre-wrap break-words">
        {r.error ?? r.reasons?.join('\n') ?? r.trace ?? 'No judge reasoning recorded.'}
      </pre>
      <details>
        <summary>Gateway log</summary>
        <pre className="whitespace-pre-wrap break-words">
          {JSON.stringify(r.gatewayLog ?? [], null, 2)}
        </pre>
      </details>
    </div>
  );
}
