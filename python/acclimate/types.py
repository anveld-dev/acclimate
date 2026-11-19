from typing import Literal, NotRequired, TypedDict

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
    projectId: str
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


class PolicyReceiptReference(TypedDict):
    comparisonId: str
    policyDigest: str


class PolicyOverride(TypedDict):
    reason: str
    receipts: list[PolicyReceiptReference]


class CreateReleaseRequest(TypedDict):
    versionId: str
    expectedRevision: str
    comparisonId: NotRequired[str]
    unevaluatedReason: NotRequired[str]
    policyOverride: NotRequired[PolicyOverride]


class Release(TypedDict):
    id: str
    channel: str
    revision: str
    version: VersionMetadata
    previousVersionId: str | None
    comparisonId: str | None
    unevaluatedReason: str | None
    policyOverride: NotRequired[PolicyOverride]
    policyApprovalPromotionId: NotRequired[str]
    reviewer: str
    createdAt: str


class ReleasePage(TypedDict):
    items: list[Release]
    nextBeforeRevision: str | None


class ProposalRequest(TypedDict):
    parentVersionId: str
    allowedPaths: list[str]
    hypothesis: str
    evidence: list[str]


class CriticVerdict(TypedDict):
    verdict: Literal["accept", "reject"]
    objections: list[str]
    risky: NotRequired[bool]


class ProposalChange(TypedDict):
    path: str
    before: str | None
    after: str | None


class ProposalScreen(TypedDict):
    stage: Literal["initial", "repair"]
    result: CriticVerdict | None
    changes: list[ProposalChange]
    scannerClean: NotRequired[bool]
    structural: NotRequired[bool]
    rationale: NotRequired[str]


class Proposal(TypedDict):
    id: str
    parentVersionId: str
    status: Literal["queued", "running", "succeeded", "failed"]
    attempts: int
    candidate: VersionMetadata | None
    rationale: str | None
    screening: NotRequired[list[ProposalScreen]]
    error: str | None
    createdAt: str


class CaseKey(TypedDict):
    caseId: str
    repetition: int


class Usage(TypedDict, total=False):
    inputTokens: int
    outputTokens: int
    costUsd: float


class Outcome(TypedDict):
    executionStatus: Literal["completed", "task_failed", "infrastructure_failed"]
    gradingStatus: Literal["scored", "missing", "failed"]
    reward: float | None
    outputRef: str | None
    error: str | None
    usage: Usage | None


class CasePair(CaseKey):
    parent: Outcome
    candidate: Outcome


class EvaluationBinding(TypedDict):
    requestId: str
    attemptId: str


class ComparisonRequest(TypedDict):
    evaluation: NotRequired[EvaluationBinding]
    parentVersionId: str
    candidateVersionId: str
    parentDigest: str
    candidateDigest: str
    datasetRevision: str
    runtime: dict[str, str]
    graderRevision: str
    expectedCases: list[CaseKey]
    results: list[CasePair]


class Comparison(ComparisonRequest):
    id: str
    complete: bool
    submitter: str
    createdAt: str


class VerifiedVersion(TypedDict):
    version: VersionMetadata
    payload: BundlePayload
    resolution: NotRequired[ChannelResolution]
    resolvedAt: float
    stale: bool


class EvaluationDescriptor(TypedDict):
    datasetRevision: str
    graderRevision: str
    runtime: dict[str, str]
    expectedCases: list[CaseKey]


class EvaluationHandoff(TypedDict):
    schemaVersion: Literal[1]
    serviceUrl: str
    projectId: str
    bundleId: str
    requestId: str
    configuration: EvaluationDescriptor


class _EvaluationTarget(EvaluationDescriptor):
    parentVersionId: str
    parentDigest: str
    candidateVersionId: str
    candidateDigest: str
    proposalId: NotRequired[str | None]


class EvaluationRequest(_EvaluationTarget):
    requireBoundEvidence: NotRequired[Literal[True]]


class Evaluation(_EvaluationTarget):
    requireBoundEvidence: Literal[True]
    id: str
    # ``abandoned``: the attempt's outcome is unknown; later reports are refused and
    # its evidence never counts.
    status: Literal["requested", "running", "completed", "failed", "interrupted", "abandoned"]
    evaluatorPrincipal: str | None
    attemptId: str | None
    comparisonId: str | None
    error: str | None
    createdAt: str
    updatedAt: str
    lastActivityAt: NotRequired[str]
    abandonedAt: NotRequired[str]
    abandonedBy: NotRequired[str]


class EvaluationPage(TypedDict):
    items: list[Evaluation]
    nextCursor: str | None


