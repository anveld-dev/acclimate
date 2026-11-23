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


class OfflinePinnedVersion(TypedDict):
    """Use the cached copy of this exact version after a transport failure or HTTP 503."""

    pinned_version_id: str


OfflinePolicy = OfflinePinnedVersion


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


class _LearningSettingRequest(TypedDict):
    domain: str
    benchmark: str


class LearningLoopRequest(TypedDict):
    channel: str
    setting: _LearningSettingRequest
    taskModel: str
    judgeModel: str
    maxRoundsPerDay: NotRequired[int]


class LearningRoundSummary(TypedDict):
    diff: "_LearningChanges | None"
    diagnosis: "LearningDiagnosis | None"
    evolveScore: float | None
    taskRevision: int
    trigger: str
    incumbentReused: bool
    taskModel: str | None
    judgeModel: str | None
    id: str
    number: int
    state: Literal["scoring_incumbent", "proposing", "screening", "evaluating", "selecting",
                   "scoring_held_out", "completed", "failed", "stopped"]
    decision: Literal["adopted", "kept"] | None
    reason: Literal["selector-kept", "no-candidates", "no-survivors", "no-evaluated-candidates",
                    "no-matching-executor", "channel-moved", "incumbent-evaluation-failed", "optimizer-unavailable",
                    "optimizer-context-too-large", "selector-unavailable", "stopped"] | None
    parentVersionId: str
    adoptedSample: int | None
    adoptedVersionId: str | None
    incumbentScore: float | None
    heldOutScore: float | None
    heldOutError: str | None
    createdAt: str
    endedAt: str | None


class _IncompleteCheck(TypedDict):
    kind: Literal["regression-check-incomplete"]
    roundId: str
    versionId: str


class _LearningAlert(TypedDict):
    reverted: NotRequired[bool]
    roundId: str
    score: float
    previousScore: float
    flippedTasks: int


class LearningLoop(TypedDict):
    channel: str
    setting: LearningSetting
    taskModel: str | None
    judgeModel: str | None
    maxRoundsPerDay: int
    taskRevision: int
    waiting: str | None
    alert: _LearningAlert | _IncompleteCheck | None
    admittedEvolve: int
    admittedHeldOut: int
    workspaceId: str
    bundleId: str
    status: LearningLoopStatus
    pauseReason: Literal["operator", "failed-rounds", "optimizer-context-too-large", "tasks-required"] | None
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


_ReasoningEffort = Literal["low", "medium", "high", "xhigh", "max", "ultra"]


class LearningSelection(TypedDict):
    decision: Literal["adopt", "keep"]
    sample: int | None
    versionId: str | None
    digest: str | None
    reason: str
    model: str
    reasoningEffort: NotRequired[_ReasoningEffort | None]
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
    field: Literal["rationale", "rootCause", "path", "text"]
    path: str | None


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


class LearningHeldOutRollout(TypedDict):
    score: float
    passed: bool


class LearningRollout(LearningHeldOutRollout):
    gatewayLog: NotRequired[list[LearningJson]]
    reasons: NotRequired[list[str]]
    trace: NotRequired[str | None]
    error: NotRequired[str | None]


class _LearningCaseReport(TypedDict):
    caseId: str
    rollouts: list[LearningRollout]


class LearningEvaluationReport(TypedDict):
    cases: list[_LearningCaseReport]


class _LearningCaseSummary(TypedDict):
    caseId: str
    passedRollouts: int
    meanScore: float


class LearningEvaluation(_LearningEvaluationIdentity):
    passedCases: NotRequired[int]
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


class _LearningProgress(TypedDict):
    scored: int
    total: int


class LearningRound(LearningRoundSummary):
    progress: NotRequired[_LearningProgress]
    reverted: NotRequired[bool]
    confirmedParentScore: NotRequired[float | None]
    confirmedAdoptionScore: NotRequired[float | None]
    channel: str
    channelRevision: str
    evolveRevision: int
    memoryRevision: int
    memoryDigest: str | None
    historyDigest: str | None
    setting: LearningSetting
    optimizerModel: str | None
    optimizerReasoningEffort: _ReasoningEffort | None
    selection: LearningSelection | None
    candidates: list[LearningCandidate]
    evaluations: list[LearningEvaluation]


