import type { LearningCandidate, LearningMemory, LearningRoundSummary } from '@anveld/sdk';
import { describeFailureCause, describeLearning } from '../lib/central-learning';
import { ReceiptTime } from './receipt-time';
import { TaskLink } from './learning-task-link';
import { LearningEvidence } from './learning-evidence';
import type { ReactNode } from 'react';
import type { LearningScope } from '../lib/learning';
import { bundleHref, releaseRevision } from '../navigation';
import type { LearningState } from '../server/learning-core';
import { Panel } from './panel';
import { StatusBadge, type StatusTone } from './status-badge';
import { CopyButton } from './copy-button';
import { Button } from './ui/button';
import { ConsoleLink } from './console-link';
import { percent, shortId } from '../lib/format';

type RoundDetail = Extract<
  NonNullable<Extract<LearningState, { ok: true }>['detail']>,
  { ok: true }
>;

const list = (values: string[]) => values.join(', ') || 'None';

/** A score as a percentage, or a dash when the round did not measure it. */
export const scoreText = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : percent(value);

/** How a round ended, as the badge the rounds table and round detail show. */
export function roundOutcome(round: Pick<LearningRoundSummary, 'state' | 'decision'>): {
  label: string;
  tone: StatusTone;
} {
  if (round.state === 'failed') return { label: 'Failed', tone: 'danger' };
  if (round.state === 'stopped') return { label: 'Stopped', tone: 'neutral' };
  if (round.state !== 'completed') return { label: 'Running', tone: 'info' };
  if (round.decision === 'adopted') return { label: 'Adopted', tone: 'success' };
  if (round.decision === 'kept') return { label: 'Kept', tone: 'neutral' };
  return { label: 'Completed', tone: 'neutral' };
}

export function RoundOutcome({
  round,
}: {
  round: Pick<LearningRoundSummary, 'state' | 'decision'>;
}) {
  const { label, tone } = roundOutcome(round);
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

/** A version ID shortened for reading, with the full value in its title and a copy button. */
export function VersionId({
  id,
  href,
  label = 'Copy version ID',
}: {
  id: string;
  href?: string;
  label?: string;
}) {
  const short = (
    <code title={id} className="text-xs">
      {shortId(id)}
    </code>
  );
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      {href ? (
        <a className="underline" href={href}>
          {short}
        </a>
      ) : (
        short
      )}
      <CopyButton value={id} label={label} iconOnly />
    </span>
  );
}

function TaskList({ ids }: { ids: string[] }) {
  if (!ids.length) return <>None</>;
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index > 0 && ', '}
          <TaskLink id={id} />
        </span>
      ))}
    </>
  );
}

/** Why a round failed, in plain words, from the first failed rollout. */
export function FailureCause({
  cause,
}: {
  cause: NonNullable<RoundDetail['round']['failureCause']>;
}) {
  return (
    <>
      {describeFailureCause(cause.code)}
      {cause.message && (
        <>
          {' '}
          The executor reported: <q className="break-words">{cause.message}</q>
        </>
      )}
    </>
  );
}

/** A label and its value. Pairs stack on small screens and sit side by side from small widths. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Details({ children }: { children: ReactNode }) {
  return <dl className="grid gap-3">{children}</dl>;
}

function Diff({ before, after }: { before?: string; after?: string }) {
  return (
    <pre className="mt-2 max-h-64 overflow-auto rounded-md border p-2 text-xs">
      {before !== undefined && (
        <code className="block bg-destructive/10">
          {before
            .split('\n')
            .map((line) => '- ' + line)
            .join('\n')}
        </code>
      )}
      {after !== undefined && (
        <code className="block bg-primary/10">
          {after
            .split('\n')
            .map((line) => '+ ' + line)
            .join('\n')}
        </code>
      )}
    </pre>
  );
}

function CandidateChanges({
  changes,
  parentFiles,
}: {
  changes: NonNullable<LearningCandidate['changes']>;
  parentFiles: RoundDetail['parentFiles'];
}) {
  const paths = [...new Set(changes.edits.map(({ path }) => path))];
  if (!paths.length && !changes.files.length) return <p>No file changes.</p>;
  return (
    <ul className="space-y-1">
      {paths.map((path) => (
        <li key={path}>
          <details>
            <summary className="cursor-pointer">
              Edit <code>{path}</code>
            </summary>
            {changes.edits
              .filter((edit) => edit.path === path)
              .map(({ oldText, newText }) => (
                <Diff key={oldText} before={oldText} after={newText} />
              ))}
          </details>
        </li>
      ))}
      {changes.files.map((file) => (
        <li key={file.path}>
          <details>
            <summary className="cursor-pointer">
              {file.op === 'delete' ? 'Delete' : 'Write'} <code>{file.path}</code>
            </summary>
            {!parentFiles && <p className="mt-2">Original file content is unavailable.</p>}
            <Diff
              before={parentFiles?.find(({ path }) => path === file.path)?.text}
              after={file.op === 'write' ? file.text : undefined}
            />
          </details>
        </li>
      ))}
    </ul>
  );
}

/** The tasks a diagnosis predicts the change will fix, as a count that opens to the list. */
function PredictedCases({ ids }: { ids: string[] }) {
  if (!ids.length) return <>None</>;
  return (
    <details>
      <summary className="cursor-pointer">
        {ids.length} {ids.length === 1 ? 'case' : 'cases'}
      </summary>
      <p className="mt-2 leading-relaxed">
        <TaskList ids={ids} />
      </p>
    </details>
  );
}

