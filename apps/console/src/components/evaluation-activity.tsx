import { Radio } from 'lucide-react';
import type { Evaluation, EvaluationProgressView } from '@acclimate/sdk';
import { ReceiptTime } from './receipt-time';
import { Disclosure, DisclosureContent, DisclosureTrigger } from './ui/disclosure';

/** Display only observations bound to this request and its current attempt. */
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
    <section aria-label="Evaluator activity" className="evaluator-activity">
      <div className="evaluation-activity-header">
        <h4><Radio aria-hidden="true" />Evaluator activity</h4>
        {observation && (
          <span className="activity-freshness" data-fresh={progress?.activity === 'fresh'}>
            {progress?.activity === 'fresh' ? 'Recent report at last check' : 'Stale report'}
          </span>
        )}
      </div>
      {observation ? (
        <div className="evaluation-observation">
          <strong>{observation.phase} · {observation.completed} / {observation.total} outcomes</strong>
          {request.status === 'running' && observation.total > 0 && (
            <progress aria-label="Reported evaluation progress" value={observation.completed} max={observation.total} />
          )}
          {observation.case && (
            <p>Case <code>{observation.case.caseId}</code> · repetition {observation.case.repetition}</p>
          )}
          <p>Received <ReceiptTime value={observation.receivedAt} /></p>
        </div>
      ) : (
        <p className="activity-no-report">
          {bound ? 'No activity report.' : 'Activity unavailable.'} Evaluator activity is unknown.
        </p>
      )}
      <Disclosure key={JSON.stringify([request.id, request.attemptId])} className="evaluator-report-details">
        <DisclosureTrigger>Report details</DisclosureTrigger>
        <DisclosureContent>
          <dl className="activity-report-metadata">
            {bound && (
              <>
                <div><dt>Last checked</dt><dd><ReceiptTime value={progress.checkedAt} /></dd></div>
                <div><dt>Freshness window</dt><dd>{progress.staleAfterSeconds} seconds</dd></div>
              </>
            )}
            {observation && (
              <>
                <div><dt>Evaluator</dt><dd><code>{observation.evaluatorPrincipal}</code></dd></div>
                <div><dt>Report sequence</dt><dd>{observation.sequence}</dd></div>
                <div><dt>Attempt</dt><dd><code>{observation.attemptId}</code></dd></div>
              </>
            )}
          </dl>
          <p>
            Optional reports describe evaluator activity at receipt time. They do not prove the worker
            is live or stopped, cancellation, or that a retry is safe. Request status remains{' '}
            {request.status}.
          </p>
        </DisclosureContent>
      </Disclosure>
    </section>
  );
}
