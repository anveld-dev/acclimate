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
    runName: NotRequired[str]
    retryOf: NotRequired[str]


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
    runLabels: NotRequired[Literal[True]]


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
    projectId: str
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
    integrationId: str
    projectId: str
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


class LearningEvaluationDescriptor(EvaluationDescriptor):
    fixtureProtocol: NotRequired[Literal["installed-v1"]]
    datasetDigest: NotRequired[str]
    caseFingerprints: NotRequired[list[str]]
    familyFingerprints: NotRequired[list[str]]


class LearningSelectionPolicies(TypedDict):
    development: dict[str, Any]
    audit: dict[str, Any]


class LearningSkillPackages(TypedDict):
    createSkillNames: list[str]
    retireSkillNames: list[str]


class LearningEnrollmentRequest(TypedDict):
    installationId: str
    permittedPaths: list[str]
    maxProposalAdmissions: int
    development: LearningEvaluationDescriptor
    audits: list[LearningEvaluationDescriptor]
    automaticRollout: bool
    outcomePrincipal: str
    evaluatorPrincipal: str
    selectionPolicies: NotRequired[LearningSelectionPolicies]
    skillPackages: NotRequired[LearningSkillPackages]
    maxCorrectionsPerRound: NotRequired[int]
    expectedAutomaticRollout: NotRequired[bool]
    automaticRollback: NotRequired[bool]


class LearningEnrollment(TypedDict):
    projectId: str
    integrationId: str
    bundleId: str
    channel: str
    installationId: str
    permittedPaths: list[str]
    maxProposalAdmissions: int
    development: LearningEvaluationDescriptor
    automaticRollout: bool
    automaticRollback: bool
    outcomePrincipal: str
    evaluatorPrincipal: str
    auditCount: int
    authorizedBy: str
    proposalAdmissions: int
    renewalRevision: int
    stoppedAt: str | None
    enabled: bool
    audits: NotRequired[list[LearningEvaluationDescriptor]]
    selectionPolicies: NotRequired[LearningSelectionPolicies]
    skillPackages: NotRequired[LearningSkillPackages]
    maxCorrectionsPerRound: NotRequired[int]
    policyEpoch: NotRequired[int]


class LearningRestoreTarget(TypedDict):
    kind: Literal["delivery", "source"]
    revision: str
    versionId: str


class LearningEnrollmentStatus(LearningEnrollment):
    """Enrollment plus recent rounds. Round, calibration and history entries follow the OpenAPI schema."""

    rounds: list[dict[str, Any]]
    remainingAudits: int
    deliveredVersionId: str
    deliveredRevision: str
    developmentIncumbent: NotRequired[dict[str, Any]]
    policyHistory: NotRequired[list[dict[str, Any]]]
    noiseCalibration: NotRequired[dict[str, Any]]
    restoreTargets: NotRequired[list[LearningRestoreTarget]]


class LearningRestoreRequest(TypedDict):
    restoreId: str
    expectedRevision: str
    target: LearningRestoreTarget
    reason: str


class LearningReviewReceipt(TypedDict):
    roundId: str
    state: Literal["promoted", "rejected"]
    promotionId: NotRequired[str]


class LearningRenewalRequest(TypedDict):
    renewalId: str
    expectedRevision: int
    proposalAdmissions: int
    audits: list[LearningEvaluationDescriptor]
    development: NotRequired[LearningEvaluationDescriptor]
    selectionPolicies: NotRequired[LearningSelectionPolicies]


class LearningRenewalReceipt(LearningEnrollment):
    appliedRenewalRevision: int


class LearningLesson(TypedDict):
    path: str
    instruction: str


class LearningFeedback(TypedDict):
    expected: str
    observed: str


LearningReplayVerdict = Literal["pass", "regression", "unavailable"]


class LearningIncidentReplay(TypedDict):
    roundId: str
    outcomeId: str
    versionId: str
    digest: str
    baselineRevision: str
    verdict: LearningReplayVerdict
    attempts: NotRequired[list[LearningReplayVerdict]]


class LearningOutcomeStatus(TypedDict):
    """Outcome state and its corrections. Release lineage fields follow the OpenAPI schema."""

    outcomeId: str
    status: Literal["completed", "failed"]
    versionId: str
    deliveryRevision: str | None
    receivedAt: str
    corrections: list[dict[str, Any]]
    bundleId: NotRequired[str]
    channel: NotRequired[str]
    currentDelivery: NotRequired[dict[str, str]]
    servedRelease: NotRequired[dict[str, Any] | None]
    fieldAudit: NotRequired[dict[str, Any] | None]


class LearningOutcomeRequest(TypedDict):
    outcomeId: str
    versionId: str
    digest: str
    status: Literal["completed", "failed"]
    requireIncidentReplay: NotRequired[bool]
    startedReceiptId: NotRequired[str]
    deliveryRevision: NotRequired[str]
    lesson: NotRequired[LearningLesson]
    feedback: NotRequired[LearningFeedback]


class LearningCorrectionRequest(TypedDict):
    correctionId: str
    outcomeId: str
    requireIncidentReplay: NotRequired[bool]
    lesson: NotRequired[LearningLesson]
    feedback: NotRequired[LearningFeedback]


class LearningCorrectionReceipt(TypedDict):
    correctionId: str
    outcomeId: str
    accepted: Literal[True]


class LearningRecheck(LearningCorrectionRequest):
    versionId: str
    digest: str
    revision: str


