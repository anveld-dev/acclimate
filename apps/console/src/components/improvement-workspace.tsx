import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { evaluationPairs } from '../lib/evaluation-pairs';
import { artifactChanges } from '../lib/artifact-changes';
import { StatusBadge } from './status-badge';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { ReceiptTime } from './receipt-time';
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
import { EvaluationCaseWorkbench } from './evaluation-case-workbench';
import { EvaluationOutcomeStrip, EvaluationScorecard } from './evaluation-scorecard';
import { PolicyReceiptList, usePolicyReceipts } from './evaluation-policy-receipts';
import { EvaluationActivity } from './evaluation-activity';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';
import { EvaluationSetup, EvaluatorLanguageSelect } from './evaluation-setup';
import {
  evaluationConfiguration,
  evaluationHandoff,
  parseEvaluationConfiguration,
  isCheckoutCodexEvaluator,
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
import { EvaluationRequestInspector } from './evaluation-request-inspector';
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
  reviewTab,
}: {
  state: Ready;
  initial: {
    candidate: string;
    draft: string;
    generation: number;
    proposal?: string;
    comparison?: string;
    pair?: string;
    fromRevision?: number | string;
    request?: string;
  };
  mode?: 'proposal' | 'review';
  reviewTab?: string;
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
  const [proposalReadError, setProposalReadError] = useState(false);
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
  const [candidateReadError, setCandidateReadError] = useState('');
  const [candidateReadAttempt, setCandidateReadAttempt] = useState(0);
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
    owner: 'improvement' as const,
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
    setProposalReadError(false);
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
      try {
        const proposal = await invoke({ action: 'proposal', id: initial.proposal });
        if (epoch !== scopeEpoch.current || !mounted.current) return;
        if ('proposal' in proposal && proposal.proposal) {
          setProposalReadError(false);
          setSelectedProposal(proposal.proposal);
          if (proposal.proposal.candidate) setCandidate(proposal.proposal.candidate.id);
        } else setProposalReadError(true);
      } catch {
        if (epoch === scopeEpoch.current && mounted.current) setProposalReadError(true);
      }
    }
  }
  useEffect(() => {
    setCandidate(initial.candidate);
    setRequests([]);
    loadedMoreRequests.current = false;
    setRequestCursor(null);
    setSelectedProposal(null);
    setProposalReadError(false);
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
    setComparison(null);
    setComparisonId(initial.comparison || '');
  }, [candidate, state.actorScope, state.projectId, state.bundleId, state.channel]);
  useEffect(() => {
    let stale = false;
    setDetail(null);
    setCandidateReadError('');
    if (candidate)
      void invoke({ action: 'candidate', versionId: candidate })
        .then((r) => {
          if (!stale && 'candidate' in r && r.candidate && 'parentPayload' in r && r.parentPayload)
            setDetail({ candidate: r.candidate, parentPayload: r.parentPayload });
        })
        .catch((e) => {
          if (!stale) setCandidateReadError(e.message || 'Could not read this version.');
        });
    return () => {
      stale = true;
    };
  }, [
    candidateReadAttempt,
    candidate,
    state.actorScope,
    state.projectId,
    state.bundleId,
    state.channel,
  ]);
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
  function comparisonHref(id: string, request?: string, tab = 'cases') {
    return bundleHref(scope, 'changes', {
      candidate: candidate || undefined,
      draft: initial.draft || undefined,
      generation: initial.generation || undefined,
      proposal: initial.proposal && initial.proposal !== 'new' ? initial.proposal : undefined,
      comparison: id,
      request,
      reviewTab: tab,
      fromRevision: initial.fromRevision,
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
                : { ok: true, promotion: submitted.result as import('@acclimate/sdk').Release };
        }
      }
      if (epoch !== scopeEpoch.current) return;
      if (!mounted.current) return;
      if ('comparison' in r && r.comparison) {
        setComparison(r.comparison);
        void router.navigate({ href: comparisonHref(r.comparison.id, undefined, 'details') });
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
  // Open on the newest completed result, matching the Changes board's Review action,
  // instead of an empty "choose a result" state. Explicit selections always win.
  const latestCompared =
    mode === 'review' &&
    candidate &&
    !isCurrentRelease &&
    !initial.comparison &&
    !initial.request &&
    !initial.pair
      ? candidateRequests.find(
          (request) => request.status === 'completed' && Boolean(request.comparisonId),
        )
      : undefined;
  const autoSelectHref = latestCompared?.comparisonId
    ? comparisonHref(latestCompared.comparisonId, latestCompared.id, reviewTab || 'cases')
    : '';
  const dirtyReview = Boolean(reason) || customConfiguration !== savedEvaluationForm;
  const autoSelectedFor = useRef('');
  useEffect(() => {
    if (!autoSelectHref || autoSelectedFor.current === candidate) return;
    autoSelectedFor.current = candidate;
    // Never move the page while someone has started typing.
    if (dirtyReview) return;
    void router.navigate({ href: autoSelectHref, replace: true, resetScroll: false });
  }, [autoSelectHref, candidate, dirtyReview, router]);
  const savedReviewDetails = detail?.candidate && (
    <>
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
  const highlightedResult =
    comparison &&
    comparison.candidateVersionId === candidate &&
    (directRequest
      ? requestEvidence(directRequest, comparison).status === 'bound'
      : !initial.request && initial.comparison === comparison.id && comparison.evaluation)
      ? comparison
      : null;
  const reviewHref =
    comparison &&
    bundleHref(scope, 'changes', {
      candidate: comparison.candidateVersionId,
      comparison: comparison.id,
      request: comparison.evaluation?.requestId,
      fromRevision: initial.fromRevision,
    });
  const caseWorkbench = comparison && reviewHref && (
    <EvaluationCaseWorkbench
      key={comparison.id}
      comparison={comparison}
      reviewHref={reviewHref}
      linkedPair={initial.comparison === comparison.id ? initial.pair : undefined}
    />
  );
  const pendingRun =
    directRequest && (directRequest.status === 'requested' || directRequest.status === 'running')
      ? directRequest
      : null;
  const evaluationSetup = detail?.candidate && !isCurrentRelease && (
    <EvaluationSetup
      key={candidateRequests.length === 0 ? 'first-request' : 'another-request'}
      scopeIdentity={{
        channel: state.channel,
        parent: detail.candidate.version.parentVersionId ?? undefined,
        candidate: detail.candidate.version.id,
      }}
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
  const staleParent = Boolean(detail?.candidate && !currentBase && !isCurrentRelease);
  const releaseReason = staleParent
    ? 'The selected channel has a different published parent. Create a change from the current release before evaluating or publishing to this channel.'
    : !state.canEdit
      ? 'Workspace edit access is required to review a release.'
      : !comparison ||
          comparison.candidateVersionId !== candidate ||
          comparison.parentVersionId !== state.resolution.version.id ||
          !detail?.candidate ||
          !currentBase
        ? 'Select evidence for this candidate and the current published parent.'
        : !comparison.complete
          ? comparisonIncompleteReason(comparison)
          : compatibility.length
            ? 'Resolve the compatibility issues before reviewing a release.'
            : busy || pending || related.blocked
              ? 'Resolve the pending operation before reviewing a release.'
              : null;
  const activeTab = ['cases', 'files', 'runs', 'details'].includes(reviewTab ?? '')
    ? reviewTab!
    : comparison || initial.comparison || initial.pair
      ? 'cases'
      : 'runs';
  const fileCount = detail?.candidate
    ? artifactChanges(detail.parentPayload, detail.candidate.payload).length
    : 0;
  // A finished suggestion that produced nothing has no files, cases or runs to tab through.
  const settledWithoutCandidate = Boolean(
    initial.proposal &&
      selectedProposal &&
      !selectedProposal.candidate &&
      !['queued', 'running'].includes(selectedProposal.status),
  );
  const showReview =
    mode === 'review' &&
    (!candidateReadError || initial.comparison || initial.request || initial.proposal);
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
      {mode === 'review' && candidateReadError && (
        <section className="workspace-panel space-y-3 p-4" aria-label="Saved change unavailable">
          <h2 className="evaluation-page-title">Saved change unavailable</h2>
          <p role="alert">{candidateReadError}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setCandidateReadAttempt((attempt) => attempt + 1)}
            >
              Retry opening change
            </Button>
            <Button variant="outline" asChild>
              <ConsoleLink href={bundleHref(scope, 'changes')}>View changes</ConsoleLink>
            </Button>
          </div>
        </section>
      )}
      {showReview && (
        <div
          className="review-workspace evaluation-workspace min-w-0"
          role="region"
          aria-label="Evidence and release decision"
        >
          <section className="review-summary space-y-3 px-4 py-3" aria-label="Saved change review">
            <div className="workflow-status-row flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="review-identity flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="evaluation-page-title">
                  {initial.comparison || highlightedResult
                    ? 'Review comparison'
                    : initial.request
                      ? 'Evaluation request'
                      : initial.proposal
                        ? 'Review suggestion'
                        : isCurrentRelease
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
                {initial.proposal && !selectedProposal && !proposalReadError && (
                  <span role="status">Loading saved suggestion…</span>
                )}
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
            {candidate && !isCurrentRelease && !initial.comparison && !initial.request && (
              <p className="review-boundary text-muted-foreground">
                {reviewNextStep(candidateRequests, Boolean(comparison), Boolean(requestCursor))}
              </p>
            )}
            {proposalReadError && (
              <div role="alert" className="suggestion-result space-y-2">
                <p>
                  {selectedProposal
                    ? 'Could not refresh this suggestion. Showing its last known state.'
                    : 'This suggestion could not be opened in this bundle.'}{' '}
                  Retrying automatically.
                </p>
                <ConsoleLink className="underline" href={bundleHref(scope, 'changes')}>
                  View changes
                </ConsoleLink>
              </div>
            )}
            {selectedProposal && (
              <div className="suggestion-result space-y-2" data-status={selectedProposal.status}>
                <p className="suggestion-result-status" role="status">
                  {selectedProposal.status === 'queued'
                    ? 'Waiting for provider'
                    : selectedProposal.status === 'running'
                      ? 'Provider is preparing a suggestion'
                      : selectedProposal.status === 'succeeded'
                        ? selectedProposal.candidate
                          ? 'Suggestion ready'
                          : 'No change proposed'
                        : 'Suggestion failed'}
                </p>
                {selectedProposal.rationale && <p>{selectedProposal.rationale}</p>}
                {selectedProposal.error && <p role="alert">{selectedProposal.error}</p>}
                {!selectedProposal.candidate && (
                  <p>
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
              </>
            )}
            {comparison && (
              <>
                {(comparison.candidateVersionId !== candidate ||
                  (!isCurrentRelease &&
                    !staleParent &&
                    comparison.parentVersionId !== state.resolution.version.id)) && (
                  <p role="alert">
                    {isCurrentRelease
                      ? 'This evidence belongs to a different candidate. It does not describe this release.'
                      : 'This evidence does not match the saved candidate and current release target. Release with this evidence is unavailable.'}
                  </p>
                )}
                {comparison.runtime.source === 'simulated-example' && (
                  <p className="evaluation-example-note">
                    <FlaskConical aria-hidden="true" />
                    Simulated example evidence. No agent or model ran for these results.
                  </p>
                )}
              </>
            )}
          </section>
          {comparison && comparison.candidateVersionId === candidate && (
            <EvaluationOutcomeStrip comparison={comparison} />
          )}
          {!settledWithoutCandidate && (
            <div className="review-decision-desk">
              <aside className="review-decision-rail" aria-label="Release decision">
                {!isCurrentRelease && (comparison || staleParent) && (
                  <Alert
                    data-tone={releaseReason ? 'warning' : 'success'}
                    className="review-readiness"
                  >
                    <AlertTitle>
                      {releaseReason ? 'Release review unavailable' : 'Ready for release review'}
                    </AlertTitle>
                    <AlertDescription>
                      {releaseReason && <p id="release-readiness-reason">{releaseReason}</p>}
                      <div className="status-actions">
                        {staleParent && (
                          <Button variant="outline" asChild>
                            <ConsoleLink href={bundleHref(scope, 'changes', { draft: 'new' })}>
                              New draft from current release
                            </ConsoleLink>
                          </Button>
                        )}
                        {comparison && (
                          <Button
                            aria-describedby={
                              releaseReason ? 'release-readiness-reason' : undefined
                            }
                            disabled={Boolean(releaseReason)}
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
                        )}
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
                {comparison && comparison.candidateVersionId === candidate && (
                  <EvaluationScorecard comparison={comparison} compact />
                )}

                {comparison && (
                  <section
                    className="review-section space-y-2 p-3"
                    aria-label="Policy verdict status"
                  >
                    <h3 className="font-semibold">Policy checks</h3>
                    <StatusBadge
                      tone={
                        blockers.length
                          ? 'warning'
                          : receipts?.comparison.some((receipt) => receipt.verdict === 'pass')
                            ? 'success'
                            : 'neutral'
                      }
                    >
                      {receiptReadFailed
                        ? 'Status unavailable'
                        : !receipts
                          ? 'Checking verdicts…'
                          : blockers.length
                            ? `${blockers.length} blocking`
                            : receipts.comparison.length
                              ? 'Verdicts reported'
                              : 'No verdict reported'}
                    </StatusBadge>
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
              </aside>
              <Tabs
                className="review-evidence-tabs min-w-0"
                value={activeTab}
                onValueChange={async (value) => {
                  const url = new URL(router.state.location.href, 'https://console.invalid');
                  url.searchParams.set('reviewTab', value);
                  await router.navigate({
                    href: url.pathname + url.search,
                    resetScroll: false,
                    ignoreBlocker: true,
                  });
                }}
              >
                <TabsList variant="line" className="console-page-tabs" aria-label="Review evidence">
                  <TabsTrigger value="cases">
                    Cases ({comparison ? evaluationPairs(comparison).length : 0})
                  </TabsTrigger>
                  <TabsTrigger value="files">Files changed ({fileCount})</TabsTrigger>
                  <TabsTrigger value="runs">
                    Evaluation runs ({candidateRequests.length})
                  </TabsTrigger>
                  <TabsTrigger value="details">Details</TabsTrigger>
                </TabsList>
                <TabsContent value="cases" className="min-w-0 text-sm">
                  {caseWorkbench || (
                    <p className="workspace-panel p-4">
                      Case outcomes appear when a comparison is available.
                    </p>
                  )}
                </TabsContent>
                <TabsContent
                  value="files"
                  className="review-scroll-panel min-w-0 text-sm"
                  aria-label="File changes"
                >
                  <section
                    className="review-section space-y-3 p-4"
                    aria-label="Review file changes"
                  >
                    {detail?.candidate ? (
                      <ContentDiff base={detail.parentPayload} current={detail.candidate.payload} />
                    ) : (
                      <p>Saved file changes are unavailable.</p>
                    )}
                  </section>
                </TabsContent>
                <TabsContent value="runs" className="min-w-0 space-y-3 text-sm">
                  {pendingRun && (
                    <div className="evaluation-run-highlight">
                      <p className="evaluation-run-dataset">{pendingRun.datasetRevision}</p>
                      <h3 className="evaluation-run-phase">
                        {pendingRun.status === 'requested'
                          ? 'Waiting for the evaluator'
                          : 'Evaluation in progress'}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        Parent {pendingRun.parentVersionId.slice(0, 8)} → candidate{' '}
                        {pendingRun.candidateVersionId.slice(0, 8)} ·{' '}
                        {pendingRun.expectedCases.length} expected{' '}
                        {pendingRun.expectedCases.length === 1 ? 'pair' : 'pairs'}
                      </p>
                      {pendingRun.status === 'running' && (
                        <EvaluationActivity request={pendingRun} progress={selectedProgress} />
                      )}
                      <a
                        href={`#evaluation-request-${pendingRun.id}`}
                        className="evaluation-highlight-link"
                      >
                        View request details <ArrowRight aria-hidden="true" />
                      </a>
                    </div>
                  )}
                  {(comparison || candidateRequests.length > 0 || requestCursor) && (
                    <section className="review-section review-evidence space-y-3 px-4 py-3">
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
                            {<ReceiptTime value={comparison.createdAt} />}
                          </span>
                        )}
                      </div>
                      {comparison ? (
                        <>
                          {!initial.request && !comparison.evaluation && (
                            <p>
                              This comparison was submitted independently of an evaluation request.
                            </p>
                          )}
                          {selectedRequest && selectedCheckCommand && (
                            <div className="space-y-2" aria-label="Application policy check">
                              <h3>Check the application’s quality policy</h3>
                              {receiptReadFailed ? (
                                <p role="alert">Could not refresh policy checks.</p>
                              ) : !receipts ? (
                                <p>Loading policy checks…</p>
                              ) : !receipts.comparison.length ? (
                                <p>No policy verdict has been reported for this comparison.</p>
                              ) : null}
                              {receipts && receipts.comparison.length > 0 && (
                                <PolicyReceiptList receipts={receipts.comparison} />
                              )}
                              <Button variant="outline" onClick={refreshReceipts}>
                                Refresh policy checks
                              </Button>
                              <EvaluationHandoffDownload
                                handoff={evaluationHandoff(
                                  state.publicApiUrl,
                                  state.projectId,
                                  state.bundleId,
                                  selectedRequest.id,
                                  selectedRequest,
                                )}
                              />
                              <Disclosure>
                                <DisclosureTrigger>Policy check command</DisclosureTrigger>
                                <DisclosureContent className="pt-2">
                                  <section className="space-y-2" aria-label="Policy check command">
                                    <h3>Run the policy check</h3>
                                    <p>
                                      Run the check on the evaluator machine with its private
                                      configuration and policy file. Its verdict and check names
                                      appear here.
                                    </p>
                                    {!isCheckoutCodexEvaluator(selectedRequest) && (
                                      <EvaluatorLanguageSelect
                                        language={languageFor(selectedRequest.id)}
                                        onChange={(value) =>
                                          rememberLanguage(selectedRequest.id, value)
                                        }
                                      />
                                    )}
                                    <SyntaxCode code={selectedCheckCommand} language="bash" />
                                    <CopyButton
                                      value={selectedCheckCommand}
                                      label="Copy policy check command"
                                    />
                                  </section>
                                </DisclosureContent>
                              </Disclosure>
                            </div>
                          )}
                          {!isCurrentRelease && (
                            <div className="review-evidence-action">
                              {blockers.some((row) => row.comparisonId !== comparison.id) && (
                                <section
                                  aria-label="Other blocking policy verdicts"
                                  className="space-y-2"
                                >
                                  <h3>
                                    Other comparisons with blocking verdicts for this candidate
                                  </h3>
                                  <PolicyReceiptList
                                    receipts={blockers.filter(
                                      (row) => row.comparisonId !== comparison.id,
                                    )}
                                  />
                                </section>
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
                  {candidate && (
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
                            return (
                              <Disclosure
                                key={`${request.id}-${initial.request === request.id}-${selectedEvidence}`}
                                defaultOpen={
                                  createdRequestId === request.id ||
                                  (initial.request === request.id && !selectedEvidence) ||
                                  (candidateRequests.length === 1 &&
                                    index === 0 &&
                                    !request.comparisonId)
                                }
                                className={`evaluation-request space-y-2${selectedEvidence ? ' is-selected-evidence' : ''}`}
                                aria-label={`Evaluation request ${request.id}`}
                              >
                                <div className="evaluation-request-row flex flex-wrap items-center justify-between gap-2">
                                  <DisclosureTrigger
                                    id={`evaluation-request-${request.id}`}
                                    aria-description={labels.details}
                                    className="cursor-pointer font-medium"
                                  >
                                    <span className="evaluation-run-summary">
                                      {directRequest?.id === request.id &&
                                        !loadedCandidateRequests.some(
                                          (row) => row.id === request.id,
                                        ) && <span>Selected outside loaded pages · </span>}
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
                                        <span
                                          className={`evaluation-run-status is-${request.status}`}
                                        >
                                          {labels.status}
                                        </span>{' '}
                                        · {request.expectedCases.length}{' '}
                                        {request.expectedCases.length === 1 ? 'pair' : 'pairs'}
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
                                  <EvaluationRequestInspector
                                    consoleOrigin={consoleOrigin}
                                    language={languageFor(request.id)}
                                    onLanguageChange={(value) =>
                                      rememberLanguage(request.id, value)
                                    }
                                    request={request}
                                    showDownload={
                                      request.id !== selectedRequest?.id || !selectedCheckCommand
                                    }
                                    publicApiUrl={state.publicApiUrl}
                                    projectId={state.projectId}
                                    bundleId={state.bundleId}
                                  >
                                    {initial.request === request.id && !pendingRun && (
                                      <EvaluationActivity
                                        request={request}
                                        progress={selectedProgress}
                                      />
                                    )}
                                  </EvaluationRequestInspector>
                                  {['requested', 'running'].includes(request.status) && (
                                    <Disclosure>
                                      <DisclosureTrigger className="cursor-pointer">
                                        Record an interruption
                                      </DisclosureTrigger>
                                      <DisclosureContent>
                                        <div className="mt-3 space-y-3">
                                          <p role="note">
                                            Recording an interruption does not stop the external app
                                            or its charges.
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
                  )}

                  {evaluationSetup}
                </TabsContent>
                <TabsContent
                  value="details"
                  className="review-scroll-panel min-w-0 space-y-3 text-sm"
                  aria-label="Review details"
                >
                  {comparison && comparison.candidateVersionId === candidate && (
                    <EvaluationScorecard comparison={comparison} />
                  )}
                  {comparison && (
                    <ComparisonEvidence
                      comparison={comparison}
                      comparisonUrl={reviewHref || undefined}
                      compact
                    />
                  )}
                  {detail?.candidate && (
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
                      <h3>Comparison lookup and details</h3>
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
                    </section>
                  )}
                </TabsContent>
              </Tabs>
            </div>
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
                  Publish the saved snapshot reviewed on this page. The full diff remains on the
                  page.
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
                  <p className="whitespace-pre-wrap break-words">Reason: {releaseReview?.reason}</p>
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
                    The policy verdicts changed. Close this dialog and review the updated verdicts.
                  </p>
                )}
              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => setReleaseReview(null)}>
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
                        JSON.stringify(releaseReview.blocking) !== JSON.stringify(blockerRefs) ||
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
      )}
    </div>
  );
}
