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
    compatibilityTarget: NotRequired[CompatibilityTarget]
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


class PromoteRequest(TypedDict):
    versionId: str
    expectedRevision: str
    comparisonId: NotRequired[str]
    unevaluatedReason: NotRequired[str]


class Promotion(TypedDict):
    id: str
    channel: str
    revision: str
    version: VersionMetadata
    previousVersionId: str | None
    comparisonId: str | None
    unevaluatedReason: str | None
    reviewer: str
    createdAt: str


class PromotionPage(TypedDict):
    items: list[Promotion]
    nextBeforeRevision: str | None


class ProposalRequest(TypedDict):
    parentVersionId: str
    allowedPaths: list[str]
    hypothesis: str
    evidence: list[str]


class Proposal(TypedDict):
    id: str
    parentVersionId: str
    status: Literal["queued", "running", "succeeded", "failed"]
    attempts: int
    candidate: VersionMetadata | None
    rationale: str | None
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


class VerifiedBundle(TypedDict):
    version: VersionMetadata
    payload: BundlePayload
    resolution: NotRequired[ChannelResolution]
    resolvedAt: float
    stale: bool
