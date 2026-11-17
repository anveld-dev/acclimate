import type { Evaluation, EvaluationProgressView } from '@acclimate/sdk';

/** Latest optional evaluator report, kept separate from durable execution state. */
export function EvaluationActivity({
  request,
  progress,
}: {
  request: Evaluation;
  progress?: EvaluationProgressView | null;
}) {
  const bound = progress?.requestId === request.id && progress.attemptId === request.attemptId;
  const observation =
    bound && progress.observation?.attemptId === request.attemptId ? progress.observation : null;
  return (
    <section aria-label="Evaluator activity" className="space-y-2">
      <h4>Evaluator activity</h4>
      {!bound ? (
        <p>Activity unavailable; retrying automatically. Evaluator activity is unknown.</p>
      ) : !observation ? (
        <p>No activity report. Evaluator activity is unknown.</p>
      ) : (
        <>
          <p>
            {progress.activity === 'fresh' ? 'Recent report at last check' : 'Stale report'} ·{' '}
            {observation.phase} · {observation.completed} / {observation.total}
          </p>
          {observation.case && (
            <p>
              Case {observation.case.caseId} / {observation.case.repetition}
            </p>
          )}
          <p>
            Received {observation.receivedAt} · checked {progress.checkedAt}
          </p>
          <p>
            Attempt {observation.attemptId} · report {observation.sequence}
          </p>
        </>
      )}
      <p className="text-sm text-muted-foreground">
        Optional reports describe evaluator activity at receipt time. They do not prove the worker
        is live or stopped, cancellation, or that a retry is safe. Request status remains{' '}
        {request.status}.
      </p>
    </section>
  );
}
