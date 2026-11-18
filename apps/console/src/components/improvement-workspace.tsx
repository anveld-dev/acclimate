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
import { PolicyReceiptList, usePolicyReceipts } from './evaluation-policy-receipts';
import { EvaluationActivity } from './evaluation-activity';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { EvaluationSetup, EvaluatorLanguageSelect } from './evaluation-setup';
import {
  evaluationConfiguration,
  evaluationHandoff,
  parseEvaluationConfiguration,
  isCheckoutCodexEvaluator,
  checkoutCodexRunCommand,
  checkoutCodexCheckCommand,
  applicationEvaluatorCommand,
  type EvaluatorLanguage,
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
  const [createdRequestId, setCreatedRequestId] = useState<string | null>(null);
  const [activeProgress, setActiveProgress] = useState<
    Record<string, EvaluationProgressView | null>
  >({});
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
  const {
    receipts,
    failed: receiptReadFailed,
    refresh: refreshReceipts,
  } = usePolicyReceipts(scope, state.actorScope, state.serviceIdentity, candidate, comparison?.id);
  const blockers = receipts?.blockers ?? [];
  const blockerRefs = blockers.map((row) => ({
    comparisonId: row.comparisonId,
    policyDigest: row.policy.sha256,
  }));
  const [overrideReason, setOverrideReason] = useState('');
  const validOverrideReason =
    !!overrideReason.trim() &&
    new TextEncoder().encode(overrideReason.trim()).length <= 1024 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(overrideReason.trim());
  const [releaseReview, setReleaseReview] = useState<{
    reason?: string;
    comparisonId?: string;
    blocking?: typeof blockerRefs;
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
  const [evaluatorLanguage, setEvaluatorLanguage] = useState<EvaluatorLanguage>('javascript');
  const [requestLanguages, setRequestLanguages] = useState<Record<string, EvaluatorLanguage>>({});
  const [consoleOrigin, setConsoleOrigin] = useState('');
  const languageKey = `acclimate-evaluator-language:${state.serviceIdentity}:${state.actorScope}:${state.projectId}:${state.bundleId}`;
  useEffect(() => {
    setConsoleOrigin(window.location.origin);
    try {
      setRequestLanguages(JSON.parse(localStorage.getItem(languageKey) || '{}') ?? {});
    } catch {
      setRequestLanguages({});
    }
  }, [languageKey]);
  function rememberLanguage(id: string, language: EvaluatorLanguage) {
    setRequestLanguages((previous) => {
      let next = { ...previous, [id]: language };
      try {
        next = { ...JSON.parse(localStorage.getItem(languageKey) || '{}'), [id]: language };
        localStorage.setItem(languageKey, JSON.stringify(next));
      } catch {
        /* The selection still works for the current page. */
      }
      return next;
    });
  }
  function languageFor(id: string) {
    return requestLanguages[id] === 'python' || requestLanguages[id] === 'javascript'
      ? requestLanguages[id]
      : evaluatorLanguage;
  }
  const [customConfiguration, setCustomConfiguration] = useState('');
  const [savedEvaluationForm, setSavedEvaluationForm] = useState('');
  const evaluationForm = useRef(customConfiguration);
  evaluationForm.current = customConfiguration;
  function acceptEvaluationForm(request: Evaluation) {
    const form = evaluationForm.current;
    try {
      const configured = parseEvaluationConfiguration(form);
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
    evaluationConfig = parseEvaluationConfiguration(customConfiguration);
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
    setActiveProgress({});
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
    if (!result.ok) {
      if (result.code === 'policy_override_required' && data.action === 'submitFrozen') {
        if (loadPending(sessionStorage, pendingScope)?.key === data.key) {
          resolvePending(sessionStorage, pendingScope);
          setPending(null);
        }
        setReleaseReview(null);
        refreshReceipts();
      }
      throw new Error(result.message);
    }
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
    const progress: Record<string, EvaluationProgressView | null> = {};
    const updated = await refreshKnownActive(
      requestsRef.current.filter((row) => row.id !== selection.request),
      async (id) => {
        try {
          const value = await invoke({ action: 'request', id });
          progress[id] = value.progress ?? null;
          return value.request;
        } catch {
          progress[id] = null;
          return undefined;
        }
      },
      () => epoch === scopeEpoch.current && mounted.current,
    );
    if (epoch !== scopeEpoch.current || !mounted.current) return;
    setActiveProgress(progress);
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
      (mode === 'review' && customConfiguration !== savedEvaluationForm) ||
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
    setCustomConfiguration('');
    setSavedEvaluationForm('');
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
          setCreatedRequestId(r.request.id);
          rememberLanguage(r.request.id, evaluatorLanguage);
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
  const selectedCheckCommand =
    selectedRequest && comparison && requestEvidence(selectedRequest, comparison).status === 'bound'
      ? isCheckoutCodexEvaluator(selectedRequest)
        ? checkoutCodexCheckCommand
        : applicationEvaluatorCommand(languageFor(selectedRequest.id), 'check')
      : undefined;
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
  const evaluationSetup = detail?.candidate && !isCurrentRelease && (
    <EvaluationSetup
      key={candidateRequests.length === 0 ? 'first-request' : 'another-request'}
      language={evaluatorLanguage}
      customConfiguration={customConfiguration}
      configuration={evaluationConfig}
      configurationError={configurationError}
      savedGeneration={initial.draft && initial.generation > 0 ? initial.generation : undefined}
      hasRequests={candidateRequests.length > 0}
      fieldsDisabled={busy || !!pending || related.blocked}
      submitDisabled={
        busy || !!pending || related.blocked || !state.canEdit || !currentBase || !evaluationConfig
      }
      blockedReason={[
        !state.canEdit &&
          'You have read-only access. You can inspect configurations, but cannot create a request.',
        !currentBase &&
          'This candidate does not start from the selected channel’s current release. Create a new draft from the current release before requesting evaluation.',
        busy && 'An operation is in progress.',
        pending &&
          'Resolve the pending operation before creating another request. Its outcome has not been confirmed here.',
        related.blocked && 'Resolve the related pending operation before creating another request.',
      ]
        .filter(Boolean)
        .join(' ')}
      createActionRef={createRequestAction}
      onLanguageChange={setEvaluatorLanguage}
      onCustomConfigurationChange={setCustomConfiguration}
      onCreate={(event) => {
        requestOwnsFocus.current = document.activeElement === event.currentTarget;
        void act({ action: 'evaluate', ...base, configuration: evaluationConfig });
      }}
    />
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
          {evaluationSetup}
          {candidate && (
            <div
              className={`evaluation-board${candidateRequests.length || requestCursor ? ' has-runs' : ''}${comparison ? ' has-evidence' : ''}`}
            >
              <div className="evaluation-run-sidebar">
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
                      const requestLanguage = languageFor(request.id);
                      const nativeRunner = isCheckoutCodexEvaluator(request);
                      const runCommand = nativeRunner
                        ? checkoutCodexRunCommand(state.bundleId, request.id)
                        : applicationEvaluatorCommand(
                            requestLanguage,
                            'compare',
                            request.runtime.execution === 'live',
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
                            createdRequestId === request.id ||
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
                            {(initial.request === request.id ||
                              request.status === 'running' ||
                              request.status === 'requested') && (
                              <EvaluationActivity
                                request={request}
                                progress={
                                  initial.request === request.id
                                    ? selectedProgress
                                    : activeProgress[request.id]
                                }
                              />
                            )}
                            {!request.comparisonId &&
                              request.status === 'requested' &&
                              runCommand && (
                                <div className="space-y-2">
                                  <p>
                                    Give the evaluator owner the downloaded request. Run the
                                    commands on the evaluator machine with its private
                                    configuration.
                                  </p>
                                  {nativeRunner ? (
                                    <p>
                                      Run the installed Codex evaluator from the Acclimate checkout
                                      with your Codex credentials.
                                    </p>
                                  ) : (
                                    <>
                                      <EvaluatorLanguageSelect
                                        language={requestLanguage}
                                        onChange={(value) => rememberLanguage(request.id, value)}
                                      />
                                      <SyntaxCode
                                        code={applicationEvaluatorCommand(
                                          requestLanguage,
                                          'doctor',
                                        )}
                                        language="bash"
                                      />
                                    </>
                                  )}
                                  {!nativeRunner && (
                                    <p>
                                      Compare prints the parent and candidate scores. Add{' '}
                                      <code>--policy quality-policy.json</code> to check your
                                      release criteria in the same command.
                                    </p>
                                  )}
                                  <SyntaxCode code={runCommand} language="bash" />
                                  <CopyButton
                                    value={runCommand}
                                    label="Copy evaluator run command"
                                  />
                                  <CopyButton
                                    label="Copy instructions for evaluator owner"
                                    value={[
                                      `Evaluate request ${request.id}. Save the public JSON at the end of this message as evaluation-request.json.`,
                                      ...(nativeRunner
                                        ? [
                                            'Run these commands from the native Codex reviewer checkout.',
                                          ]
                                        : [
                                            `Application setup: ${consoleOrigin}/evaluator-setup.html#${requestLanguage}`,
                                            'Run from the application directory. Replace /absolute/private/evaluator.json with your private evaluator configuration path.',
                                            applicationEvaluatorCommand(requestLanguage, 'doctor'),
                                          ]),
                                      runCommand,
                                      'Open the comparison in the console after completion. To report a policy verdict, run the matching policy check with your policy file.',
                                      '',
                                      handoff,
                                    ].join('\n')}
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
                        {selectedRequest && selectedCheckCommand && (
                          <div className="space-y-2" aria-label="Application policy check">
                            <h3>Check the application’s quality policy</h3>
                            {receiptReadFailed ? (
                              <p role="alert">Could not refresh policy receipts.</p>
                            ) : !receipts ? (
                              <p>Loading policy receipts…</p>
                            ) : !receipts.comparison.length ? (
                              <p>No policy verdict has been reported for this comparison.</p>
                            ) : null}
                            {receipts && receipts.comparison.length > 0 && (
                              <PolicyReceiptList receipts={receipts.comparison} />
                            )}
                            <Button variant="outline" onClick={refreshReceipts}>
                              Refresh policy receipts
                            </Button>
                            <p>
                              Run the check on the evaluator machine with its private configuration
                              and policy file. Its verdict and check names appear here.
                            </p>
                            <EvaluationHandoffDownload
                              handoff={evaluationHandoff(
                                state.publicApiUrl,
                                state.projectId,
                                state.bundleId,
                                selectedRequest.id,
                                selectedRequest,
                              )}
                            />
                            {!isCheckoutCodexEvaluator(selectedRequest) && (
                              <EvaluatorLanguageSelect
                                language={languageFor(selectedRequest.id)}
                                onChange={(value) => rememberLanguage(selectedRequest.id, value)}
                              />
                            )}
                            <SyntaxCode code={selectedCheckCommand} language="bash" />
                            <CopyButton
                              value={selectedCheckCommand}
                              label="Copy policy check command"
                            />
                          </div>
                        )}
                        {!isCurrentRelease && (
                          <div className="review-evidence-action">
                            {blockers.some((row) => row.comparisonId !== comparison.id) && (
                              <section
                                aria-label="Other blocking policy verdicts"
                                className="space-y-2"
                              >
                                <h3>Other comparisons with blocking verdicts for this candidate</h3>
                                <PolicyReceiptList
                                  receipts={blockers.filter(
                                    (row) => row.comparisonId !== comparison.id,
                                  )}
                                />
                              </section>
                            )}
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
                                setOverrideReason('');
                                setReleaseReview({
                                  blocking: blockerRefs,
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
                              blockers.length > 0 ||
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
                          {blockers.length > 0 && (
                            <p>
                              A reported policy requires an override. Review complete comparison
                              evidence to publish this candidate.
                            </p>
                          )}
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
                    {releaseReview?.comparisonId && blockers.length > 0 && (
                      <section className="space-y-2" aria-label="Override policy">
                        <h3>Override the policy verdicts for this candidate</h3>
                        <PolicyReceiptList receipts={blockers} />
                        <Label htmlFor="policy-override-reason">Reason for overriding policy</Label>
                        <Input
                          id="policy-override-reason"
                          value={overrideReason}
                          maxLength={1024}
                          onChange={(e) => setOverrideReason(e.target.value)}
                        />
                        {overrideReason && !validOverrideReason && (
                          <p role="alert">Enter a single-line reason of up to 1024 UTF-8 bytes.</p>
                        )}
                        <p>The release history records the reason and the policies you override.</p>
                      </section>
                    )}
                    {releaseReview?.comparisonId &&
                      JSON.stringify(releaseReview.blocking) !== JSON.stringify(blockerRefs) && (
                        <p role="alert">
                          The policy verdicts changed. Close this dialog and review the updated
                          verdicts.
                        </p>
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
                          (releaseReview.comparisonId
                            ? !receipts ||
                              receiptReadFailed ||
                              JSON.stringify(releaseReview.blocking) !==
                                JSON.stringify(blockerRefs) ||
                              (blockers.length > 0 && !validOverrideReason)
                            : blockers.length > 0) ||
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
                                ? {
                                    comparisonId: releaseReview.comparisonId,
                                    ...(blockers.length
                                      ? {
                                          policyOverride: {
                                            reason: overrideReason.trim(),
                                            receipts: releaseReview.blocking,
                                          },
                                        }
                                      : {}),
                                  }
                                : { reason: releaseReview.reason }),
                            });
                        }}
                      >
                        {releaseReview?.comparisonId
                          ? releaseReview.blocking?.length
                            ? 'Override policy and publish'
                            : 'Publish with selected evidence'
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
