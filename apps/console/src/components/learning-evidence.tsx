import { useState } from 'react';
import type { LearningRound, LearningRollout } from '@anveld/acclimate-sdk';
import type { LearningScope } from '../lib/learning';
import { Button } from './ui/button';
import { learningRequest } from '../server/central-actions';
import { TaskLink } from './learning-task-link';

const codeBlock =
  'rounded-md border bg-muted/40 px-3 py-2 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words';
type Evidence = { caseId: string; rollouts: LearningRollout[] }[];
export function LearningEvidence({
  scope,
  roundIds,
  evaluation,
  taskId,
  label = 'Show per-task results',
}: {
  scope: LearningScope;
  roundIds: string[];
  evaluation?: string;
  taskId?: string;
  label?: string;
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
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
        {busy ? 'Loading evidence…' : taskId ? 'Show last rollout' : label}
      </Button>
      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
      {result?.map((c) => (
        <details key={c.caseId} className="space-y-2 text-sm">
          <summary className="cursor-pointer">
            <TaskLink id={c.caseId} /> · {c.rollouts.filter((r) => r.passed).length} of{' '}
            {c.rollouts.length} passed
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
  const reasoning = r.error ?? r.reasons?.join('\n') ?? r.trace;
  return (
    <div className="mt-2 space-y-2 rounded-md border bg-muted/20 p-3 text-sm">
      <p className="font-medium">
        Rollout {i + 1} · {r.error ? 'Error' : r.passed ? 'Passed' : 'Failed'} · score{' '}
        {typeof r.score === 'number' ? Number(r.score.toFixed(3)) : r.score}
      </p>
      {reasoning && <pre className={codeBlock}>{reasoning}</pre>}
      <details>
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Gateway log
        </summary>
        <pre className={codeBlock + ' mt-1.5'}>{JSON.stringify(r.gatewayLog ?? [], null, 2)}</pre>
      </details>
    </div>
  );
}
