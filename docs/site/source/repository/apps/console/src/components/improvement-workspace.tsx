import { assertInstalledConfiguration } from '../../../../examples/evaluation/adapter';
import { NativeSelect } from './ui/native-select';
import {
  evaluationConfiguration,
  evaluationPresets,
  evaluationHandoff,
  includedEvaluatorSetupCommand,
  type EvaluationPreset,
} from '../lib/evaluation-config';
import { Checkbox } from './ui/checkbox';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { compatibilityIssues } from '@acclimate/sdk/validation';
import type {
  BundlePayload,
  VersionMetadata,
  Comparison,
  Evaluation,
  Proposal,
} from '@acclimate/sdk';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { CopyButton } from './copy-button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Label } from './ui/label';
import { ConsoleLink } from './console-link';
import { bundleHref } from '../navigation';
import { useRouter } from '@tanstack/react-router';
import { usePendingChanges } from './pending-changes';
import { RelatedPendingNotice, useRelatedPending } from './related-pending';
import { runImprovement } from '../server/improvement-actions';
import type { ConsoleState } from '../server/channel';
import { ContentDiff } from './diff-content';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { comparisonSummary } from '../lib/comparison-summary';
import { mergeHistory, refreshKnownActive } from '../lib/improvement-history';
import {
  freezePending,
  loadPending,
  resolvePending,
  forgetPending,
  type PendingOperation,
} from '../lib/pending-operation';

