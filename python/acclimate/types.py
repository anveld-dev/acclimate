"""HTTP request and response dictionaries.

Keys use the service's camelCase wire names. Python method arguments and
attributes use snake_case.
"""

from typing import Any, Generic, Literal, NotRequired, TypedDict, TypeVar

_T = TypeVar("_T")

FileKind = Literal["instruction", "skill", "memory"]
CompatibilityTarget = Literal["generic", "codex", "claude", "pi", "cursor"]


class BundleFile(TypedDict):
    path: str
    kind: FileKind
    text: str


class BundlePayload(TypedDict):
    schemaVersion: Literal[1]
    files: list[BundleFile]


class CreateBundleRequest(TypedDict):
    name: str
    compatibilityTarget: NotRequired[CompatibilityTarget]


class Bundle(TypedDict):
    id: str
    name: str
    workspaceId: str
    compatibilityTarget: CompatibilityTarget
    createdAt: str


class VersionMetadata(TypedDict):
    id: str
    bundleId: str
    parentVersionId: str | None
    digest: str
    createdAt: str


class ChannelResolution(TypedDict):
    channel: str
    revision: str
    version: VersionMetadata


class CreateVersionRequest(TypedDict):
    parentVersionId: str | None
    payload: BundlePayload


class CreateReleaseRequest(TypedDict):
    versionId: str
    expectedRevision: str
    unevaluatedReason: str


class Release(TypedDict):
    id: str
    channel: str
    revision: str
    version: VersionMetadata
    previousVersionId: str | None
    unevaluatedReason: str | None
    reviewer: str
    createdAt: str


class ReleasePage(TypedDict):
    items: list[Release]
    nextBeforeRevision: str | None


class VerifiedVersionConnection(TypedDict):
    workspaceId: str
    connectionId: str


class VerifiedVersion(TypedDict):
    version: VersionMetadata
    payload: BundlePayload
    resolution: NotRequired[ChannelResolution]
    resolvedAt: float
    stale: bool
    # Present when the SDK resolved the bundle for an explicitly scoped connection.
    connection: NotRequired[VerifiedVersionConnection]


class ConnectionLatestObservation(TypedDict):
    eventId: str
    stage: str
    versionId: str
    digest: str
    occurredAt: str
    receivedAt: str


class ConnectionObservation(TypedDict):
    id: str
    displayName: str
    bundleId: str
    channel: str
    enabled: bool
    latestObservation: ConnectionLatestObservation | None


class ConnectionObservationPage(TypedDict):
    items: list[ConnectionObservation]
    nextCursor: str | None


class Page(TypedDict, Generic[_T]):
    """A bounded service listing. Send ``nextCursor`` back unchanged as ``cursor``."""

    items: list[_T]
    nextCursor: str | None


class Workspace(TypedDict):
    id: str
    name: str
    role: str


class Channel(TypedDict):
    name: str
    revision: str
    versionId: str


BundleOrigin = Literal["created", "example", "imported", "unknown"]


class BundleSetupRequest(TypedDict):
    name: str
    origin: Literal["created", "example", "imported"]
    channel: str
    payload: BundlePayload
    reason: str
    compatibilityTarget: NotRequired[CompatibilityTarget]
    sourceLabel: NotRequired[str]


class BundleSetup(TypedDict):
    bundle: Bundle
    version: VersionMetadata
    resolution: ChannelResolution
    promotion: Release


ConnectionCredentialKind = Literal["content-read", "receipt-write"]


class ConnectionCredentialSummary(TypedDict):
    id: str
    kind: ConnectionCredentialKind
    createdAt: str
    revokedAt: str | None


class Connection(TypedDict):
    id: str
    workspaceId: str
    bundleId: str
    channel: str
    displayName: str
    enabled: bool
    createdAt: str
    credentials: NotRequired[list[ConnectionCredentialSummary]]


class CreateConnectionRequest(TypedDict):
    bundleId: str
    channel: str
    displayName: str


class ConnectionCredential(TypedDict):
    id: str
    kind: ConnectionCredentialKind
    secret: str


class DeliveryReceiptRequest(TypedDict):
    eventId: str
    connectionId: str
    workspaceId: str
    bundleId: str
    versionId: str
    digest: str
    stage: Literal["resolved", "downloaded", "verified", "prepared", "started"]
    occurredAt: str
    source: Literal["network", "cache", "offline"]
    channel: NotRequired[str | None]
    revision: NotRequired[str | None]
    resolvedAt: NotRequired[str | None]
    stale: NotRequired[bool | None]


class DeliveryReceipt(DeliveryReceiptRequest):
    receivedAt: str
    delayed: bool


class OfflineMaxAge(TypedDict):
    """Use a cached channel resolution up to this age after a transport failure or HTTP 503."""

    max_age_ms: int


class OfflinePinnedVersion(TypedDict):
    """Use the cached copy of this exact version after a transport failure or HTTP 503."""

    pinned_version_id: str


OfflinePolicy = OfflineMaxAge | OfflinePinnedVersion


class OperationCommitted(TypedDict):
    status: Literal["committed"]
    operationId: str
    path: str
    requestFingerprint: NotRequired[str]
    result: BundleSetup | Release | VersionMetadata | dict


