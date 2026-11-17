import { SuggestionComposer } from './suggestion-composer';
import { SyntaxCode } from './syntax-code';
import { Disclosure, DisclosureTrigger, DisclosureContent } from './ui/disclosure';
import {
  ArrowRight,
  ChartNoAxesCombined,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  FlaskConical,
  Radio,
} from 'lucide-react';
import { EvaluationScorecard } from './evaluation-scorecard';
import { EvaluationActivity } from './evaluation-activity';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { NativeSelect } from './ui/native-select';
import {
  evaluationConfiguration,
  evaluationHandoff,
  includedEvaluatorSetupCommand,
  selectedEvaluationConfiguration,
  paymentSimulatorIssue,
  applicationEvaluatorRunCommand,
  type EvaluationChoice,
} from '../lib/evaluation-config';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { compatibilityIssues, evaluationDescriptorDifferences } from '@acclimate/sdk/validation';
import type {
  BundlePayload,
  VersionMetadata,
  Comparison,
  Evaluation,
  EvaluationProgressView,
  Proposal,
} from '@acclimate/sdk';
import { Button } from './ui/button';
import { EvaluationHandoffDownload } from './evaluation-handoff-download';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { ComparisonEvidence, comparisonIncompleteReason } from './comparison-evidence';
import { reviewNextStep } from '../lib/review-next-step';
import { mergeHistory, refreshKnownActive } from '../lib/improvement-history';
import { requestEvidence } from '../lib/evaluation-history';
import { evaluationRequestLabels } from '../lib/evaluation-request-labels';
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
}: {
  state: Ready;
  initial: {
    candidate: string;
    draft: string;
    generation: number;
    proposal?: string;
    comparison?: string;
    request?: string;
  };
  mode?: 'proposal' | 'review';
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
  const [directRequest, setDirectRequest] = useState<Evaluation | null>(null);
  const [selectedProgress, setSelectedProgress] = useState<EvaluationProgressView | null>(null);
  const [requestError, setRequestError] = useState('');
  const [requestLoading, setRequestLoading] = useState(false);
  const [showAllRequests, setShowAllRequests] = useState(false);
  const releaseReturnRef = useRef<HTMLElement | null>(null);
  const createRequestAction = useRef<HTMLButtonElement>(null);
  const requestOwnsFocus = useRef(false);
  const requestFocusId = useRef<string | null>(null);
  useEffect(() => {
    const releaseFocus = (event: Event) => {
      if (event.target !== createRequestAction.current && event.target !== document.body)
        requestOwnsFocus.current = false;
    };
    const releaseOnPointer = (event: PointerEvent) => {
      if (!createRequestAction.current?.contains(event.target as Node))
        requestOwnsFocus.current = false;
    };
    document.addEventListener('focusin', releaseFocus);
    document.addEventListener('pointerdown', releaseOnPointer);
    return () => {
      document.removeEventListener('focusin', releaseFocus);
      document.removeEventListener('pointerdown', releaseOnPointer);
    };
  }, []);
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
  const comparisonRef = useRef(comparison);
  comparisonRef.current = comparison;
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
  const [evaluationProfile, setEvaluationProfile] = useState<EvaluationChoice>('');
  const [customConfiguration, setCustomConfiguration] = useState('');
  const [savedEvaluationForm, setSavedEvaluationForm] = useState({
    profile: '' as EvaluationChoice,
    customConfiguration: '',
  });
  const evaluationForm = useRef({ profile: evaluationProfile, customConfiguration });
  evaluationForm.current = { profile: evaluationProfile, customConfiguration };
  function acceptEvaluationForm(request: Evaluation) {
    const form = evaluationForm.current;
    try {
      const configured = selectedEvaluationConfiguration(form.profile, form.customConfiguration);
      const recorded = evaluationConfiguration({
        datasetRevision: request.datasetRevision,
        graderRevision: request.graderRevision,
        runtime: request.runtime,
        expectedCases: request.expectedCases,
      });
      if (evaluationDescriptorDifferences(recorded, configured).length) return;
      setSavedEvaluationForm(form);
    } catch {
      // A different or invalid current form remains unsaved after recovery.
    }
  }
  let configurationError = '';
  let evaluationConfig: ReturnType<typeof evaluationConfiguration> | undefined;
  try {
    evaluationConfig = selectedEvaluationConfiguration(evaluationProfile, customConfiguration);
  } catch (error) {
    configurationError =
      error instanceof Error ? error.message : 'Invalid evaluation configuration.';
  }

  const requestsRef = useRef<Evaluation[]>([]);
  const directRequestRef = useRef<Evaluation | null>(null);
  const selectionRef = useRef({
    request: initial.request,
    candidate,
    initialCandidate: initial.candidate,
    comparison: initial.comparison,
    actor: state.actorScope,
    project: state.projectId,
    bundle: state.bundleId,
    channel: state.channel,
  });
  selectionRef.current = {
    request: initial.request,
    candidate,
    initialCandidate: initial.candidate,
    comparison: initial.comparison,
    actor: state.actorScope,
    project: state.projectId,
    bundle: state.bundleId,
    channel: state.channel,
  };
  const scopeEpoch = useRef(0);
  useEffect(() => {
    requestsRef.current = requests;
  }, [requests]);
  useEffect(() => {
    scopeEpoch.current++;
    setRequests([]);
    setDirectRequest(null);
    directRequestRef.current = null;
    setRequestError('');
    setRequestLoading(false);
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
    const selected = directRequestRef.current;
    const selection = selectionRef.current;
    const currentSelection = () =>
      epoch === scopeEpoch.current &&
      mounted.current &&
      selectionRef.current.request === selection.request &&
      selectionRef.current.candidate === selection.candidate &&
      selectionRef.current.initialCandidate === selection.initialCandidate &&
      selectionRef.current.comparison === selection.comparison &&
      selectionRef.current.actor === selection.actor &&
      selectionRef.current.project === selection.project &&
      selectionRef.current.bundle === selection.bundle &&
      selectionRef.current.channel === selection.channel;
    const updated = await refreshKnownActive(
      requestsRef.current.filter((row) => row.id !== selection.request),
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
    if (selection.request && currentSelection()) {
      let expectedDirect = selected;
      try {
        const result = await invoke({ action: 'request', id: selection.request });
        if (!currentSelection() || directRequestRef.current !== selected) return;
        const refreshedDirect = 'request' in result ? result.request : undefined;
        if (!refreshedDirect || refreshedDirect.id !== selection.request)
          throw Error('The requested evaluation request was not found.');
        if (
          selection.initialCandidate &&
          refreshedDirect.candidateVersionId !== selection.initialCandidate
        )
          throw Error(
            'The requested evaluation belongs to a different candidate. Open the request with its matching candidate.',
          );
        if (selection.candidate && refreshedDirect.candidateVersionId !== selection.candidate)
          return;
        directRequestRef.current = refreshedDirect;
        setSelectedProgress(result.progress ?? null);
        expectedDirect = refreshedDirect;
        setDirectRequest((previous) =>
          JSON.stringify(previous) === JSON.stringify(refreshedDirect) ? previous : refreshedDirect,
        );
        setRequests((previous) =>
          previous.map((row) => (row.id === refreshedDirect.id ? refreshedDirect : row)),
        );
        if (!selection.candidate) {
          setCandidate(refreshedDirect.candidateVersionId);
          return;
        }
        if (selection.comparison && selection.comparison !== refreshedDirect.comparisonId)
          throw Error('The requested comparison does not match this evaluation request.');
        if (refreshedDirect.comparisonId) {
          const existing = comparisonRef.current;
          if (!existing || requestEvidence(refreshedDirect, existing).status !== 'bound') {
            const report = await invoke({ action: 'comparison', id: refreshedDirect.comparisonId });
            if (!currentSelection() || directRequestRef.current !== refreshedDirect) return;
            const value = 'comparison' in report ? report.comparison : undefined;
            if (!value) throw Error('The comparison for this request is unavailable.');
            const binding = requestEvidence(refreshedDirect, value);
            if (binding.status !== 'bound')
              throw Error(
                binding.status === 'mismatch' || binding.status === 'unbound'
                  ? binding.message
                  : 'The comparison for this request is unavailable.',
              );
            setComparison(value);
            setComparisonId(value.id);
          }
        }
        setRequestError('');
      } catch (error) {
        if (currentSelection() && directRequestRef.current === expectedDirect) {
          setSelectedProgress(null);
          setComparison(null);
          setRequestError(
            error instanceof Error ? error.message : 'The requested evaluation is unavailable.',
          );
        }
      }
    }
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
    setEvaluationProfile('');
    setCustomConfiguration('');
    setSavedEvaluationForm({ profile: '', customConfiguration: '' });
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
    if (initial.comparison && !initial.request)
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
    initial.request,
    candidate,
    state.actorScope,
    state.projectId,
    state.bundleId,
    state.channel,
  ]);
  useEffect(() => {
    let stale = false;
    setDirectRequest(null);
    setSelectedProgress(null);
    directRequestRef.current = null;
    setRequestError('');
    if (!initial.request) {
      setRequestLoading(false);
      return () => {
        stale = true;
      };
    }
    setRequestLoading(true);
    setComparison(null);
    async function restore() {
      try {
        const result = await invoke({ action: 'request', id: initial.request });
        if (stale) return;
        const request = 'request' in result ? result.request : undefined;
        if (!request || request.id !== initial.request)
          throw Error('The requested evaluation request was not found.');
        if (initial.candidate && request.candidateVersionId !== initial.candidate)
          throw Error(
            'The requested evaluation belongs to a different candidate. Open the request with its matching candidate.',
          );
        directRequestRef.current = request;
        setDirectRequest(request);
        setSelectedProgress(result.progress ?? null);
        if (candidate !== request.candidateVersionId) {
          setCandidate(request.candidateVersionId);
          return;
        }
        if (initial.comparison && initial.comparison !== request.comparisonId)
          throw Error('The requested comparison does not match this evaluation request.');
        if (!request.comparisonId) return;
        const report = await invoke({ action: 'comparison', id: request.comparisonId });
        if (stale) return;
        const value = 'comparison' in report ? report.comparison : undefined;
        if (!value) throw Error('The comparison for this request is unavailable.');
        const binding = requestEvidence(request, value);
        if (binding.status !== 'bound')
          throw Error(
            binding.status === 'mismatch' || binding.status === 'unbound'
              ? binding.message
              : 'The comparison for this request is unavailable.',
          );
        setComparison(value);
        setComparisonId(value.id);
      } catch (error) {
        if (!stale) {
          setSelectedProgress(null);
          setRequestError(
            error instanceof Error ? error.message : 'The requested evaluation is unavailable.',
          );
        }
      } finally {
        if (!stale) setRequestLoading(false);
      }
    }
    void restore();
    return () => {
      stale = true;
    };
  }, [
    initial.request,
    initial.candidate,
    initial.comparison,
    candidate,
    state.actorScope,
    state.projectId,
    state.bundleId,
    state.channel,
  ]);
  useLayoutEffect(() => {
    if (busy || !requestFocusId.current) return;
    const current = document.activeElement;
    if (
      requestOwnsFocus.current &&
      (current === createRequestAction.current || current === document.body)
    )
      document.getElementById(`evaluation-request-${requestFocusId.current}`)?.focus();
    requestFocusId.current = null;
    requestOwnsFocus.current = false;
  }, [busy, requests]);
  function comparisonHref(id: string, request?: string) {
    return bundleHref(scope, 'changes', {
      candidate: candidate || undefined,
      draft: initial.draft || undefined,
      generation: initial.generation || undefined,
      proposal: initial.proposal && initial.proposal !== 'new' ? initial.proposal : undefined,
      comparison: id,
      request,
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
        if (data.action === 'evaluate') {
          acceptEvaluationForm(r.request);
          requestFocusId.current = r.request.id;
        }
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
  const loadedCandidateRequests = requests.filter(
    (request) => request.candidateVersionId === candidate,
  );
  const candidateRequests =
    directRequest &&
    directRequest.candidateVersionId === candidate &&
    !loadedCandidateRequests.some((row) => row.id === directRequest.id)
      ? [directRequest, ...loadedCandidateRequests]
      : loadedCandidateRequests;
  const selectedRequest =
    candidateRequests.find((request) => request.id === initial.request) ||
    (!initial.request
      ? candidateRequests.find(
          (request) =>
            request.comparisonId === comparison?.id &&
            comparison?.evaluation?.requestId === request.id,
        )
      : undefined);
  const visibleRequests = showAllRequests
    ? candidateRequests
    : candidateRequests.filter(
        (request, index) =>
          index < (selectedRequest && candidateRequests.indexOf(selectedRequest) >= 5 ? 4 : 5) ||
          request === selectedRequest,
      );
  const isCurrentRelease = Boolean(candidate) && candidate === state.resolution.version.id;
  const savedReviewDetails = detail?.candidate && (
    <>
      <Disclosure>
        <DisclosureTrigger className="cursor-pointer font-medium">
          Review file changes
        </DisclosureTrigger>
        <DisclosureContent>
          <div className="mt-4">
            <ContentDiff base={detail.parentPayload} current={detail.candidate.payload} />
          </div>
        </DisclosureContent>
      </Disclosure>
      <Disclosure>
        <DisclosureTrigger className="cursor-pointer">Saved snapshot details</DisclosureTrigger>
        <DisclosureContent>
          <p className="mt-3">
            Channel {state.channel} · current revision {state.resolution.revision}
          </p>
          <p>
            Compatibility target {state.compatibilityTarget}
            {state.compatibilityTarget === 'generic' ? ' · native compatibility unchecked' : ''}
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
          <SyntaxCode
            className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"
            code={JSON.stringify(detail.candidate, null, 2)}
            language="json"
          />
        </DisclosureContent>
      </Disclosure>
    </>
  );
  const exampleIssue =
    evaluationProfile === 'payment-retry' && detail
      ? paymentSimulatorIssue(detail.candidate.payload)
      : undefined;
  const evaluationSetup = detail?.candidate && !isCurrentRelease && (
    <section
      className="review-section evaluation-setup space-y-3 px-4 py-3"
      aria-label="Create evaluation request"
    >
      <Disclosure
        key={candidateRequests.length === 0 ? 'first-request' : 'another-request'}
        defaultOpen={candidateRequests.length === 0}
      >
        <DisclosureTrigger className="cursor-pointer font-medium">
          <span className="evaluation-setup-title">
            <FlaskConical aria-hidden="true" />
            {candidateRequests.length
              ? 'Create another evaluation request'
              : 'Set up evaluation request'}
          </span>
        </DisclosureTrigger>
        <DisclosureContent>
          <div className="evaluation-configuration-form mt-3 space-y-3">
            <p className="evaluation-step-label">
              1. Configure · 2. Run in your app · 3. Review evidence
            </p>
            <div className="rounded-md border p-3 space-y-2" aria-label="Evaluator prerequisites">
              <p>
                Before creating a request, install your app’s evaluator starter and run its{' '}
                <code>describe</code> command.
              </p>
              <p>
                Evaluation needs a dedicated project read/write machine principal from your service
                operator. Connections delivery credentials cannot read unpublished candidates or run
                evaluations; propose and promote access are not needed.
              </p>
              <p>
                Keep its private configuration and durable journal on the evaluator machine. Run{' '}
                <code>doctor</code> there to check access without executing a task. A valid public
                configuration does not prove the evaluator or provider is installed.
              </p>
              {initial.draft && initial.generation > 0 && (
                <p>
                  Evaluating saved generation {initial.generation}. Later edits do not change this
                  request.
                </p>
              )}
            </div>
            <Label className="block space-y-1">
              Evaluation configuration
              <NativeSelect
                className="w-full"
                aria-label="Evaluation configuration"
                value={evaluationProfile}
                disabled={busy || !!pending || related.blocked}
                onChange={(event) => setEvaluationProfile(event.target.value as EvaluationChoice)}
              >
                <option value="">Choose an evaluator…</option>
                <option value="custom">My app's installed evaluator</option>
                <optgroup label="Examples from this checkout">
                  <option value="payment-retry">
                    Example: Payment retry simulator · model-free
                  </option>
                  <option value="presence-contract">
                    Example: File presence contract · model-free
                  </option>
                  <option value="codex-luna-review">Example: Native Codex review · Luna</option>
                </optgroup>
              </NativeSelect>
            </Label>
            {evaluationProfile === 'custom' && (
              <Label className="block space-y-1">
                Public evaluator configuration (JSON)
                <Textarea
                  aria-label="Public evaluator configuration (JSON)"
                  className="min-h-40 font-mono"
                  value={customConfiguration}
                  disabled={busy || !!pending || related.blocked}
                  onChange={(event) => setCustomConfiguration(event.target.value)}
                />
                <span className="text-muted-foreground">
                  Run <code>node acclimate-eval.mjs describe</code> (or{' '}
                  <code>python3 acclimate_eval.py describe</code>), then paste its public
                  configuration: datasetRevision, graderRevision, runtime (including
                  configId/configRevision), and expectedCases. Keep credentials and case contents in
                  the app.
                </span>
              </Label>
            )}
            <p id="evaluation-prerequisites" className="text-muted-foreground">
              {evaluationProfile === 'payment-retry'
                ? 'The simulator needs payment-policy.json data. Three scenarios × two repetitions, no model calls. This checks orchestration, not native agent quality.'
                : evaluationProfile === 'presence-contract'
                  ? 'Checks nonempty instruction and skill files. This is a delivery contract check, not a behavioral score.'
                  : evaluationProfile === 'codex-luna-review'
                    ? 'The included checkout review and grader use Codex. After separate setup, that adapter requires --live and allows up to four bounded Luna turns. Creating a request makes no model call.'
                    : 'Your app runs its installed adapter and grader. The service freezes these settings and records evidence; it never executes configuration as code.'}
            </p>
            {evaluationConfig && (
              <p className="text-muted-foreground" aria-label="Selected evaluator summary">
                {evaluationConfig.runtime.configId} · revision{' '}
                {evaluationConfig.runtime.configRevision} ·{' '}
                {new Set(evaluationConfig.expectedCases.map((item) => item.caseId)).size} tasks ·{' '}
                {evaluationConfig.expectedCases.length} repetition pairs
              </p>
            )}
            {exampleIssue && (
              <p role="alert" className="text-destructive">
                {exampleIssue}
              </p>
            )}
            {configurationError && evaluationProfile && (
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
                !evaluationConfig ||
                !!exampleIssue
              }
              ref={createRequestAction}
              aria-describedby="evaluation-prerequisites"
              onClick={(event) => {
                requestOwnsFocus.current = document.activeElement === event.currentTarget;
                void act({ action: 'evaluate', ...base, configuration: evaluationConfig });
              }}
            >
              Create evaluation request
            </Button>
          </div>
        </DisclosureContent>
      </Disclosure>
    </section>
  );
  return (
    <div className={`min-w-0 space-y-4 text-sm${mode === 'proposal' ? ' proposal-page' : ''}`}>
      <RelatedPendingNotice recovery={related} scope={scope} canEdit={state.canEdit} />
      {message && <p role="status">{message}</p>}
      {requestLoading && <p role="status">Loading requested evaluation…</p>}
      {requestError && (
        <div role="alert">
          <p>{requestError}</p>
          {(initial.comparison || directRequest?.comparisonId) && (
            <ConsoleLink
              href={comparisonHref((initial.comparison || directRequest?.comparisonId)!)}
            >
              Inspect comparison independently
            </ConsoleLink>
          )}
        </div>
      )}
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
          <Disclosure>
            <DisclosureTrigger className="cursor-pointer">Recovery details</DisclosureTrigger>
            <DisclosureContent>
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
                  Closing preserves any known commit and rejects delayed writes. Forgetting text
                  does not cancel the submission or prove that execution failed. Without submitted
                  text, exact retry is unavailable.
                </p>
                <SyntaxCode
                  className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"
                  code={JSON.stringify(pending, null, 2)}
                  language="json"
                />
              </div>
            </DisclosureContent>
          </Disclosure>
        </section>
      )}
      {mode === 'proposal' && (
        <SuggestionComposer
          files={state.payload.files}
          channel={state.channel}
          revision={state.resolution.revision}
          parentVersionId={state.resolution.version.id}
          parentDigest={state.resolution.version.digest}
          hypothesis={hypothesis}
          evidence={evidence}
          paths={paths}
          consent={consent}
          canEdit={state.canEdit}
          busy={busy}
          pending={!!pending}
          blocked={related.blocked}
          blockedReason={
            related.error ||
            (related.record
              ? 'Resolve the pending submission above before requesting another suggestion.'
              : undefined)
          }
          onHypothesisChange={setHypothesis}
          onEvidenceChange={setEvidence}
          onPathsChange={setPaths}
          onConsentChange={setConsent}
          onSubmit={() =>
            void act({
              action: 'propose',
              parentVersionId: state.resolution.version.id,
              hypothesis,
              allowedPaths: paths,
              evidence: evidence.split('\n').filter(Boolean),
              consent,
            })
          }
        />
      )}
      {mode === 'review' && (
        <div className="review-workspace evaluation-workspace min-w-0">
          <section className="review-summary space-y-3 px-4 py-3" aria-label="Saved change review">
            <div className="workflow-status-row flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="review-identity flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="evaluation-page-title">
                  {isCurrentRelease
                    ? 'Published change'
                    : candidate
                      ? 'Evaluate saved change'
                      : 'Suggestion'}
                </h2>
                {!state.canEdit && <span className="text-muted-foreground">Read only</span>}
                {initial.draft && (
                  <span className="text-muted-foreground">
                    Generation {initial.generation} saved
                  </span>
                )}
                {!candidate && !selectedProposal && <span>Preparing suggestion</span>}
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {initial.draft && (
                  <Button asChild variant="outline">
                    <ConsoleLink
                      aria-label="Back to draft editor"
                      href={bundleHref(scope, 'changes', { draft: initial.draft })}
                    >
                      Back to draft
                    </ConsoleLink>
                  </Button>
                )}
                {isCurrentRelease && (
                  <Button asChild variant="outline">
                    <ConsoleLink href={bundleHref(scope, 'releases')}>
                      View release history
                    </ConsoleLink>
                  </Button>
                )}
              </div>
            </div>
            {candidate && !isCurrentRelease && (
              <p className="review-boundary text-muted-foreground">
                {reviewNextStep(candidateRequests, Boolean(comparison), Boolean(requestCursor))}
              </p>
            )}
            {selectedProposal && (
              <div className="suggestion-result space-y-2" data-status={selectedProposal.status}>
                <p className="suggestion-result-status" role="status">
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
                {candidateRequests.length === 0 && savedReviewDetails}
              </>
            )}
          </section>
          {candidate && (
            <div
              className={`evaluation-board${candidateRequests.length || requestCursor ? ' has-runs' : ''}${comparison ? ' has-evidence' : ''}`}
            >
              <div className="evaluation-run-sidebar">
                {evaluationSetup}
                {(candidateRequests.length > 0 || requestCursor) && (
                  <section
                    className="review-section evaluation-runs space-y-3 px-4 py-3"
                    aria-label="Evaluation requests"
                  >
                    <div className="evaluation-panel-heading">
                      <h2 className="font-semibold">Evaluation results</h2>
                      <span className="text-muted-foreground">
                        {candidateRequests.length} loaded
                      </span>
                    </div>
                    <p className="evaluation-section-description text-muted-foreground">
                      Requests and results for this saved change.
                    </p>
                    {candidateRequests.some(
                      (request) => request.runtime.source === 'simulated-example',
                    ) && (
                      <p className="evaluation-history-example text-muted-foreground">
                        <FlaskConical aria-hidden="true" />
                        Includes simulated examples · no model runs
                      </p>
                    )}
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
                    {visibleRequests.map((request, index) => {
                      const selectedEvidence = Boolean(
                        comparison && requestEvidence(request, comparison).status === 'bound',
                      );
                      const labels = evaluationRequestLabels(request, selectedEvidence);
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
                        <Disclosure
                          key={`${request.id}-${initial.request === request.id}`}
                          defaultOpen={
                            initial.request === request.id ||
                            (candidateRequests.length === 1 && index === 0 && !request.comparisonId)
                          }
                          className={`evaluation-request space-y-2${selectedEvidence ? ' is-selected-evidence' : ''}`}
                          aria-label={`Evaluation request ${request.id}`}
                        >
                          <div className="evaluation-request-row flex flex-wrap items-center justify-between gap-2">
                            <DisclosureTrigger
                              id={`evaluation-request-${request.id}`}
                              aria-label={labels.details}
                              className="cursor-pointer font-medium"
                            >
                              <span className="evaluation-run-summary">
                                {directRequest?.id === request.id &&
                                  !loadedCandidateRequests.some((row) => row.id === request.id) && (
                                    <span>Selected outside loaded pages · </span>
                                  )}
                                <span className="evaluation-run-title">
                                  <span
                                    className={`evaluation-run-status-icon is-${request.status}`}
                                    aria-hidden="true"
                                  >
                                    {request.status === 'completed' ? (
                                      <CircleCheck />
                                    ) : request.status === 'failed' ? (
                                      <CircleX />
                                    ) : request.status === 'interrupted' ? (
                                      <CirclePause />
                                    ) : request.status === 'running' ? (
                                      <Radio />
                                    ) : (
                                      <CircleDashed />
                                    )}
                                  </span>
                                  <span
                                    className="evaluation-run-name"
                                    title={request.datasetRevision}
                                  >
                                    {request.datasetRevision}
                                  </span>
                                </span>
                                <span className="evaluation-run-meta">
                                  <span className={`evaluation-run-status is-${request.status}`}>
                                    {labels.status}
                                  </span>{' '}
                                  · {request.expectedCases.length} pairs
                                </span>
                                <span className="evaluation-run-meta" title={request.id}>
                                  Request {request.id.slice(0, 8)}
                                </span>
                              </span>
                            </DisclosureTrigger>
                            {request.comparisonId && (
                              <Tooltip>
                                <TooltipTrigger asChild data-slot="button">
                                  <Button
                                    asChild
                                    size="icon"
                                    variant={selectedEvidence ? 'secondary' : 'outline'}
                                  >
                                    <ConsoleLink
                                      href={comparisonHref(request.comparisonId, request.id)}
                                      aria-label={labels.inspect}
                                      aria-current={selectedEvidence ? 'true' : undefined}
                                    >
                                      <ArrowRight aria-hidden="true" />
                                    </ConsoleLink>
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Inspect evidence</TooltipContent>
                              </Tooltip>
                            )}
                          </div>
                          <DisclosureContent className="space-y-2">
                            {request.error && <p role="alert">{request.error}</p>}
                            <p className="text-muted-foreground">
                              {request.status === 'requested'
                                ? 'Request created · run in your app'
                                : request.status === 'interrupted'
                                  ? 'Recorded interruption'
                                  : `App reported ${request.status}`}
                            </p>
                            {!request.comparisonId && (
                              <div className="flex flex-wrap gap-2">
                                <CopyButton value={request.id} label="Copy request ID" />
                                <CopyButton value={handoff} label="Copy request JSON" />
                                <EvaluationHandoffDownload handoff={handoff} />
                              </div>
                            )}
                            {request.status === 'running' && (
                              <p>
                                App reported execution started. Check the original worker before
                                retrying. Request interruption does not stop an external job or its
                                charges.
                              </p>
                            )}
                            {initial.request === request.id && (
                              <EvaluationActivity request={request} progress={selectedProgress} />
                            )}
                            {!request.comparisonId && request.status === 'requested' && (
                              <div className="space-y-2">
                                <p>
                                  Save the public JSON as <code>evaluation-request.json</code>, then
                                  run your app-owned entry point. Add <code>--live</code> only when
                                  its installed definition requires model execution.
                                </p>
                                <SyntaxCode
                                  code={applicationEvaluatorRunCommand(request)}
                                  language="bash"
                                />
                              </div>
                            )}
                            {request.comparisonId && (
                              <p>
                                Paired evidence recorded. Completion is separate from your quality
                                policy and release approval. Outputs remain private/local unless
                                deliberately exported; use your app’s export and verify-export
                                commands to share reviewed evidence.
                              </p>
                            )}
                            {!request.comparisonId && request.status !== 'running' && (
                              <p className="text-muted-foreground">
                                {request.status === 'requested'
                                  ? 'Run in your app with the request ID and frozen public configuration.'
                                  : 'No comparison was reported. Check the app logs before creating another request.'}
                              </p>
                            )}
                            <Disclosure>
                              <DisclosureTrigger className="cursor-pointer">
                                Request details
                              </DisclosureTrigger>
                              <DisclosureContent>
                                {request.comparisonId && (
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    <CopyButton value={request.id} label="Copy request ID" />
                                    <CopyButton value={handoff} label="Copy request JSON" />
                                    <EvaluationHandoffDownload handoff={handoff} />
                                  </div>
                                )}
                                <p className="mt-2 break-all">Dataset: {request.datasetRevision}</p>
                                <p className="text-muted-foreground">
                                  Updated{' '}
                                  <time dateTime={request.updatedAt}>
                                    {new Date(request.updatedAt).toLocaleString()}
                                  </time>
                                </p>
                                <p className="mt-2 text-muted-foreground">
                                  {request.requireBoundEvidence
                                    ? 'Bound evidence required'
                                    : 'Legacy completion allowed'}
                                </p>
                                <p className="break-all">Request ID: {request.id}</p>
                                <p className="break-all">Public API: {state.publicApiUrl}</p>
                                <SyntaxCode
                                  className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"
                                  code={handoff}
                                  language="json"
                                />
                                <SyntaxCode
                                  className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"
                                  code={JSON.stringify(request, null, 2)}
                                  language="json"
                                />
                              </DisclosureContent>
                            </Disclosure>
                            {command && (
                              <Disclosure>
                                <DisclosureTrigger className="cursor-pointer">
                                  {request.comparisonId
                                    ? 'Checkout evaluator setup details'
                                    : 'Included checkout setup (required)'}
                                </DisclosureTrigger>
                                <DisclosureContent>
                                  <div className="my-3 space-y-3 text-muted-foreground">
                                    <p>
                                      Install this checkout on the machine that will run
                                      evaluations. Ask your service operator for a dedicated
                                      evaluator machine principal with read/write access to this
                                      project; propose and promote access are not needed.
                                    </p>
                                    <p>
                                      Connections issues content-read and receipt-write credentials
                                      for published delivery. Those credentials cannot run
                                      evaluations or read unpublished candidates. Use the dedicated
                                      evaluator credential below.
                                    </p>
                                    <p>
                                      Create a private directory (0700) and a JSON file (0600)
                                      outside version control. Replace these placeholders privately
                                      with your app’s settings. Keep credentials out of the console,
                                      chat, logs and command arguments.
                                    </p>
                                    <SyntaxCode
                                      tabIndex={0}
                                      aria-label="Private evaluator configuration template"
                                      className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
                                      code={JSON.stringify(
                                        {
                                          schemaVersion: 1,
                                          serviceUrl: 'https://api.example.com',
                                          projectId: 'YOUR_PROJECT_ID',
                                          evaluatorPrincipalId:
                                            'YOUR_DEDICATED_EVALUATOR_PRINCIPAL',
                                          evaluatorToken: 'YOUR_SCOPED_EVALUATOR_TOKEN',
                                          journalRoot: '/absolute/private/evaluation-journals',
                                        },
                                        null,
                                        2,
                                      )}
                                      language="json"
                                    />
                                    <p>
                                      Use the same service and project as this request. Set
                                      journalRoot to an absolute, owner-only directory. Replace the
                                      --config path below with your private JSON file, then run the
                                      command from your installed checkout. Matching public settings
                                      do not mean the adapter is installed. The console does not
                                      execute this command.
                                    </p>
                                    <p>
                                      For recovery, retain the same service, project, evaluator
                                      principal and original journal directory. Do not delete or
                                      relocate journals to retry execution.
                                    </p>
                                  </div>
                                  <CopyButton value={command} label="Copy setup-required command" />
                                  <SyntaxCode
                                    className="block overflow-auto whitespace-pre-wrap break-all"
                                    code={command}
                                    language="bash"
                                  />
                                </DisclosureContent>
                              </Disclosure>
                            )}
                            {['requested', 'running'].includes(request.status) && (
                              <Disclosure>
                                <DisclosureTrigger className="cursor-pointer">
                                  Record an interruption
                                </DisclosureTrigger>
                                <DisclosureContent>
                                  <div className="mt-3 space-y-3">
                                    <p role="note">
                                      Recording an interruption does not stop the external app or
                                      its charges.
                                    </p>
                                    <Label className="block space-y-1">
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
                                    </Label>
                                    <Button
                                      variant="outline"
                                      disabled={
                                        busy ||
                                        !state.canEdit ||
                                        !interruptionReasons[request.id]?.trim()
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
                                </DisclosureContent>
                              </Disclosure>
                            )}
                          </DisclosureContent>
                        </Disclosure>
                      );
                    })}
                    {candidateRequests.length > 5 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowAllRequests(!showAllRequests)}
                      >
                        {showAllRequests
                          ? 'Show fewer results'
                          : `Show all ${candidateRequests.length} loaded results`}
                      </Button>
                    )}
                    {requestCursor && candidateRequests.length > 0 && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setShowAllRequests(true);
                          void refresh(requestCursor);
                        }}
                      >
                        Load more evaluation requests
                      </Button>
                    )}
                  </section>
                )}
              </div>
              <div className="evaluation-result-detail">
                {(comparison || candidateRequests.length > 0 || requestCursor) && (
                  <section
                    className="review-section review-evidence space-y-3 px-4 py-3"
                    aria-label="Evidence and release decision"
                  >
                    <div className="evaluation-panel-heading">
                      <div className="min-w-0">
                        <h2 className="font-semibold">
                          {comparison ? 'Reported evidence' : 'Compare results'}
                        </h2>
                        {comparison && (
                          <p className="evaluation-evidence-dataset">
                            {comparison.datasetRevision}
                          </p>
                        )}
                      </div>
                      {comparison && (
                        <span className="text-muted-foreground">
                          {new Date(comparison.createdAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    {comparison ? (
                      <>
                        {!initial.request && !comparison.evaluation && (
                          <p>
                            Legacy unbound evidence: this comparison is not attached to an
                            evaluation request.
                          </p>
                        )}
                        {(comparison.candidateVersionId !== candidate ||
                          (!isCurrentRelease &&
                            comparison.parentVersionId !== state.resolution.version.id)) && (
                          <p role="alert">
                            {isCurrentRelease
                              ? 'This evidence belongs to a different candidate. It does not describe this release.'
                              : 'This evidence does not match the saved candidate and current release target. Release with this evidence is unavailable.'}
                          </p>
                        )}
                        {comparison.candidateVersionId === candidate && (
                          <EvaluationScorecard comparison={comparison} />
                        )}
                        {comparison.runtime.source === 'simulated-example' && (
                          <p className="evaluation-example-note">
                            <FlaskConical aria-hidden="true" />
                            Simulated example evidence. No agent or model ran for these results.
                          </p>
                        )}
                        <ComparisonEvidence comparison={comparison} compact />
                        {!isCurrentRelease && (
                          <div className="review-evidence-action">
                            <Button
                              aria-describedby={
                                !comparison.complete ? 'reported-evidence-incomplete' : undefined
                              }
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
                              onClick={(event) => {
                                releaseReturnRef.current = event.currentTarget;
                                setReleaseReview({
                                  comparisonId: comparison.id,
                                  versionId: candidate,
                                  revision: state.resolution.revision,
                                  generation: initial.generation,
                                });
                              }}
                            >
                              Review release with this evidence
                            </Button>
                            {!comparison.complete && (
                              <p
                                id="reported-evidence-incomplete"
                                className="text-muted-foreground"
                              >
                                {comparisonIncompleteReason(comparison)}
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="evaluation-empty-evidence">
                        <ChartNoAxesCombined aria-hidden="true" />
                        <h3>
                          {candidateRequests.some((request) => request.comparisonId)
                            ? 'Choose a reported result'
                            : 'Your results will appear here'}
                        </h3>
                        <p className="text-muted-foreground">
                          {candidateRequests.some((request) => request.comparisonId)
                            ? 'Use the arrow beside a reported run to compare the parent and candidate, see each case, and review a release.'
                            : 'Run the request in your app, then report its comparison. This service records results; your app owns execution.'}
                        </p>
                      </div>
                    )}
                  </section>
                )}
                {candidateRequests.length > 0 && (
                  <section
                    className="review-section evaluation-snapshot-details space-y-3 px-4 py-3"
                    aria-label="Saved change details"
                  >
                    {savedReviewDetails}
                  </section>
                )}
                {(!isCurrentRelease || comparison) && (
                  <section
                    className="review-section evaluation-lookup px-4 py-3"
                    aria-label="Comparison lookup"
                  >
                    <Disclosure>
                      <DisclosureTrigger className="cursor-pointer">
                        Comparison lookup and details
                      </DisclosureTrigger>
                      <DisclosureContent>
                        <div className="mt-3 space-y-3">
                          <Label className="block space-y-1">
                            Comparison ID
                            <Input
                              value={comparisonId}
                              onChange={(event) => {
                                setComparisonId(event.target.value);
                                setComparison(null);
                                setReleaseReview(null);
                              }}
                            />
                          </Label>
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
                              <SyntaxCode
                                className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"
                                code={JSON.stringify(comparison, null, 2)}
                                language="json"
                              />
                            </>
                          )}
                        </div>
                      </DisclosureContent>
                    </Disclosure>
                  </section>
                )}
                {detail?.candidate && !isCurrentRelease && (
                  <section
                    className="review-section review-release space-y-3 px-4 py-3"
                    aria-label="Release options"
                  >
                    <h2 className="font-semibold">Release options</h2>
                    <Disclosure>
                      <DisclosureTrigger className="cursor-pointer font-medium">
                        Publish without evaluation
                      </DisclosureTrigger>
                      <DisclosureContent>
                        <div className="mt-3 space-y-3">
                          <p>
                            This release will record that no evaluation supports it. Only the saved
                            snapshot above will be published.
                          </p>
                          <Label className="block space-y-1">
                            Manual release reason (required)
                            <Textarea
                              aria-label="Manual release reason"
                              required
                              value={reason}
                              onChange={(event) => setReason(event.target.value)}
                              maxLength={1000}
                            />
                          </Label>
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
                            onClick={(event) => {
                              releaseReturnRef.current = event.currentTarget;
                              setReleaseReview({
                                reason,
                                versionId: candidate,
                                revision: state.resolution.revision,
                                generation: initial.generation,
                              });
                            }}
                          >
                            Review manual release
                          </Button>
                        </div>
                      </DisclosureContent>
                    </Disclosure>
                    <Disclosure className="text-muted-foreground">
                      <DisclosureTrigger className="cursor-pointer">
                        What publishing changes
                      </DisclosureTrigger>
                      <DisclosureContent>
                        <p className="mt-2">
                          Publishing updates {state.channel} for future resolutions. Pinned
                          workspaces stay pinned. A changed draft generation, parent or channel
                          revision requires fresh review.
                        </p>
                      </DisclosureContent>
                    </Disclosure>
                  </section>
                )}
                <Dialog
                  open={!!releaseReview}
                  onOpenChange={(open) => {
                    if (!open && !busy) setReleaseReview(null);
                  }}
                >
                  <DialogContent
                    size="decision"
                    returnFocusRef={releaseReturnRef}
                    className="max-h-[85dvh] overflow-y-auto text-sm"
                  >
                    <DialogHeader>
                      <DialogTitle>Publish to {state.channel}?</DialogTitle>
                      <DialogDescription>
                        Publish the saved snapshot reviewed on this page. The full diff remains on
                        the page.
                      </DialogDescription>
                    </DialogHeader>
                    <p>
                      Bundle: <strong>{state.bundleName || state.bundleId}</strong>
                    </p>
                    <p>
                      Target: <strong>{state.channel}</strong> · revision {releaseReview?.revision}
                    </p>
                    <p className="break-all">Published parent: {state.resolution.version.id}</p>
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
                          isCurrentRelease ||
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
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