class LearningOutcomeRequest(TypedDict):
    output: NotRequired[LearningJson]
    outcomeId: str
    versionId: str
    digest: str
    input: LearningJson
    expected: LearningJson


class LearningOutcomeReceipt(TypedDict):
    outcomeId: str
    taskId: NotRequired[str]
    heldOutCount: NotRequired[int]
    taskRevision: int


class _LearningMemoryProvenance(LearningSetting):
    round: int


class _LearningMemoryStoredProvenance(_LearningMemoryProvenance):
    evolveRevision: int
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


class LearningTaskRequest(TypedDict):
    input: LearningJson
    grader: LearningJson


class LearningTaskEdit(TypedDict):
    input: NotRequired[LearningJson]
    grader: NotRequired[LearningJson]
    confirm: NotRequired[bool]


class LearningTask(TypedDict):
    taskId: str
    input: LearningJson
    grader: LearningJson
    split: str
    admission: str
    addedRevision: int


class LearningTaskPage(TypedDict):
    items: list[LearningTask]
    next: str | None
    heldOutCount: int


class LearningTaskReceipt(TypedDict):
    taskId: NotRequired[str]
    split: NotRequired[str]
    addedRevision: NotRequired[int]
    heldOutCount: NotRequired[int]


class LearningTaskRevision(TypedDict):
    taskId: str
    revision: int


class LearningTrialReceipt(TypedDict):
    trialId: str


class LearningTrial(TypedDict):
    trialId: str
    kind: str
    status: str
    output: NotRequired[LearningJson]
    gatewayLog: NotRequired[LearningJson]
    verdict: NotRequired[LearningJson]


class _SetAsideRow(TypedDict):
    row: int
    source: str
    reason: str


class LearningImport(TypedDict):
    importId: str
    rows: int
    pending: int
    converted: int
    cards: NotRequired[list[LearningTask]]
    status: NotRequired[str]
    message: NotRequired[str | None]
    setAsideCount: NotRequired[int]
    setAside: NotRequired[list[_SetAsideRow]]


class BlockedLearningVersion(TypedDict):
    digest: str
    removedBy: str
    note: str | None
    createdAt: str


class LearningUsageDay(TypedDict):
    day: str
    rounds: int
    rollouts: int
    optimizerTokens: int
    taskTokens: int
    judgeTokens: int


class LearningUsage(TypedDict):
    items: list[LearningUsageDay]


class LearningRollback(TypedDict):
    roundId: str
    note: NotRequired[str]


class _VerifiedModel(TypedDict):
    model: str
    ok: bool
    usage: bool
    message: str | None


class _ProviderVerification(TypedDict):
    status: Literal["pending", "verified", "failed"]
    checkedAt: str | None
    models: list[_VerifiedModel]


class ModelProvider(TypedDict):
    verification: NotRequired[_ProviderVerification]
    baseUrl: str | None
    allowedModels: list[str]
    hasKey: bool


class ModelProviderRequest(TypedDict):
    baseUrl: str
    allowedModels: list[str]
    apiKey: NotRequired[str]


__all__ = [
    "ModelProviderRequest",
    "ModelProvider",
    "LearningRollback",
    "BlockedLearningVersion",
    "LearningUsage",
    "LearningUsageDay",
    "LearningImport",
    "LearningTrial",
    "LearningTrialReceipt",
    "LearningTaskRevision",
    "LearningTaskReceipt",
    "LearningTaskPage",
    "LearningTask",
    "LearningTaskEdit",
    "LearningTaskRequest",
    "LearningJson",
    "LearningSetting",
    "LearningLoopRequest",
    "LearningRoundSummary",
    "LearningLoop",
    "LearningDiagnosis",
    "LearningSelection",
    "LearningCandidate",
    "LearningHeldOutRollout",
    "LearningRollout",
    "LearningEvaluationReport",
    "LearningEvaluation",
    "LearningRound",
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
    "OfflinePinnedVersion",
    "OfflinePolicy",
    "OperationCommitted",
    "OperationNotObserved",
    "OperationClosed",
    "Operation",
]