LearningRecheckVerdict = Literal["reproduced", "resolved", "unavailable"]


class LearningRecheckRequest(TypedDict):
    correctionId: str
    versionId: str
    digest: str
    revision: str
    verdict: LearningRecheckVerdict


class LearningRecheckReceipt(TypedDict):
    correctionId: str
    revision: str
    verdict: LearningRecheckVerdict
    accepted: Literal[True]


class LearningOutcomeReceipt(TypedDict):
    outcomeId: str
    accepted: Literal[True]
    eligible: bool
    fieldAudit: NotRequired[dict[str, str]]


class LearningFieldAuditRequest(TypedDict):
    outcomeId: str
    startedReceiptId: str
    versionId: str
    digest: str
    revision: str
    parentVersionId: str
    parentDigest: str
    verdict: Literal["pass", "regression", "win", "loss", "tie"]


class LearningFieldRequalification(TypedDict):
    versionId: str
    digest: str
    baselineRevision: str
    pendingOutcomeIds: list[str]
    failedOutcomeIds: list[str]


class LearningFieldReplay(TypedDict):
    versionId: str
    digest: str
    baselineRevision: str
    outcomeId: str
    verdict: Literal["pass", "regression"]
    attempts: NotRequired[list[Literal["pass", "regression"]]]


class LearningFieldAuditReceipt(TypedDict):
    outcomeId: str
    accepted: Literal[True]
    regressions: int
    windowSize: int
    wins: NotRequired[int]
    rollbackPromotionId: NotRequired[str]


class LearningAccepted(TypedDict):
    accepted: Literal[True]


class LearningWork(TypedDict):
    """Assigned evaluations and replays. Item shapes follow the OpenAPI schema."""

    installationId: str
    bundleId: str
    active: bool
    items: list[dict[str, Any]]
    incidentReplays: NotRequired[list[dict[str, Any]]]
    fieldReplays: NotRequired[list[dict[str, Any]]]
    rechecks: NotRequired[list[LearningRecheck]]



class OperationCommitted(TypedDict):
    status: Literal["committed"]
    operationId: str
    path: str
    requestFingerprint: NotRequired[str]
    result: Draft | BundleSetup | Evaluation | Comparison | Release | Proposal | VersionMetadata | dict


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

__all__ = [
    "FileKind",
    "CompatibilityTarget",
    "BundleFile",
    "BundlePayload",
    "CreateBundleRequest",
    "Bundle",
    "VersionMetadata",
    "ChannelResolution",
    "CreateVersionRequest",
    "PolicyReceiptReference",
    "PolicyOverride",
    "CreateReleaseRequest",
    "Release",
    "ReleasePage",
    "ProposalRequest",
    "CriticVerdict",
    "ProposalChange",
    "ProposalScreen",
    "Proposal",
    "CaseKey",
    "Usage",
    "Outcome",
    "CasePair",
    "EvaluationBinding",
    "ComparisonRequest",
    "Comparison",
    "VerifiedVersion",
    "EvaluationDescriptor",
    "EvaluationHandoff",
    "EvaluationRequest",
    "Evaluation",
    "EvaluationPage",
    "StartEvaluationRequest",
    "FinishEvaluationRequest",
    "InterruptEvaluationRequest",
    "AbandonEvaluationRequest",
    "ComparisonPolicyIdentity",
    "ComparisonPolicyCheck",
    "ComparisonPolicyReport",
    "ComparisonPolicyReceipt",
    "ComparisonPolicyReceipts",
    "EvaluationCapabilities",
    "EvaluationRights",
    "EvaluationAbandonmentPolicy",
    "EvaluationProgressRequest",
    "EvaluationProgressObservation",
    "EvaluationProgressView",
    "ConnectionLatestObservation",
    "ConnectionObservation",
    "ConnectionObservationPage",
    "Draft",
    "CreateDraftRequest",
    "SaveDraftRequest",
    "DiscardDraftRequest",
    "PublishDraftRequest",
    "DraftSnapshot",
    "DraftPage",
    "DraftSnapshotPage",
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
    "LearningEvaluationDescriptor",
    "LearningSelectionPolicies",
    "LearningSkillPackages",
    "LearningEnrollmentRequest",
    "LearningEnrollment",
    "LearningRestoreTarget",
    "LearningEnrollmentStatus",
    "LearningRestoreRequest",
    "LearningReviewReceipt",
    "LearningRenewalRequest",
    "LearningRenewalReceipt",
    "LearningLesson",
    "LearningFeedback",
    "LearningReplayVerdict",
    "LearningIncidentReplay",
    "LearningOutcomeStatus",
    "LearningOutcomeRequest",
    "LearningCorrectionRequest",
    "LearningCorrectionReceipt",
    "LearningRecheck",
    "LearningRecheckVerdict",
    "LearningRecheckRequest",
    "LearningRecheckReceipt",
    "LearningOutcomeReceipt",
    "LearningFieldAuditRequest",
    "LearningFieldRequalification",
    "LearningFieldReplay",
    "LearningFieldAuditReceipt",
    "LearningAccepted",
    "LearningWork",
    "OperationCommitted",
    "OperationNotObserved",
    "OperationClosed",
    "Operation",
    "Promotion",
    "PromotionPage",
    "PromoteRequest",
    "IntegrationObservation",
    "IntegrationLatestObservation",
    "IntegrationObservationPage",
    "VerifiedBundle",
]