class StartEvaluationRequest(TypedDict):
    attemptId: str


class FinishEvaluationRequest(StartEvaluationRequest):
    comparisonId: str


class InterruptEvaluationRequest(TypedDict):
    reason: str


class AbandonEvaluationRequest(TypedDict):
    reason: str


class ComparisonPolicyIdentity(TypedDict):
    id: str
    revision: str
    sha256: str


class ComparisonPolicyCheck(TypedDict):
    code: str
    result: Literal["pass", "fail", "unknown"]


class ComparisonPolicyReport(TypedDict):
    requestId: str
    attemptId: str
    policy: ComparisonPolicyIdentity
    verdict: Literal["pass", "fail", "indeterminate"]
    checks: list[ComparisonPolicyCheck]


class ComparisonPolicyReceipt(ComparisonPolicyReport):
    comparisonId: str
    reportedBy: str
    receivedAt: str


class ComparisonPolicyReceipts(TypedDict):
    items: list[ComparisonPolicyReceipt]


class EvaluationRights(TypedDict):
    read: bool
    evaluate: bool
    write: bool
    propose: bool
    promote: bool


class EvaluationAbandonmentPolicy(TypedDict):
    explicit: bool
    inactivitySeconds: int


class EvaluationCapabilities(TypedDict):
    schemaVersion: Literal[1]
    projectId: str
    principalId: str
    checkedAt: str
    readUnpublished: Literal[True]
    writeEvaluation: bool
    retainedEvaluationOperations: Literal[True]
    rights: NotRequired[EvaluationRights]
    credential: NotRequired[dict[str, str]]
    abandonment: NotRequired[EvaluationAbandonmentPolicy]


class EvaluationProgressRequest(TypedDict):
    attemptId: str
    sequence: int
    phase: Literal["preparing", "executing", "grading", "submitting"]
    completed: int
    total: int
    case: NotRequired[CaseKey]


class EvaluationProgressObservation(EvaluationProgressRequest):
    receivedAt: str
    evaluatorPrincipal: str


class EvaluationProgressView(TypedDict):
    schemaVersion: Literal[1]
    requestId: str
    status: Literal["requested", "running", "completed", "failed", "interrupted"]
    attemptId: str | None
    observation: EvaluationProgressObservation | None
    activity: Literal["fresh", "stale", "absent"]
    checkedAt: str
    staleAfterSeconds: Literal[60]


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


class Draft(TypedDict):
    id: str
    channel: str
    baseVersionId: str
    baseRevision: str
    snapshotVersion: VersionMetadata
    generation: int
    status: Literal["open", "discarded", "published"]
    createdAt: str
    updatedAt: str
    promotionId: str | None


class CreateDraftRequest(TypedDict):
    baseVersionId: str
    baseRevision: str
    payload: BundlePayload


class SaveDraftRequest(TypedDict):
    expectedGeneration: int
    payload: BundlePayload


class DiscardDraftRequest(TypedDict):
    expectedGeneration: int


class PublishDraftRequest(TypedDict):
    expectedGeneration: int
    expectedRevision: str
    comparisonId: NotRequired[str]
    unevaluatedReason: NotRequired[str]
    policyOverride: NotRequired[PolicyOverride]


class DraftSnapshot(TypedDict):
    generation: int
    version: VersionMetadata


class DraftPage(TypedDict):
    items: list[Draft]
    nextCursor: str | None


class DraftSnapshotPage(TypedDict):
    items: list[DraftSnapshot]
    nextCursor: str | None


class OperationCommitted(TypedDict):
    status: Literal["committed"]
    operationId: str
    path: str
    requestFingerprint: NotRequired[str]
    result: Draft | Evaluation | Comparison | Release | Proposal | dict


class OperationNotObserved(TypedDict):
    status: Literal["not_observed"]
    operationId: str


class OperationClosed(TypedDict):
    status: Literal["closed"]
    operationId: str
    path: NotRequired[str]


Operation = OperationCommitted | OperationNotObserved | OperationClosed

# Deprecated. Use Release.
Promotion = Release
# Deprecated. Use ReleasePage.
PromotionPage = ReleasePage
# Deprecated. Use CreateReleaseRequest.
PromoteRequest = CreateReleaseRequest
# Deprecated. Use ConnectionObservation.
IntegrationObservation = ConnectionObservation
# Deprecated. Use ConnectionLatestObservation.
IntegrationLatestObservation = ConnectionLatestObservation
# Deprecated. Use ConnectionObservationPage.
IntegrationObservationPage = ConnectionObservationPage

# Deprecated. Use VerifiedVersion.
VerifiedBundle = VerifiedVersion