const screenVerdicts: Record<string, string> = {
  evaluate: 'Passed screening',
  skip: 'Screened out',
};

function EvolveScore({ score, current }: { score: number | null; current: number | null }) {
  if (score === null) return <>Not scored</>;
  return (
    <>
      {percent(score)}
      {current !== null && `, against ${percent(current)} for the current version`}
    </>
  );
}

export function LearningRoundDetail({
  scope,
  detail,
}: {
  scope: LearningScope;
  detail: RoundDetail;
}) {
  const { round, parentFiles, problems } = detail;
  const { selection } = round;
  const parentRevision = releaseRevision(round.channelRevision);
  const releaseHref = parentRevision
    ? bundleHref({ ...scope, channel: round.channel }, 'releases') +
      '#revision-' +
      String(BigInt(parentRevision) + 1n)
    : undefined;
  return (
    <Panel
      id="round-detail"
      title={`Round ${round.number}`}
      description="What the optimizer proposed, how each candidate scored, and what the selector chose."
      actions={
        <Button asChild variant="ghost">
          <ConsoleLink href={bundleHref({ ...scope, channel: round.channel }, 'learning')}>
            Close round
          </ConsoleLink>
        </Button>
      }
    >
      <div className="space-y-6 break-words text-sm">
        <Details>
          <Detail label="Outcome">
            <span className="inline-flex flex-wrap items-center gap-2">
              <RoundOutcome round={round} />
              <span>
                {describeLearning('round.' + round.state)}
                {round.state === 'failed' && round.reason && ` · ${describeLearning(round.reason)}`}
              </span>
            </span>
          </Detail>
          {round.failureCause && (
            <Detail label="Cause">
              <FailureCause cause={round.failureCause} />
            </Detail>
          )}
          <Detail label="Started">
            <ReceiptTime value={round.createdAt} />
          </Detail>
          {round.endedAt && (
            <Detail label="Ended">
              <ReceiptTime value={round.endedAt} />
            </Detail>
          )}
          <Detail label="Current version">
            {round.incumbentScore === null
              ? 'Not scored'
              : `${percent(round.incumbentScore)} on evolve tasks`}
            {round.incumbentEvaluationId && (
              <div className="mt-2">
                <LearningEvidence
                  scope={scope}
                  roundIds={[round.id]}
                  evaluation={round.incumbentEvaluationId}
                  label="Show the current version's results"
                />
              </div>
            )}
          </Detail>
          <Detail label="Selection">
            <div className="space-y-1">
              {round.decision === 'adopted' ? (
                <p>Adopted sample {round.adoptedSample}</p>
              ) : round.decision === 'kept' ? (
                <p>Kept the current version</p>
              ) : (
                <p>No selection recorded.</p>
              )}
              {selection?.decision === 'adopt' && round.decision !== 'adopted' && (
                <p>Selector chose sample {selection.sample}.</p>
              )}
              {selection && <p>{selection.reason}</p>}
              {round.reverted && <p>The service restored the previous version.</p>}
              {round.confirmedParentScore != null && round.confirmedAdoptionScore != null && (
                <p>
                  Confirmed held-out scores · previous version {percent(round.confirmedParentScore)}
                  , adopted version {percent(round.confirmedAdoptionScore)}.
                </p>
              )}
              {round.reason && round.reason !== selection?.reason && (
                <p>{describeLearning(round.reason)}</p>
              )}
            </div>
          </Detail>
        </Details>
        <section className="space-y-3">
          <h3 className="font-semibold">Candidates</h3>
          {!round.candidates.length && <p>No candidates recorded for this round.</p>}
          {round.candidates.map((candidate) => {
            const {
              sample,
              status,
              dropReason,
              diagnosis,
              rationale,
              scan,
              screen,
              changes,
              evolveScore,
            } = candidate;
            const adopted = round.decision === 'adopted' && sample === round.adoptedSample;
            return (
              <article
                key={sample}
                className={
                  adopted
                    ? 'space-y-4 rounded-lg border border-primary p-4 ring-1 ring-primary/30'
                    : 'space-y-4 rounded-lg border p-4'
                }
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="flex items-center gap-2 font-medium">
                    Sample {sample}
                    {adopted && (
                      <>
                        <span className="sr-only"> · </span>
                        <StatusBadge tone="success">Adopted</StatusBadge>
                      </>
                    )}
                  </h4>
                  {adopted && round.adoptedVersionId && (
                    <p className="flex items-center gap-1.5 text-muted-foreground">
                      Released version <VersionId id={round.adoptedVersionId} href={releaseHref} />
                    </p>
                  )}
                </div>
                <Details>
                  <Detail label="Status">
                    {describeLearning(status)}
                    {dropReason && ` · ${describeLearning(dropReason)}`}
                  </Detail>
                  {diagnosis && (
                    <>
                      <Detail label="Diagnosis">
                        {'id' in diagnosis.problem
                          ? `${diagnosis.problem.id} · ${problems?.[diagnosis.problem.id] ?? 'Root cause unavailable'}`
                          : `New root cause · ${diagnosis.problem.new}`}
                      </Detail>
                      <Detail label="Predicted cases">
                        <PredictedCases ids={diagnosis.predicted} />
                      </Detail>
                    </>
                  )}
                  {rationale && <Detail label="Rationale">{rationale}</Detail>}
                  <Detail label="Scanner findings">
                    {scan ? (
                      scan.findings.length ? (
                        <ul>
                          {scan.findings.map(({ rule, field, path }, index) => (
                            <li key={index}>
                              {rule} · {field}
                              {path && ` · ${path}`}
                            </li>
                          ))}
                        </ul>
                      ) : scan.clean ? (
                        'Clean'
                      ) : (
                        'Rejected'
                      )
                    ) : (
                      'Pending or unavailable'
                    )}
                  </Detail>
                  <Detail label="Screen verdict">
                    {screen
                      ? `${screenVerdicts[screen.verdict] ?? screen.verdict} · ${screen.reason}`
                      : 'Pending or unavailable'}
                  </Detail>
                  <Detail label="Evolve score">
                    <EvolveScore score={evolveScore} current={round.incumbentScore} />
                  </Detail>
                  {changes && (
                    <Detail label="File changes">
                      <CandidateChanges changes={changes} parentFiles={parentFiles} />
                    </Detail>
                  )}
                </Details>
                {candidate.evaluationId && (
                  <LearningEvidence
                    scope={scope}
                    roundIds={[round.id]}
                    evaluation={candidate.evaluationId}
                  />
                )}
              </article>
            );
          })}
        </section>
      </div>
    </Panel>
  );
}