class OperationNotObserved(TypedDict):
    status: Literal["not_observed"]
    operationId: str


class OperationClosed(TypedDict):
    status: Literal["closed"]
    operationId: str
    path: NotRequired[str]


Operation = OperationCommitted | OperationNotObserved | OperationClosed

LearningJson = str | int | float | bool | None | list["LearningJson"] | dict[str, "LearningJson"]
LearningLoopStatus = Literal["running", "paused", "stopped"]
LearningEvaluationStatus = Literal["queued", "running", "scored", "failed", "cancelled"]


class LearningSetting(TypedDict):
    domain: str
    benchmark: str
    policyModel: str


class LearningHeldOut(TypedDict):
    digest: str
    cases: int


class LearningLoopRequest(TypedDict):
    channel: str
    appPrincipalId: str
    setting: LearningSetting
    heldOut: LearningHeldOut


class LearningRoundSummary(TypedDict):
    id: str
    number: int
    state: Literal["scoring_incumbent", "proposing", "screening", "evaluating", "selecting",
                   "scoring_held_out", "completed", "failed", "stopped"]
    decision: Literal["adopted", "kept"] | None
    reason: Literal["selector-kept", "no-candidates", "no-survivors", "no-evaluated-candidates",
                    "channel-moved", "incumbent-evaluation-failed", "optimizer-unavailable",
                    "optimizer-context-too-large", "selector-unavailable", "stopped"] | None
    parentVersionId: str
    adoptedSample: int | None
    adoptedVersionId: str | None
    incumbentScore: float | None
    heldOutScore: float | None
    heldOutError: str | None
    createdAt: str
    endedAt: str | None


class LearningLoop(LearningLoopRequest):
    workspaceId: str
    bundleId: str
    status: LearningLoopStatus
    pauseReason: Literal["operator", "failed-rounds", "optimizer-context-too-large"] | None
    evolveRevision: int
    liveCases: int
    memoryRevision: int
    nextRound: int
    failedRounds: int
    enrolledBy: str
    createdAt: str
    updatedAt: str
    activeRound: LearningRoundSummary | None
    rounds: list[LearningRoundSummary]


class _LearningProblemId(TypedDict):
    id: str


class _LearningNewProblem(TypedDict):
    new: str


class LearningDiagnosis(TypedDict):
    problem: _LearningProblemId | _LearningNewProblem
    predicted: list[str]


class LearningSelection(TypedDict):
    decision: Literal["adopt", "keep"]
    sample: int | None
    versionId: str | None
    digest: str | None
    reason: str
    model: str
    inputDigest: str


class _LearningEdit(TypedDict):
    path: str
    oldText: str
    newText: str


class _LearningFileWrite(TypedDict):
    op: Literal["write"]
    path: str
    text: str


class _LearningFileDelete(TypedDict):
    op: Literal["delete"]
    path: str


class _LearningChanges(TypedDict):
    edits: list[_LearningEdit]
    files: list[_LearningFileWrite | _LearningFileDelete]


class _LearningFinding(TypedDict):
    rule: str
    path: str


class _LearningScan(TypedDict):
    clean: bool
    findings: list[_LearningFinding]


class _LearningScreen(TypedDict):
    verdict: Literal["evaluate", "skip"]
    reason: str


class LearningCandidate(TypedDict):
    sample: int
    status: Literal["generating", "generated", "dropped", "screened_out", "evaluating",
                    "evaluated", "evaluation_failed"]
    dropReason: Literal["provider-failed", "format-rejected", "scanner-rejected", "no-change"] | None
    rationale: str | None
    changes: _LearningChanges | None
    diagnosis: LearningDiagnosis | None
    scan: _LearningScan | None
    screen: _LearningScreen | None
    versionId: str | None
    evaluationId: str | None
    evolveScore: float | None


class _LearningEvaluationIdentity(TypedDict):
    roundId: str
    role: Literal["incumbent", "candidate", "retained"]
    sample: int | None
    split: Literal["evolve", "heldOut"]
    versionId: str
    digest: str
    evolveRevision: int | None
    deadlineAt: str


class LearningWorkItem(_LearningEvaluationIdentity):
    evaluationId: str
    roundNumber: int
    heldOut: LearningHeldOut | None
    status: Literal["queued", "running"]


class LearningWork(TypedDict):
    bundleId: str
    status: LearningLoopStatus
    items: list[LearningWorkItem]


class LearningHeldOutRollout(TypedDict):
    score: float
    passed: bool


class LearningRollout(LearningHeldOutRollout):
    trace: NotRequired[str | None]
    error: NotRequired[str | None]


class _LearningCaseReport(TypedDict):
    caseId: str
    rollouts: list[LearningRollout]


class LearningEvaluationReport(TypedDict):
    cases: list[_LearningCaseReport]


class LearningEvaluationReportRequest(TypedDict):
    attemptId: str
    cases: NotRequired[list[_LearningCaseReport]]
    error: NotRequired[str]


class _LearningCaseSummary(TypedDict):
    caseId: str
    passedRollouts: int
    meanScore: float