type Ready = Extract<ConsoleState, { status: 'ready' }>;
export function ImprovementWorkspace({
  state,
  initial,
  mode = 'review',
  releaseTargetControl,
}: {
  state: Ready;
  initial: {
    candidate: string;
    draft: string;
    generation: number;
    proposal?: string;
    comparison?: string;
  };
  mode?: 'proposal' | 'review';
  releaseTargetControl?: ReactNode;
}) {
  const router = useRouter();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { setPendingChanges, discardVersion } = usePendingChanges();
  const lastDiscardVersion = useRef(discardVersion);
  const scope = { projectId: state.projectId, bundleId: state.bundleId, channel: state.channel };
  const [selectedProposal, setSelectedProposal] = useState<Proposal | null>(null);
  const [requests, setRequests] = useState<Evaluation[]>([]);
  const [requestCursor, setRequestCursor] = useState<string | null>(null);
  const loadedMoreRequests = useRef(false);
  const [candidate, setCandidate] = useState(initial.candidate),
    [detail, setDetail] = useState<{
      candidate: { version: VersionMetadata; payload: BundlePayload };
      parentPayload: BundlePayload;
    } | null>(null);
  const [hypothesis, setHypothesis] = useState(''),
    [paths, setPaths] = useState<string[]>([]),
    [evidence, setEvidence] = useState(''),
    [consent, setConsent] = useState(false);
  const [confirmedProposal, setConfirmedProposal] = useState<Proposal | null>(null);
  const proposalForm = useRef({ hypothesis, evidence, paths, consent });
  proposalForm.current = { hypothesis, evidence, paths, consent };
  function proposalMatchesSubmitted(body?: string) {
    if (!body) return false;
    try {
      const submitted = JSON.parse(body);
      const current = proposalForm.current;
      return (
        current.hypothesis === submitted.hypothesis &&
        current.evidence === submitted.evidence?.join('\n') &&
        JSON.stringify(current.paths) === JSON.stringify(submitted.allowedPaths) &&
        current.consent
      );
    } catch {
      return false;
    }
  }
  const [comparisonId, setComparisonId] = useState(''),
    [comparison, setComparison] = useState<Comparison | null>(null),
    [reason, setReason] = useState('');
  const [interruptionReasons, setInterruptionReasons] = useState<Record<string, string>>({});
  const [releaseReview, setReleaseReview] = useState<{
    reason?: string;
    comparisonId?: string;
    versionId: string;
    revision: string;
    generation: number;
  } | null>(null);
  const pendingScope = {
    actorScope: state.actorScope,
    ...scope,
    serviceIdentity: state.serviceIdentity,
  };
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const related = useRelatedPending(pendingScope, pending);
  const [evaluationProfile, setEvaluationProfile] = useState<EvaluationPreset | 'custom'>(
    'payment-retry',
  );
  const [customConfiguration, setCustomConfiguration] = useState('');
  const [savedEvaluationForm, setSavedEvaluationForm] = useState({
    profile: 'payment-retry' as EvaluationPreset | 'custom',
    customConfiguration: '',
  });
  const evaluationForm = useRef({ profile: evaluationProfile, customConfiguration });
  evaluationForm.current = { profile: evaluationProfile, customConfiguration };
  function acceptEvaluationForm(request: Evaluation) {
    const form = evaluationForm.current;
    try {
      const configured = evaluationConfiguration(
        form.profile === 'custom'
          ? JSON.parse(form.customConfiguration)
          : evaluationPresets[form.profile],
      );
      const recorded = evaluationConfiguration({
        datasetRevision: request.datasetRevision,
        graderRevision: request.graderRevision,
        runtime: request.runtime,
        expectedCases: request.expectedCases,
      });
      assertInstalledConfiguration(recorded, configured);
      setSavedEvaluationForm(form);
    } catch {
      // A different or invalid current form remains unsaved after recovery.
    }
  }
  let configurationError = '';
  let evaluationConfig: ReturnType<typeof evaluationConfiguration> | undefined;
  try {
    evaluationConfig = evaluationConfiguration(
      evaluationProfile === 'custom'
        ? JSON.parse(customConfiguration)
        : evaluationPresets[evaluationProfile],
    );
  } catch (error) {
    configurationError =
      error instanceof Error ? error.message : 'Invalid evaluation configuration.';
  }

  const requestsRef = useRef<Evaluation[]>([]);
  const scopeEpoch = useRef(0);
  useEffect(() => {
    requestsRef.current = requests;
  }, [requests]);
  useEffect(() => {
    scopeEpoch.current++;
    setRequests([]);
    requestsRef.current = [];
    loadedMoreRequests.current = false;
    setRequestCursor(null);
    setSelectedProposal(null);
    setReason('');
    setInterruptionReasons({});
    setReleaseReview(null);
    try {
      setPending(loadPending(sessionStorage, pendingScope));
    } catch {
      setMessage('Recovery storage is unavailable. No write will be sent.');
    }
    return () => {
      scopeEpoch.current++;
    };
  }, [state.actorScope, state.projectId, state.bundleId, state.channel]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function invoke(data: Record<string, unknown>) {
    const result = await runImprovement({ data: { ...data, scope } });
    if (!result.ok) throw new Error(result.message);
    return result;
  }
  async function refresh(cursor?: string) {
    const epoch = scopeEpoch.current;
    const r = await invoke({ action: 'requests', requestCursor: cursor });
    if (epoch !== scopeEpoch.current || !mounted.current) return;
    if ('requests' in r && r.requests) {
      const page = r.requests;
      setRequests((previous) => mergeHistory(previous, page.items, !!cursor));
      if (cursor || !loadedMoreRequests.current) setRequestCursor(page.nextCursor);
      if (cursor) loadedMoreRequests.current = true;
    }
    // Every known active row is refreshed directly, including rows on older pages.
    const updated = await refreshKnownActive(
      requestsRef.current,
      async (id) => {
        const value = await invoke({ action: 'request', id });
        return 'request' in value ? value.request : undefined;
      },
      () => epoch === scopeEpoch.current && mounted.current,
    );
    if (epoch !== scopeEpoch.current || !mounted.current) return;
    setRequests((previous) =>
      previous.map((row) => updated.find((next) => next.id === row.id) || row),
    );
    if (initial.proposal && initial.proposal !== 'new') {
      const proposal = await invoke({ action: 'proposal', id: initial.proposal });
      if (epoch !== scopeEpoch.current || !mounted.current) return;
      if ('proposal' in proposal && proposal.proposal) {
        setSelectedProposal(proposal.proposal);
        if (proposal.proposal.candidate) setCandidate(proposal.proposal.candidate.id);
      }
    }
  }
  useEffect(() => {
    setCandidate(initial.candidate);
    setRequests([]);
    loadedMoreRequests.current = false;
    setRequestCursor(null);
    setSelectedProposal(null);
  }, [initial.candidate, initial.proposal]);
  useEffect(() => {
    const dirty =
      Boolean(reason) ||
      Object.values(interruptionReasons).some(Boolean) ||
      (mode === 'review' &&
        (evaluationProfile !== savedEvaluationForm.profile ||
          customConfiguration !== savedEvaluationForm.customConfiguration)) ||
      (mode === 'proposal' && Boolean(hypothesis || evidence || paths.length || consent));
    setPendingChanges(dirty);
    return () => setPendingChanges(false);
  }, [
    mode,
    hypothesis,
    evidence,
    paths,
    consent,
    reason,
    interruptionReasons,
    evaluationProfile,
    customConfiguration,
    savedEvaluationForm,
    setPendingChanges,
  ]);
  useEffect(() => {
    if (lastDiscardVersion.current === discardVersion) return;
    lastDiscardVersion.current = discardVersion;
    setHypothesis('');
    setPaths([]);
    setEvidence('');
    setConsent(false);
    setReason('');
    setInterruptionReasons({});
    setReleaseReview(null);
    setEvaluationProfile('payment-retry');
    setCustomConfiguration('');
    setSavedEvaluationForm({ profile: 'payment-retry', customConfiguration: '' });
  }, [discardVersion]);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    let delay = 1500;
    async function poll() {
      try {
        await refresh();
      } catch {
        if (!stopped)
          setMessage('Could not refresh requests. Displayed execution state may be stale.');
      }
      if (!stopped) {
        timer = setTimeout(poll, delay);
        delay = Math.min(delay * 1.5, 15000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [initial.proposal, state.actorScope, state.projectId, state.bundleId, state.channel]);
  useEffect(() => {
    let stale = false;
    setDetail(null);
    setComparison(null);
    setComparisonId(initial.comparison || '');
    if (candidate)
      void invoke({ action: 'candidate', versionId: candidate })
        .then((r) => {
          if (!stale && 'candidate' in r && r.candidate && 'parentPayload' in r && r.parentPayload)
            setDetail({ candidate: r.candidate, parentPayload: r.parentPayload });
        })
        .catch((e) => {
          if (!stale) setMessage(e.message);
        });
    return () => {
      stale = true;
    };
  }, [candidate, state.actorScope, state.projectId, state.bundleId, state.channel]);
  useEffect(() => {
    let stale = false;
    setComparison(null);
    setReleaseReview(null);
    if (initial.comparison)
      void invoke({ action: 'comparison', id: initial.comparison })
        .then((result) => {
          if (!stale && 'comparison' in result && result.comparison) {
            setComparison(result.comparison);
            setComparisonId(initial.comparison!);
          }
        })
        .catch((error) => {
          if (!stale) setMessage(error.message);
        });
    return () => {
      stale = true;
    };
  }, [
    initial.comparison,
    candidate,
    state.actorScope,
    state.projectId,
    state.bundleId,
    state.channel,
  ]);
  function comparisonHref(id: string) {
    return bundleHref(scope, 'changes', {
      candidate: candidate || undefined,
      draft: initial.draft || undefined,
      generation: initial.generation || undefined,
      proposal: initial.proposal && initial.proposal !== 'new' ? initial.proposal : undefined,
      comparison: id,
    });
  }
  async function act(data: Record<string, unknown>) {
    let submittedProposalBody: string | undefined;
    setBusy(true);
    setMessage('');
    try {
      if (pending && ['evaluate', 'publish', 'propose'].includes(String(data.action)))
        throw Error('Resolve the earlier submitted snapshot first.');
      if (related.blocked && ['evaluate', 'publish', 'propose'].includes(String(data.action)))
        throw Error('Check the pending submission from the other page first.');
      const epoch = scopeEpoch.current;
      let r = await invoke({ ...data, key: crypto.randomUUID() });
      if (epoch !== scopeEpoch.current || !mounted.current) return;
      if ('command' in r && r.command) {
        const record = freezePending(
          sessionStorage,
          pendingScope,
          r.command.operationPath,
          JSON.parse(r.command.body),
          crypto.randomUUID(),
          data.action === 'propose'
            ? {
                consent: true,
                wholeParentBundle: true,
                authorizedEvidence: data.evidence as string[],
              }
            : undefined,
        );
        setPending(record);
        if (data.action === 'propose') submittedProposalBody = record.body;
        const submitted = await invoke({
          action: 'submitFrozen',
          key: record.key,
          operationPath: record.action,
          body: record.body!,
          disclosure: record.disclosure,
        });
        if ('result' in submitted && submitted.result) {
          resolvePending(sessionStorage, pendingScope);
          if (epoch !== scopeEpoch.current || !mounted.current) return;
          setPending(null);
          r =
            submitted.resultKind === 'proposal'
              ? { ok: true, proposal: submitted.result as Proposal }
              : submitted.resultKind === 'request'
                ? { ok: true, request: submitted.result as Evaluation }
                : { ok: true, promotion: submitted.result as import('@acclimate/sdk').Promotion };
        }
      }
      if (epoch !== scopeEpoch.current) return;
      if (!mounted.current) return;
      if ('comparison' in r && r.comparison) {
        setComparison(r.comparison);
        void router.navigate({ href: comparisonHref(r.comparison.id) });
      }
      if (data.action === 'propose' && 'proposal' in r && r.proposal) {
        if (proposalMatchesSubmitted(submittedProposalBody)) {
          setPendingChanges(false);
          setHypothesis('');
          setPaths([]);
          setEvidence('');
          setConsent(false);
          void router.navigate({
            href: bundleHref(scope, 'changes', { proposal: r.proposal.id }),
            ignoreBlocker: true,
          });
        } else {
          setConfirmedProposal(r.proposal);
          setMessage('Suggestion confirmed. Your current form has been preserved.');
        }
      }
      if ('request' in r && r.request) {
        if (data.action === 'evaluate') acceptEvaluationForm(r.request);
        setRequests((previous) => [
          r.request!,
          ...previous.filter((row) => row.id !== r.request!.id),
        ]);
        if (data.action === 'interrupt')
          setInterruptionReasons((previous) => ({ ...previous, [r.request!.id]: '' }));
        setMessage(
          data.action === 'interrupt'
            ? 'Interruption recorded. Your app may still be running.'
            : 'Evaluation request created. Run it in your app, then return here for the results.',
        );
      }
      if ('promotion' in r) {
        setReason('');
        setReleaseReview(null);
        setMessage('Release recorded. Refresh the channel before another decision.');
        await router.invalidate();
      }
      await refresh();
    } catch (e) {
      try {
        setPending(loadPending(sessionStorage, pendingScope));
      } catch {}
      setMessage(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setBusy(false);
    }
  }
  async function recover(action: 'retry' | 'lookup' | 'close') {
    if (!pending) return;
    setBusy(true);
    try {
      const epoch = scopeEpoch.current;
      const current = loadPending(sessionStorage, pendingScope);
      if (!current || current.key !== pending.key)
        throw Error('The recovery scope changed. Refresh before continuing.');
      if (action === 'retry' && !current.body)
        throw Error('Submitted text is unavailable. Check or close the earlier operation.');
      // Early development envelopes wrapped the exact body. Keep that safe same-route replay readable.
      const parsed = current.body ? JSON.parse(current.body) : null;
      const wrapped = parsed?.operationPath === current.action && typeof parsed.body === 'string';
      const operationPath = current.action;
      const body = wrapped ? parsed.body : current.body;
      const disclosure = current.disclosure || (wrapped ? parsed.disclosure : undefined);
      if (!operationPath)
        throw Error('The earlier operation route is unavailable. Keep this record for inspection.');
      const r = await invoke({
        action:
          action === 'retry' ? 'submitFrozen' : action === 'close' ? 'closeFrozen' : 'lookupFrozen',
        key: pending.key,
        operationPath,
        ...(action === 'retry' ? { body, disclosure } : {}),
      });
      if (epoch !== scopeEpoch.current || !mounted.current) return;
      const committed = 'result' in r || ('outcome' in r && r.outcome?.status === 'committed');
      const closed = 'outcome' in r && r.outcome?.status === 'closed';
      if (committed || closed) {
        resolvePending(sessionStorage, pendingScope);
        setPending(null);
        setMessage(
          committed
            ? 'The earlier operation committed. Refreshed its result.'
            : 'The earlier operation is closed. You can review a new request.',
        );
        const result =
          'result' in r
            ? r.result
            : 'outcome' in r && r.outcome?.status === 'committed'
              ? r.outcome.result
              : undefined;
        if (result && operationPath.endsWith('/proposals')) {
          if (proposalMatchesSubmitted(body)) {
            setPendingChanges(false);
            void router.navigate({
              href: bundleHref(scope, 'changes', { proposal: result.id }),
              ignoreBlocker: true,
            });
          } else {
            setConfirmedProposal(result as Proposal);
            setMessage('The earlier suggestion committed. Your current form has been preserved.');
          }
        }
        if (result && operationPath.endsWith('/evaluation-requests')) {
          setRequests((previous) => mergeHistory(previous, [result as Evaluation]));
          acceptEvaluationForm(result as Evaluation);
        }
        await refresh();
        await router.invalidate();
      } else
        setMessage(
          'The earlier operation has not been observed. It may still commit. Retry its exact snapshot or close it before creating a new request.',
        );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Recovery remains uncertain.');
    } finally {
      setBusy(false);
    }
  }
  const base = {
    versionId: candidate,
    expectedRevision: state.resolution.revision,
    draftId: initial.draft,
    generation: initial.generation,
    proposalId: initial.proposal && initial.proposal !== 'new' ? initial.proposal : undefined,
  };
  const compatibility = detail
    ? compatibilityIssues(detail.candidate.payload, state.compatibilityTarget)
    : [];
  const currentBase = detail?.candidate.version.parentVersionId === state.resolution.version.id;
  const candidateRequests = requests.filter((request) => request.candidateVersionId === candidate);
  const isCurrentRelease = Boolean(candidate) && candidate === state.resolution.version.id;
  const publishStage = Boolean(comparison) || isCurrentRelease;
  return (
    <div className="min-w-0 space-y-4 text-sm">
      <RelatedPendingNotice recovery={related} scope={scope} canEdit={state.canEdit} />
      {message && <p role="status">{message}</p>}
      {confirmedProposal && (
        <ConsoleLink
          href={bundleHref(scope, 'changes', { proposal: confirmedProposal.id })}
          className="text-sm underline"
        >
          Open submitted suggestion
        </ConsoleLink>
      )}
      {pending && (
        <section
          className="workspace-panel space-y-3 border-amber-500/50 p-4"
          aria-label="Unconfirmed operation"
        >
          <h2 className="font-semibold" role="status">
            {busy ? 'Waiting for submission confirmation…' : 'Submission needs confirmation'}
          </h2>
          <p className="text-muted-foreground">
            New submissions are paused until the result is confirmed or the operation is closed.
          </p>
          <Button disabled={busy} onClick={() => void recover('lookup')}>
            Check result
          </Button>
          <details>
            <summary className="cursor-pointer">Recovery details</summary>
            <div className="mt-3 space-y-3">
              {pending.body && (
                <Button disabled={busy} variant="outline" onClick={() => void recover('retry')}>
                  Retry exact submitted snapshot
                </Button>
              )}{' '}
              <Button disabled={busy} variant="outline" onClick={() => void recover('close')}>
                Close earlier operation before a new request
              </Button>{' '}
              {pending.body && (
                <Button
                  disabled={busy}
                  variant="outline"
                  onClick={() => setPending(forgetPending(sessionStorage, pendingScope))}
                >
                  Forget submitted text
                </Button>
              )}
              <p>
                Closing preserves any known commit and rejects delayed writes. Forgetting text does
                not cancel the submission or prove that execution failed. Without submitted text,
                exact retry is unavailable.
              </p>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(pending, null, 2)}
              </pre>
            </div>
          </details>
        </section>
      )}
      {mode === 'proposal' && (
        <section className="workspace-panel space-y-4 p-4">
          <h2 className="text-lg font-semibold">Suggest a change</h2>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground">
              Based on {state.channel} · revision {state.resolution.revision}
            </p>
            {releaseTargetControl}
          </div>
          <p className="text-muted-foreground">
            Describe the change and choose which files the provider may edit. You’ll review its
            suggestion before publishing.
          </p>
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">Source release details</summary>
            <p className="mt-2 break-all">
              Published parent: {state.resolution.version.id} · {state.resolution.version.digest}
            </p>
          </details>
          <div className="space-y-1">
            <Label htmlFor="proposal-hypothesis">Hypothesis</Label>
            <Textarea
              id="proposal-hypothesis"
              disabled={busy || !state.canEdit}
              value={hypothesis}
              onChange={(e) => setHypothesis(e.target.value)}
            />
          </div>
          <fieldset>
            <legend>Editable paths</legend>
            {state.payload.files.map((f) => (
              <label
                key={f.path}
                data-slot="label"
                className="flex min-h-8 items-center gap-2 text-sm"
              >
                <Checkbox
                  aria-label={f.path}
                  disabled={busy || !state.canEdit}
                  checked={paths.includes(f.path)}
                  onCheckedChange={(checked) =>
                    setPaths((p) =>
                      checked === true ? [...p, f.path] : p.filter((x) => x !== f.path),
                    )
                  }
                />{' '}
                {f.path}
              </label>
            ))}
          </fieldset>
          <div className="space-y-1">
            <Label htmlFor="proposal-evidence">Authorized evidence (one item per line)</Label>
            <Textarea
              id="proposal-evidence"
              disabled={busy || !state.canEdit}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </div>
          <p className="text-sm">
            The operator-configured provider receives the whole parent bundle, including reusable
            memory, and this evidence. Editable paths restrict changes, not reading. Private session
            memory remains app-owned.
          </p>
          <label data-slot="label" className="block min-h-8">
            <Checkbox
              aria-label="Authorize bundle disclosure"
              disabled={busy || !state.canEdit}
              checked={consent}
              onCheckedChange={(checked) => setConsent(checked === true)}
            />{' '}
            I authorize sharing the entire selected bundle and supplied evidence with the provider.
          </label>
          <Button
            disabled={
              !state.canEdit ||
              busy ||
              !!pending ||
              related.blocked ||
              !consent ||
              !hypothesis.trim() ||
              !paths.length
            }
            onClick={() =>
              void act({
                action: 'propose',
                parentVersionId: state.resolution.version.id,
                hypothesis,
                allowedPaths: paths,
                evidence: evidence.split('\n').filter(Boolean),
                consent,
              })
            }
          >
            Request suggestion
          </Button>
        </section>
      )}
      {mode === 'review' && (
        <>
          <section className="workspace-panel space-y-4 p-4" aria-label="Saved change review">
            <ol
              aria-label="Change workflow"
              className="flex flex-wrap items-center gap-2 text-muted-foreground"
            >
              <li aria-current={!candidate ? 'step' : undefined}>
                {candidate ? '1. Saved change' : <Badge>1. Prepare suggestion</Badge>}
              </li>
              <li aria-hidden="true">→</li>
              <li aria-current={candidate && !publishStage ? 'step' : undefined}>
                {candidate && !publishStage ? <Badge>2. Evaluate</Badge> : '2. Evaluate'}
              </li>
              <li aria-hidden="true">→</li>
              <li aria-current={publishStage ? 'step' : undefined}>
                {publishStage ? <Badge>3. Publish</Badge> : '3. Publish'}
              </li>
            </ol>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">
                  {isCurrentRelease
                    ? `Published to ${state.channel}`
                    : publishStage
                      ? 'Review evidence and publish'
                      : candidate
                        ? 'Evaluate saved change'
                        : selectedProposal?.status === 'failed'
                          ? 'Suggestion failed'
                          : 'Suggestion in progress'}
                </h2>
                <p className="text-muted-foreground">
                  {initial.draft ? `Saved draft · generation ${initial.generation}` : 'Suggestion'}
                  {candidate && ' · Saved snapshot'}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <strong>Release target: {state.channel}</strong>
                {releaseTargetControl}
                {isCurrentRelease && (
                  <Button asChild>
                    <ConsoleLink href={bundleHref(scope, 'releases')}>
                      View release history
                    </ConsoleLink>
                  </Button>
                )}
              </div>
            </div>
            {selectedProposal && (
              <div className="space-y-2">
                <p>
                  {selectedProposal.status === 'queued'
                    ? 'Waiting for provider'
                    : selectedProposal.status === 'running'
                      ? 'Provider is preparing a suggestion'
                      : selectedProposal.status === 'succeeded'
                        ? 'Suggestion ready'
                        : 'Suggestion failed'}
                </p>
                {selectedProposal.rationale && <p>{selectedProposal.rationale}</p>}
                {selectedProposal.error && <p role="alert">{selectedProposal.error}</p>}
                {!selectedProposal.candidate && (
                  <p>
                    No candidate is available yet.{' '}
                    {['queued', 'running'].includes(selectedProposal.status)
                      ? 'The configured provider is processing this request.'
                      : 'This request did not produce a candidate.'}
                    {!['queued', 'running'].includes(selectedProposal.status) && state.canEdit && (
                      <>
                        {' '}
                        <ConsoleLink
                          className="underline"
                          href={bundleHref(scope, 'changes', { proposal: 'new' })}
                        >
                          Start a new suggestion
                        </ConsoleLink>
                      </>
                    )}
                  </p>
                )}
              </div>
            )}
            {initial.draft && (
              <ConsoleLink
                className="inline-block underline"
                href={bundleHref(scope, 'changes', { draft: initial.draft })}
              >
                Back to draft editor
              </ConsoleLink>
            )}
            {detail?.candidate && (
              <>
                {compatibility.length > 0 && (
                  <ul role="alert">
                    {compatibility.map((issue, index) => (
                      <li key={index}>
                        {issue.path || issue.package || 'Bundle'}: {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
                {!currentBase && !isCurrentRelease && (
                  <p role="alert">
                    The selected channel has a different published parent. This saved candidate
                    remains readable; create a change from the current release before evaluating or
                    publishing to this channel.{' '}
                    <ConsoleLink
                      className="underline"
                      href={bundleHref(scope, 'changes', { draft: 'new' })}
                    >
                      New draft from current release
                    </ConsoleLink>
                  </p>
                )}
                <details>
                  <summary className="cursor-pointer font-medium">Review file changes</summary>
                  <div className="mt-4">
                    <ContentDiff base={detail.parentPayload} current={detail.candidate.payload} />
                  </div>
                </details>
                <details>
                  <summary className="cursor-pointer">Saved snapshot details</summary>
                  <p className="mt-3">
                    Revision {state.resolution.revision} · compatibility target{' '}
                    {state.compatibilityTarget}
                    {state.compatibilityTarget === 'generic'
                      ? ' · native compatibility unchecked'
                      : ''}
                  </p>
                  {selectedProposal && (
                    <p>
                      Suggestion {selectedProposal.id} · {selectedProposal.attempts} attempts
                    </p>
                  )}
                  <p className="break-all">Immutable version ID: {candidate}</p>
                  <CopyButton value={candidate} label="Copy version ID" />
                  <p className="break-all">Verified digest: {detail.candidate.version.digest}</p>
                  <p className="break-all">
                    Base: {detail.candidate.version.parentVersionId} · current:{' '}
                    {state.resolution.version.id}
                  </p>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(detail.candidate, null, 2)}
                  </pre>
                </details>
              </>
            )}
          </section>
          {detail?.candidate && !isCurrentRelease && (
            <section className="workspace-panel space-y-4 p-4" aria-label="Release path">
              <h2 className="font-semibold">2. Evaluate in your app</h2>
              <p className="text-muted-foreground">
                Create a request, run it with your app’s evaluator, then return to inspect the
                results. The console does not run evaluations.
              </p>
              <details open={candidateRequests.length === 0}>
                <summary className="cursor-pointer font-medium">
                  {candidateRequests.length
                    ? 'Create another evaluation request'
                    : 'Set up evaluation request'}
                </summary>
                <div className="mt-4 space-y-4">
                  <label className="block space-y-1">
                    Evaluation configuration
                    <NativeSelect
                      className="w-full"
                      aria-label="Evaluation configuration"
                      value={evaluationProfile}
                      disabled={busy || !!pending || related.blocked}
                      onChange={(event) =>
                        setEvaluationProfile(event.target.value as EvaluationPreset | 'custom')
                      }
                    >
                      <option value="payment-retry">Payment retry simulator · model-free</option>
                      <option value="presence-contract">File presence contract · model-free</option>
                      <option value="codex-luna-review">Native Codex review · Luna</option>
                      <option value="custom">My app's installed evaluator</option>
                    </NativeSelect>
                  </label>
                  {evaluationProfile === 'custom' && (
                    <label className="block space-y-1">
                      Public evaluator configuration (JSON)
                      <Textarea
                        aria-label="Public evaluator configuration (JSON)"
                        className="min-h-40 font-mono"
                        value={customConfiguration}
                        disabled={busy || !!pending || related.blocked}
                        onChange={(event) => setCustomConfiguration(event.target.value)}
                      />
                      <span className="text-muted-foreground">
                        Paste the configuration your installed app describes: datasetRevision,
                        graderRevision, runtime (including configId/configRevision), and
                        expectedCases. Keep credentials and case contents in the app.
                      </span>
                    </label>
                  )}
                  {configurationError && (
                    <p role="alert" className="text-destructive">
                      {configurationError}
                    </p>
                  )}
                  <Button
                    disabled={
                      busy ||
                      !!pending ||
                      related.blocked ||
                      !state.canEdit ||
                      !currentBase ||
                      !evaluationConfig
                    }
                    onClick={() =>
                      void act({ action: 'evaluate', ...base, configuration: evaluationConfig })
                    }
                  >
                    Create new evaluation request
                  </Button>
                  <p className="text-muted-foreground">
                    {evaluationProfile === 'payment-retry'
                      ? 'The simulator needs payment-policy.json data. Three scenarios × two repetitions, no model calls. This checks orchestration, not native agent quality.'
                      : evaluationProfile === 'presence-contract'
                        ? 'Checks nonempty instruction and skill files. This is a delivery contract check, not a behavioral score.'
                        : evaluationProfile === 'codex-luna-review'
                          ? 'The included checkout review and grader use Codex. After separate setup, that adapter requires --live and allows up to four bounded Luna turns. Creating a request makes no model call.'
                          : 'Your app runs its installed adapter and grader. The service freezes these settings and records evidence; it never executes configuration as code.'}
                  </p>
                </div>
              </details>
            </section>
          )}
          {candidate && (
            <>
              <section className="workspace-panel space-y-4 p-4" aria-label="Evaluation requests">
                <h2 className="font-semibold">Evaluation results</h2>
                {!candidateRequests.length && (
                  <div className="space-y-3">
                    <p className="text-muted-foreground">
                      {requestCursor
                        ? 'No matching requests on the loaded pages. Check older requests for this saved change.'
                        : 'No evaluation requests found for this saved change.'}
                    </p>
                    {requestCursor && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => void refresh(requestCursor)}
                      >
                        Load older requests
                      </Button>
                    )}
                  </div>
                )}
                {candidateRequests.map((request, index) => {
                  const command = includedEvaluatorSetupCommand(
                    state.bundleId,
                    request.id,
                    request,
                  );
                  const handoff = evaluationHandoff(
                    state.publicApiUrl,
                    state.projectId,
                    state.bundleId,
                    request.id,
                    request,
                  );
                  return (
                    <details
                      key={request.id}
                      open={index === 0}
                      className="space-y-3 border-t pt-3"
                      aria-label={`Evaluation request ${request.id.slice(0, 8)}`}
                    >
                      <summary className="cursor-pointer font-medium">
                        {request.comparisonId
                          ? 'Results available'
                          : request.status === 'requested'
                            ? 'Ready to run in your app'
                            : `Last reported: ${request.status}`}{' '}
                        · {new Date(request.updatedAt).toLocaleString()}
                      </summary>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="font-medium">
                            Request {request.id.slice(0, 8)} · last reported {request.status}
                          </h3>
                          <p className="text-muted-foreground">
                            Updated{' '}
                            <time dateTime={request.updatedAt}>
                              {new Date(request.updatedAt).toLocaleString()}
                            </time>{' '}
                            ·{' '}
                            {request.requireBoundEvidence
                              ? 'bound evidence required'
                              : 'legacy completion allowed'}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <CopyButton value={request.id} label="Copy request ID" />
                          <CopyButton value={handoff} label="Copy configuration" />
                        </div>
                      </div>
                      {request.status === 'running' && (
                        <p>Last reported running. Check your app for current execution status.</p>
                      )}
                      {request.error && <p role="alert">{request.error}</p>}
                      <p>
                        {request.comparisonId
                          ? 'Inspect the returned evidence before deciding to release.'
                          : ['requested', 'running'].includes(request.status)
                            ? "Hand the request ID and public configuration to your app's installed evaluator. It must match the frozen configuration. Creating a request does not execute work."
                            : 'No comparison was reported. Review the last reported state and app logs before creating another request.'}
                      </p>
                      {request.comparisonId && (
                        <Button asChild variant="outline">
                          <ConsoleLink href={comparisonHref(request.comparisonId)}>
                            Inspect evidence
                          </ConsoleLink>
                        </Button>
                      )}
                      <details>
                        <summary className="cursor-pointer">Request details</summary>
                        <p className="break-all">Request ID: {request.id}</p>
                        <p className="break-all">Public API: {state.publicApiUrl}</p>
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                          {handoff}
                        </pre>
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                          {JSON.stringify(request, null, 2)}
                        </pre>
                      </details>
                      {command && (
                        <details>
                          <summary className="cursor-pointer">
                            Included checkout setup (required)
                          </summary>
                          <div className="my-3 space-y-3 text-muted-foreground">
                            <p>
                              Install this checkout on the machine that will run evaluations. Ask
                              your service operator for a dedicated evaluator machine principal with
                              read/write access to this project; propose and promote access are not
                              needed.
                            </p>
                            <p>
                              Connections issues content-read and receipt-write credentials for
                              published delivery. Those credentials cannot run evaluations or read
                              unpublished candidates. Use the dedicated evaluator credential below.
                            </p>
                            <p>
                              Create a private directory (0700) and a JSON file (0600) outside
                              version control. Replace these placeholders privately with your app’s
                              settings. Keep credentials out of the console, chat, logs and command
                              arguments.
                            </p>
                            <pre
                              tabIndex={0}
                              aria-label="Private evaluator configuration template"
                              className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
                            >
                              {JSON.stringify(
                                {
                                  schemaVersion: 1,
                                  serviceUrl: 'https://api.example.com',
                                  projectId: 'YOUR_PROJECT_ID',
                                  evaluatorPrincipalId: 'YOUR_DEDICATED_EVALUATOR_PRINCIPAL',
                                  evaluatorToken: 'YOUR_SCOPED_EVALUATOR_TOKEN',
                                  journalRoot: '/absolute/private/evaluation-journals',
                                },
                                null,
                                2,
                              )}
                            </pre>
                            <p>
                              Use the same service and project as this request. Set journalRoot to
                              an absolute, owner-only directory. Replace the --config path below
                              with your private JSON file, then run the command from your installed
                              checkout. Matching public settings do not mean the adapter is
                              installed. The console does not execute this command.
                            </p>
                            <p>
                              For recovery, retain the same service, project, evaluator principal
                              and original journal directory. Do not delete or relocate journals to
                              retry execution.
                            </p>
                          </div>
                          <CopyButton value={command} label="Copy setup-required command" />
                          <code className="block overflow-auto whitespace-pre-wrap break-all">
                            {command}
                          </code>
                        </details>
                      )}
                      {['requested', 'running'].includes(request.status) && (
                        <details>
                          <summary className="cursor-pointer">Record an interruption</summary>
                          <div className="mt-3 space-y-3">
                            <p role="note">
                              Recording an interruption does not stop the external app or its
                              charges.
                            </p>
                            <label className="block space-y-1">
                              Interruption reason (required)
                              <Textarea
                                aria-label={`Interruption reason for ${request.id}`}
                                required
                                value={interruptionReasons[request.id] || ''}
                                maxLength={1000}
                                onChange={(event) =>
                                  setInterruptionReasons((previous) => ({
                                    ...previous,
                                    [request.id]: event.target.value,
                                  }))
                                }
                              />
                            </label>
                            <Button
                              variant="outline"
                              disabled={
                                busy || !state.canEdit || !interruptionReasons[request.id]?.trim()
                              }
                              onClick={() =>
                                void act({
                                  action: 'interrupt',
                                  id: request.id,
                                  reason: interruptionReasons[request.id],
                                })
                              }
                            >
                              Mark interrupted
                            </Button>
                          </div>
                        </details>
                      )}
                    </details>
                  );
                })}
                {requestCursor && candidateRequests.length > 0 && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void refresh(requestCursor)}
                  >
                    Load more evaluation requests
                  </Button>
                )}
              </section>
              <section
                className="workspace-panel space-y-4 p-4"
                aria-label="Evidence and release decision"
              >
                <h2 className="font-semibold">3. Publish to {state.channel}</h2>
                <details>
                  <summary className="cursor-pointer">Comparison lookup and details</summary>
                  <div className="mt-3 space-y-3">
                    <label className="block space-y-1">
                      Comparison ID
                      <Input
                        value={comparisonId}
                        onChange={(event) => {
                          setComparisonId(event.target.value);
                          setComparison(null);
                          setReleaseReview(null);
                        }}
                      />
                    </label>
                    <Button
                      variant="outline"
                      disabled={busy || !comparisonId}
                      onClick={() => void act({ action: 'comparison', id: comparisonId })}
                    >
                      Inspect comparison
                    </Button>
                    {comparison && (
                      <>
                        <p className="break-all">Selected comparison: {comparison.id}</p>
                        <CopyButton value={comparison.id} label="Copy comparison ID" />
                        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
                          {JSON.stringify(comparison, null, 2)}
                        </pre>
                      </>
                    )}
                  </div>
                </details>
                {comparison ? (
                  <>
                    <ComparisonEvidence comparison={comparison} />
                    {(comparison.candidateVersionId !== candidate ||
                      comparison.parentVersionId !== state.resolution.version.id) && (
                      <p role="alert">
                        This evidence does not match the saved candidate and current release target.
                        Release with this evidence is unavailable.
                      </p>
                    )}
                    <Button
                      disabled={
                        busy ||
                        !!pending ||
                        related.blocked ||
                        compatibility.length > 0 ||
                        !state.canEdit ||
                        !detail?.candidate ||
                        !currentBase ||
                        !comparison.complete ||
                        comparison.candidateVersionId !== candidate ||
                        comparison.parentVersionId !== state.resolution.version.id
                      }
                      onClick={() =>
                        setReleaseReview({
                          comparisonId: comparison.id,
                          versionId: candidate,
                          revision: state.resolution.revision,
                          generation: initial.generation,
                        })
                      }
                    >
                      Review release with this evidence
                    </Button>
                  </>
                ) : (
                  <p className="text-muted-foreground">
                    Open “Inspect evidence” on a completed request to review the results before
                    publishing.
                  </p>
                )}
                {detail?.candidate && !isCurrentRelease && (
                  <details className="border-t pt-3">
                    <summary className="cursor-pointer font-medium">
                      Publish without evaluation
                    </summary>
                    <div className="mt-4 space-y-4">
                      <p>
                        This release will record that no evaluation supports it. Only the saved
                        snapshot above will be published.
                      </p>
                      <label className="block space-y-1">
                        Manual release reason (required)
                        <Textarea
                          aria-label="Manual release reason"
                          required
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          maxLength={1000}
                        />
                      </label>
                      <Button
                        disabled={
                          busy ||
                          !!pending ||
                          related.blocked ||
                          compatibility.length > 0 ||
                          !state.canEdit ||
                          !currentBase ||
                          !reason.trim()
                        }
                        onClick={() =>
                          setReleaseReview({
                            reason,
                            versionId: candidate,
                            revision: state.resolution.revision,
                            generation: initial.generation,
                          })
                        }
                      >
                        Review manual release
                      </Button>
                    </div>
                  </details>
                )}
                <details className="text-muted-foreground">
                  <summary className="cursor-pointer">What publishing changes</summary>
                  <p className="mt-2">
                    Publishing updates {state.channel} for future resolutions. Pinned workspaces
                    stay pinned. A changed draft generation, parent or channel revision requires
                    fresh review.
                  </p>
                </details>
              </section>
              <Dialog
                open={!!releaseReview}
                onOpenChange={(open) => {
                  if (!open && !busy) setReleaseReview(null);
                }}
              >
                <DialogContent className="max-h-[85dvh] overflow-y-auto text-sm">
                  <DialogHeader>
                    <DialogTitle>Publish to {state.channel}?</DialogTitle>
                    <DialogDescription>
                      Publish the saved snapshot reviewed on this page. The full diff remains on the
                      page.
                    </DialogDescription>
                  </DialogHeader>
                  <p>
                    Target: <strong>{state.channel}</strong> · revision {releaseReview?.revision}
                  </p>
                  <p className="break-all">
                    Candidate: {releaseReview?.versionId}
                    {initial.draft
                      ? ` · generation ${releaseReview?.generation}`
                      : ' · immutable suggestion snapshot'}
                  </p>
                  {releaseReview?.comparisonId ? (
                    <p className="break-all">Selected evidence: {releaseReview.comparisonId}</p>
                  ) : (
                    <>
                      <p>No evaluation supports this release.</p>
                      <p className="whitespace-pre-wrap break-words">
                        Reason: {releaseReview?.reason}
                      </p>
                    </>
                  )}
                  <DialogFooter>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setReleaseReview(null)}
                    >
                      Back to review
                    </Button>
                    <Button
                      disabled={
                        busy ||
                        !!pending ||
                        related.blocked ||
                        compatibility.length > 0 ||
                        !state.canEdit ||
                        !currentBase ||
                        !releaseReview ||
                        releaseReview.versionId !== candidate ||
                        releaseReview.revision !== state.resolution.revision ||
                        releaseReview.generation !== initial.generation ||
                        (!!releaseReview.comparisonId &&
                          (!comparison?.complete ||
                            comparison.id !== releaseReview.comparisonId ||
                            comparison.candidateVersionId !== candidate ||
                            comparison.parentVersionId !== state.resolution.version.id))
                      }
                      onClick={() => {
                        if (releaseReview)
                          void act({
                            action: 'publish',
                            ...base,
                            ...(releaseReview.comparisonId
                              ? { comparisonId: releaseReview.comparisonId }
                              : { reason: releaseReview.reason }),
                          });
                      }}
                    >
                      {releaseReview?.comparisonId
                        ? 'Publish with selected evidence'
                        : 'Publish without evaluation'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
        </>
      )}
    </div>
  );
}

function ComparisonEvidence({ comparison }: { comparison: Comparison }) {
  const summary = comparisonSummary(comparison);
  return (
    <div className="space-y-3">
      <p>
        <strong>
          {comparison.complete ? 'Complete inventory' : 'Incomplete evidence; not a win'}
        </strong>{' '}
        · {summary.scoredPairs} scored pairs / {comparison.expectedCases.length} expected pairs
      </p>
      <p>
        {summary.missingGrades} missing grades · {summary.executionFailures} execution failures ·
        total cost {summary.costUsd === null ? 'unknown' : `$${summary.costUsd}`}
      </p>
      <p>
        {comparison.evaluation
          ? `Bound to request ${comparison.evaluation.requestId.slice(0, 8)}, attempt ${comparison.evaluation.attemptId}`
          : 'Legacy / unbound comparison evidence'}
      </p>
      <p className="break-all">
        Dataset {comparison.datasetRevision} · grader {comparison.graderRevision}
      </p>
      <Table className="min-w-[32rem] text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>Case / repetition</TableHead>
            <TableHead>Parent</TableHead>
            <TableHead>Candidate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {summary.rows.map(({ key, pair }) => (
            <TableRow key={`${key.caseId}:${key.repetition}`}>
              <TableCell className="whitespace-normal break-words align-top">
                {key.caseId} / {key.repetition}
              </TableCell>
              {([pair?.parent, pair?.candidate] as const).map((outcome, index) => (
                <TableCell key={index} className="whitespace-normal align-top">
                  {outcome ? (
                    <div className="space-y-1">
                      <p>
                        {outcome.executionStatus} · {outcome.gradingStatus}
                      </p>
                      <p>
                        Reward {outcome.reward ?? 'missing'} · cost{' '}
                        {outcome.usage?.costUsd === undefined
                          ? 'unknown'
                          : `$${outcome.usage.costUsd}`}
                      </p>
                      {(outcome.outputRef || outcome.error) && (
                        <details>
                          <summary className="cursor-pointer">Output / error</summary>
                          {outcome.error && (
                            <p className="whitespace-pre-wrap break-all">{outcome.error}</p>
                          )}
                          {outcome.outputRef && (
                            <pre className="max-h-80 min-w-0 overflow-auto whitespace-pre-wrap break-all text-sm">
                              {outcome.outputRef}
                            </pre>
                          )}
                        </details>
                      )}
                    </div>
                  ) : (
                    <p>Missing outcome · grade missing · cost unknown</p>
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-muted-foreground">
        Missing outcomes and grades remain missing. Unknown usage is not zero. Complete evidence
        alone is not a win, statistical proof or release approval.
      </p>
    </div>
  );
}
