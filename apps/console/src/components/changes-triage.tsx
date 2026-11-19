import { ReceiptTime } from './receipt-time';
import { useState } from 'react';
import type { Evaluation } from '@acclimate/sdk';
import { ArrowUpRight, GitCompareArrows } from 'lucide-react';
import type { EvaluationHistoryModel } from '../lib/changes-workspace';
import { evaluationScoreSummary } from '../lib/evaluation-score-summary';
import { evaluationPairs, formatReward, type PairFilter } from '../lib/evaluation-pairs';
import { evaluationRunName } from '../lib/evaluation-run-name';
import { ChangesTriageRail } from './changes-triage-rail';
import { ChangesCaseTriage } from './changes-case-triage';
import { ConsoleLink } from './console-link';
import './changes-triage.css';

export function ChangesTriage({
  model,
  reviewHref,
}: {
  model: EvaluationHistoryModel;
  reviewHref: (request: Evaluation) => string;
}) {
  const [filter, setFilter] = useState<PairFilter>('all');
  const request = model.requests[0];
  const evidence = request && model.evidence[request.id];
  const comparison = evidence?.status === 'bound' ? evidence.comparison : undefined;
  const summary = comparison && evaluationScoreSummary(comparison);
  const rows = comparison ? evaluationPairs(comparison) : [];
  return (
    <section className="triage-console" aria-label="Latest evaluation">
      <header className="triage-runbar">
        <div className="triage-run">
          <span>Latest evaluation</span>
          <strong>
            <GitCompareArrows size={16} aria-hidden="true" />
            {request ? evaluationRunName(request.datasetRevision, request.runtime?.configId) : 'No run'}
          </strong>
          {request && (
            <ReceiptTime value={request.createdAt} />
          )}
        </div>
        {summary && (
          <>
            <div className="triage-metric">
              <span>Parent mean reward</span>
              <b>{summary.parentMean === null ? '—' : formatReward(summary.parentMean)}</b>
            </div>
            <div className="triage-metric">
              <span>Candidate mean reward</span>
              <b>{summary.candidateMean === null ? '—' : formatReward(summary.candidateMean)}</b>
            </div>
            <div className="triage-coverage">
              <span>Scored pairs</span>
              <strong>
                {summary.pairedCount} / {summary.expectedCount}
              </strong>
              {summary.expectedCount > 0 && (
                <progress
                  aria-label="Scored pairs"
                  max={summary.expectedCount}
                  value={summary.pairedCount}
                />
              )}
            </div>
          </>
        )}
        {request && (
          <div className="triage-runlink">
            <span>{request.status}</span>
            <ConsoleLink href={reviewHref(request)}>
              Review evaluation <ArrowUpRight size={14} aria-hidden="true" />
            </ConsoleLink>
          </div>
        )}
      </header>
      {comparison && request ? (
        <div className="triage-workspace">
          <ChangesTriageRail rows={rows} filter={filter} onFilter={setFilter} />
          <ChangesCaseTriage
            key={comparison.id}
            comparison={comparison}
            reviewHref={reviewHref(request)}
            filter={filter}
          />
        </div>
      ) : (
        <p className="triage-unavailable" role="status">
          {evidence && 'message' in evidence
            ? evidence.message
            : model.loading || evidence?.status === 'loading'
              ? 'Loading evaluation evidence…'
              : model.error ||
                (request ? 'Paired evidence is unavailable for this run.' : 'No evaluations yet.')}
        </p>
      )}
    </section>
  );
}
