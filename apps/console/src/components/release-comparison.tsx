import { useEffect, useState, type ReactNode } from 'react';
import { StatusBadge } from './status-badge';
import type { BundlePayload, Comparison, Release } from '@acclimate/sdk';
import type { BundleScope } from '../server/selection';
import { readStoredVersion } from '../server/read-console';
import { runImprovement } from '../server/improvement-actions';
import { artifactChanges } from '../lib/artifact-changes';
import { requestEvidence } from '../lib/evaluation-history';
import { evaluationScoreSummary } from '../lib/evaluation-score-summary';
import { formatReward } from '../lib/evaluation-pairs';
import { ContentDiff } from './diff-content';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { NativeSelect, NativeSelectOption } from './ui/native-select';

const empty: BundlePayload = { schemaVersion: 1, files: [] };
type Files = { before: BundlePayload; after: BundlePayload } | { error: string };

async function readFiles(scope: BundleScope, release: Release): Promise<Files> {
  const baseline = release.previousVersionId;
  if (!baseline && release.revision !== '1')
    return { error: 'The previous channel version was not recorded for this revision.' };
  const after = readStoredVersion({ data: { scope, versionId: release.version.id } });
  const [selected, previous] = await Promise.all([
    after,
    baseline === release.version.id
      ? after
      : baseline
        ? readStoredVersion({ data: { scope, versionId: baseline } })
        : null,
  ]);
  if (
    !selected.ok ||
    selected.version.id !== release.version.id ||
    selected.version.digest !== release.version.digest
  )
    return { error: 'The selected release content could not be verified.' };
  if (previous && (!previous.ok || previous.version.id !== baseline))
    return { error: 'The previous channel release content could not be verified.' };
  return { before: previous?.ok ? previous.payload : empty, after: selected.payload };
}

async function readEvidence(scope: BundleScope, release: Release): Promise<Comparison | string> {
  const result = await runImprovement({
    data: { scope, action: 'comparison', id: release.comparisonId },
  });
  const comparison = result.ok && result.comparison;
  if (!comparison) return 'Recorded comparison is unavailable.';
  if (
    comparison.id !== release.comparisonId ||
    comparison.candidateVersionId !== release.version.id ||
    comparison.candidateDigest !== release.version.digest
  )
    return 'Recorded comparison does not match the released content.';
  if (!comparison.evaluation) return 'This release references a standalone comparison.';
  const request = await runImprovement({
    data: { scope, action: 'request', id: comparison.evaluation.requestId },
  });
  if (!request.ok || !request.request) return 'The recorded evaluation request is unavailable.';
  const binding = requestEvidence(request.request, comparison);
  return binding.status === 'bound'
    ? comparison
    : 'The comparison does not match its evaluation request.';
}