export function ImprovementMemory({ memory }: { memory: LearningMemory }) {
  const records = new Map(memory.records.map((record) => [record.round, record]));
  return (
    <div className="space-y-4 break-words text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span>
          Revision {memory.memoryRevision} of {memory.currentRevision}
        </span>
        <span className="text-muted-foreground">·</span>
        <VersionId id={memory.memoryDigest} label="Copy memory digest" />
      </p>
      {!memory.improvementMemory.problems.length && (
        <p className="text-muted-foreground">No problems recorded at this revision.</p>
      )}
      {memory.improvementMemory.problems.map((problem) => (
        <article key={problem.id} className="space-y-3 rounded-lg border p-4">
          <div className="space-y-1">
            <h3 className="font-semibold">{problem.id}</h3>
            <p>{problem.rootCause}</p>
            <p className="text-muted-foreground">Opened in round {problem.openedRound}</p>
          </div>
          {problem.attempts.map((attempt) => {
            const record = records.get(attempt.round);
            const provenance = record?.provenance ?? attempt.provenance;
            return (
              <details key={attempt.round}>
                <summary className="cursor-pointer font-medium">
                  Round {attempt.round} · sample {attempt.sample}
                  {attempt.accepted && ' · Accepted'}
                </summary>
                <div className="pt-3">
                  <Details>
                    <Detail label="Files">{list(attempt.files)}</Detail>
                    <Detail label="Predicted">
                      <TaskList ids={attempt.predicted} />
                    </Detail>
                    <Detail label="Fixed">
                      <TaskList ids={attempt.fixed} />
                    </Detail>
                    <Detail label="Missed">
                      <TaskList ids={attempt.missed} />
                    </Detail>
                    <Detail label="Passed / total">
                      {attempt.passed} / {attempt.total}
                    </Detail>
                    <Detail label="Provenance">
                      <p>
                        Round {provenance.round} · {provenance.domain} · {provenance.benchmark}
                      </p>
                      <p>Policy model {provenance.policyModel}</p>
                      {record && (
                        <p>
                          Optimizer model {record.provenance.optimizerModel} · evolve revision{' '}
                          {record.provenance.evolveRevision}
                        </p>
                      )}
                    </Detail>
                  </Details>
                </div>
              </details>
            );
          })}
        </article>
      ))}
    </div>
  );
}
