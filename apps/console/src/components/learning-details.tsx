import type { LearningCandidate, LearningMemory } from '@acclimate/sdk';
import type { ReactNode } from 'react';
import type { LearningScope } from '../lib/learning';
import { bundleHref, releaseRevision } from '../navigation';
import type { LearningState } from '../server/learning-core';

type RoundDetail = Extract<
  NonNullable<Extract<LearningState, { ok: true }>['detail']>,
  { ok: true }
>;

const list = (values: string[]) => values.join(', ') || 'None';

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Diff({ before, after }: { before?: string; after?: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-md border p-2 text-xs">
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
    <ul className="space-y-2">
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
            {!parentFiles && <p>Original file content is unavailable.</p>}
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

export function LearningRoundDetail({
  scope,
  detail,
}: {
  scope: LearningScope;
  detail: RoundDetail;
}) {
  const { round, parentFiles } = detail;
  const { selection } = round;
  const parentRevision = releaseRevision(round.channelRevision);
  const releaseHref = parentRevision
    ? bundleHref({ ...scope, channel: round.channel }, 'releases') +
      '#revision-' +
      String(BigInt(parentRevision) + 1n)
    : undefined;
  return (
    <div className="space-y-4 break-words text-sm">
      <h3 className="font-semibold">Round {round.number} candidates</h3>
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
          <article key={sample} className="space-y-3 rounded-md border p-4">
            <h4 className="font-medium">
              Sample {sample}
              {adopted && ' · Adopted'}
            </h4>
            {adopted &&
              round.adoptedVersionId &&
              (releaseHref ? (
                <a className="underline" href={releaseHref}>
                  Released version {round.adoptedVersionId}
                </a>
              ) : (
                <p>Released version {round.adoptedVersionId}</p>
              ))}
            <dl className="space-y-2">
              <Detail label="Status">
                {status.replaceAll('_', ' ')}
                {dropReason && ` · ${dropReason}`}
              </Detail>
              {diagnosis && (
                <>
                  <Detail label="Diagnosis">
                    {'id' in diagnosis.problem
                      ? diagnosis.problem.id
                      : `New root cause · ${diagnosis.problem.new}`}
                  </Detail>
                  <Detail label="Predicted cases">{list(diagnosis.predicted)}</Detail>
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
                {screen ? `${screen.verdict} · ${screen.reason}` : 'Pending or unavailable'}
              </Detail>
              <Detail label="Evolve score versus incumbent">
                {evolveScore ?? '—'} versus {round.incumbentScore ?? '—'}
              </Detail>
              {changes && (
                <Detail label="File changes">
                  <CandidateChanges changes={changes} parentFiles={parentFiles} />
                </Detail>
              )}
            </dl>
          </article>
        );
      })}
      <div className="space-y-1">
        <h3 className="font-semibold">Selection</h3>
        {round.decision === 'adopted' ? (
          <p>Adopted sample {round.adoptedSample}</p>
        ) : round.decision === 'kept' ? (
          <p>Kept incumbent</p>
        ) : (
          <p>No selection recorded.</p>
        )}
        {selection?.decision === 'adopt' && round.decision !== 'adopted' && (
          <p>Selector chose sample {selection.sample}.</p>
        )}
        {selection && <p>{selection.reason}</p>}
        {round.reason && round.reason !== selection?.reason && <p>{round.reason}</p>}
      </div>
    </div>
  );
}

export function ImprovementMemory({ memory }: { memory: LearningMemory }) {
  const records = new Map(memory.records.map((record) => [record.round, record]));
  return (
    <div className="space-y-4 break-words text-sm">
      <p>
        Revision {memory.memoryRevision} of {memory.currentRevision}
      </p>
      <code>{memory.memoryDigest}</code>
      {!memory.improvementMemory.problems.length && <p>No problems recorded at this revision.</p>}
      {memory.improvementMemory.problems.map((problem) => (
        <article key={problem.id} className="space-y-3 rounded-md border p-4">
          <h3 className="font-semibold">{problem.id}</h3>
          <p>{problem.rootCause}</p>
          <p>Opened in round {problem.openedRound}</p>
          {problem.attempts.map((attempt) => {
            const record = records.get(attempt.round);
            const provenance = record?.provenance ?? attempt.provenance;
            return (
              <details key={attempt.round}>
                <summary className="cursor-pointer font-medium">
                  Round {attempt.round} · sample {attempt.sample}
                  {attempt.accepted && ' · Accepted'}
                </summary>
                <dl className="space-y-2 p-2">
                  <Detail label="Files">{list(attempt.files)}</Detail>
                  <Detail label="Predicted">{list(attempt.predicted)}</Detail>
                  <Detail label="Fixed">{list(attempt.fixed)}</Detail>
                  <Detail label="Missed">{list(attempt.missed)}</Detail>
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
                </dl>
              </details>
            );
          })}
        </article>
      ))}
    </div>
  );
}