export function ReleaseComparison({
  scope,
  release,
  current,
  actions,
}: {
  scope: BundleScope;
  release: Release;
  current: boolean;
  actions: ReactNode;
}) {
  const [files, setFiles] = useState<Files>();
  const [evidence, setEvidence] = useState<Comparison | string>();
  const [path, setPath] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFiles(undefined);
    setEvidence(undefined);
    void readFiles(scope, release)
      .then((result) => {
        if (active) setFiles(result);
      })
      .catch(() => {
        if (active) setFiles({ error: 'Could not load release content.' });
      });
    if (release.comparisonId)
      void readEvidence(scope, release)
        .then((result) => {
          if (active) setEvidence(result);
        })
        .catch(() => {
          if (active) setEvidence('Could not load the recorded evidence.');
        });
    return () => {
      active = false;
    };
  }, [scope.workspaceId, scope.bundleId, scope.channel, release.id, attempt]);
  const changes = files && 'before' in files ? artifactChanges(files.before, files.after) : [];
  const selected = changes.find((change) => change.path === path) ?? changes[0];
  const summary =
    evidence && typeof evidence !== 'string' ? evaluationScoreSummary(evidence) : null;
  const previous = String(BigInt(release.revision) - 1n);
  return (
    <section
      className="release-comparison"
      aria-label={`Comparison for revision ${release.revision}`}
    >
      <header className="release-comparison-heading">
        <div>
          <p className="text-sm text-muted-foreground">{scope.channel} · Channel comparison</p>
          <h3>
            {release.revision === '1'
              ? 'Initial release'
              : `Revision ${previous} → ${release.revision}`}
          </h3>
        </div>
        <StatusBadge tone={current ? 'success' : 'neutral'}>
          {current ? 'Current release' : 'Historical release'}
        </StatusBadge>
      </header>
      <div className="release-comparison-identities">
        <div>
          <span>Previous channel release</span>
          <strong>
            {release.previousVersionId
              ? `Revision ${previous}`
              : release.revision === '1'
                ? 'No previous release'
                : 'Unavailable'}
          </strong>
          {release.previousVersionId && <code>{release.previousVersionId}</code>}
        </div>
        <div>
          <span>Selected release</span>
          <strong>Revision {release.revision}</strong>
          <code>{release.version.id}</code>
        </div>
      </div>
      <div className="release-comparison-body">
        <section className="release-comparison-files">
          <h4>Changed files{files && 'before' in files && <span>{changes.length}</span>}</h4>
          {!files ? (
            <p role="status">Loading verified files…</p>
          ) : 'error' in files ? (
            <p role="status">{files.error}</p>
          ) : selected ? (
            <>
              <Label htmlFor="release-diff-path" className="sr-only">
                Changed file
              </Label>
              <NativeSelect
                id="release-diff-path"
                value={selected.path}
                onChange={(event) => setPath(event.target.value)}
              >
                {changes.map((change) => (
                  <NativeSelectOption key={change.path} value={change.path}>
                    {change.operation} · {change.path}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <ContentDiff
                hideMap
                base={files.before}
                current={files.after}
                selectedPath={selected.path}
                labels={['Previous release', 'Selected release']}
              />
            </>
          ) : (
            <p>
              {release.revision === '1'
                ? 'The initial release contains no files.'
                : 'File contents are identical for these channel releases.'}
            </p>
          )}
        </section>
        <aside className="release-comparison-evidence">
          <h4>Release evidence</h4>
          {release.policyOverride && (
            <div>
              <StatusBadge tone="warning">Policy overridden</StatusBadge>
              <p>{release.policyOverride.reason}</p>
            </div>
          )}
          {!release.comparisonId ? (
            <>
              <StatusBadge>{release.revision === '1' ? 'Initial release' : 'No comparison recorded'}</StatusBadge>
              <p>{release.unevaluatedReason || 'No release reason recorded.'}</p>
            </>
          ) : summary && typeof evidence === 'object' ? (
            <>
              <StatusBadge tone="success">Bound evaluation</StatusBadge>
              <p className="text-xs text-muted-foreground">Mean reward</p>
              <dl className="release-result-values">
                <div>
                  <dt>Parent</dt>
                  <dd>{summary.parentMean === null ? '—' : formatReward(summary.parentMean)}</dd>
                </div>
                <div>
                  <dt>Candidate</dt>
                  <dd>
                    {summary.candidateMean === null ? '—' : formatReward(summary.candidateMean)}
                  </dd>
                </div>
              </dl>
              <p>
                {summary.pairedCount} of {summary.expectedCount} pairs scored
              </p>
              <p className="text-muted-foreground">
                Evaluation parent <code>{evidence.parentVersionId.slice(0, 8)}</code>
                {evidence.parentVersionId === release.previousVersionId
                  ? ' · previous channel version'
                  : ' · differs from previous channel version'}
              </p>
            </>
          ) : (
            <p role="status">{(evidence as string) || 'Checking evaluation binding…'}</p>
          )}
          <h4>Release actions</h4>
          {actions}
        </aside>
      </div>
      {((files && 'error' in files) || typeof evidence === 'string') && (
        <Button variant="outline" onClick={() => setAttempt(attempt + 1)}>
          Retry comparison
        </Button>
      )}
    </section>
  );
}