class LearningEvaluation(_LearningEvaluationIdentity):
    id: str
    status: LearningEvaluationStatus
    score: float | None
    cases: int
    reportedCases: int
    createdAt: str
    startedAt: str | None
    error: str | None
    caseSummaries: NotRequired[list[_LearningCaseSummary]]
    report: NotRequired[LearningEvaluationReport]


class LearningRound(LearningRoundSummary):
    channel: str
    channelRevision: str
    evolveRevision: int
    memoryRevision: int
    memoryDigest: str | None
    historyDigest: str | None
    setting: LearningSetting
    heldOut: LearningHeldOut
    optimizerModel: str | None
    selection: LearningSelection | None
    candidates: list[LearningCandidate]
    evaluations: list[LearningEvaluation]


class LearningEvaluationStart(TypedDict):
    attemptId: str


class LearningEvolveCase(TypedDict):
    caseId: str
    input: LearningJson
    expected: LearningJson


class LearningEvaluationAssignment(TypedDict):
    evaluation: LearningEvaluation
    cases: list[LearningEvolveCase] | None
    heldOut: LearningHeldOut | None
    reportedCaseIds: list[str]


class LearningEvolveCasesRequest(TypedDict):
    cases: NotRequired[list[LearningEvolveCase]]
    retire: NotRequired[list[str]]


class LearningEvolveCasesReceipt(TypedDict):
    evolveRevision: int
    added: int
    retired: int
    liveCases: int


class LearningOutcomeRequest(TypedDict):
    outcomeId: str
    versionId: str
    digest: str
    input: LearningJson
    expected: LearningJson


class LearningOutcomeReceipt(TypedDict):
    outcomeId: str
    caseId: str
    evolveRevision: int


class _LearningMemoryProvenance(LearningSetting):
    round: int


class _LearningMemoryStoredProvenance(_LearningMemoryProvenance):
    evolveRevision: int
    heldOutDigest: str
    optimizerModel: str


class _LearningMemoryWhat(TypedDict):
    rationale: str
    changes: _LearningChanges


class _LearningMemoryAttempt(TypedDict):
    round: int
    sample: int
    accepted: Literal[True]
    backfilled: bool
    what: _LearningMemoryWhat
    files: list[str]
    predicted: list[str]
    fixed: list[str]
    missed: list[str]
    passed: int
    total: int
    domain: str
    provenance: _LearningMemoryProvenance


class _LearningMemoryProblem(TypedDict):
    id: str
    rootCause: str
    openedRound: int
    attempts: list[_LearningMemoryAttempt]


class _LearningImprovementMemory(TypedDict):
    schemaVersion: Literal[1]
    memoryRevision: int
    problems: list[_LearningMemoryProblem]


class _LearningMemoryRecord(TypedDict):
    revision: int
    problemId: str
    roundId: str
    round: int
    versionId: str
    provenance: _LearningMemoryStoredProvenance


class LearningMemory(TypedDict):
    currentRevision: int
    memoryRevision: int
    memoryDigest: str
    improvementMemory: _LearningImprovementMemory
    records: list[_LearningMemoryRecord]


class LearningRoundPage(TypedDict):
    items: list[LearningRoundSummary]
    next: int | None


__all__ = [
    "LearningSetting",
    "LearningHeldOut",
    "LearningLoopRequest",
    "LearningRoundSummary",
    "LearningLoop",
    "LearningDiagnosis",
    "LearningSelection",
    "LearningCandidate",
    "LearningWorkItem",
    "LearningWork",
    "LearningHeldOutRollout",
    "LearningRollout",
    "LearningEvaluationReport",
    "LearningEvaluationReportRequest",
    "LearningEvaluation",
    "LearningRound",
    "LearningEvaluationStart",
    "LearningEvolveCase",
    "LearningEvaluationAssignment",
    "LearningEvolveCasesRequest",
    "LearningEvolveCasesReceipt",
    "LearningOutcomeRequest",
    "LearningOutcomeReceipt",
    "LearningMemory",
    "LearningRoundPage",

    "FileKind",
    "CompatibilityTarget",
    "BundleFile",
    "BundlePayload",
    "CreateBundleRequest",
    "Bundle",
    "VersionMetadata",
    "ChannelResolution",
    "CreateVersionRequest",
    "CreateReleaseRequest",
    "Release",
    "ReleasePage",
    "VerifiedVersion",
    "VerifiedVersionConnection",
    "ConnectionLatestObservation",
    "ConnectionObservation",
    "ConnectionObservationPage",
    "Page",
    "Workspace",
    "Channel",
    "BundleOrigin",
    "BundleSetupRequest",
    "BundleSetup",
    "ConnectionCredentialKind",
    "ConnectionCredentialSummary",
    "Connection",
    "CreateConnectionRequest",
    "ConnectionCredential",
    "DeliveryReceiptRequest",
    "DeliveryReceipt",
    "OfflineMaxAge",
    "OfflinePinnedVersion",
    "OfflinePolicy",
    "OperationCommitted",
    "OperationNotObserved",
    "OperationClosed",
    "Operation",
]
