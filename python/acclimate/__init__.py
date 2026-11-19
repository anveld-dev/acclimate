"""Public SDK imports, explicitly re-exported for strict PEP 561 consumers."""

from .client import (
    AcclimateClient as AcclimateClient,
    ApiError as ApiError,
    TransportError as TransportError,
)
from .delivery import (
    DeliveryError as DeliveryError,
    PreparedFiles as PreparedFiles,
    PreparedDelivery as PreparedDelivery,
    prepare_files as prepare_files,
    resolve_and_cache as resolve_and_cache,
    validate_payload as validate_payload,
)

# Retain the historical wildcard runtime surface, including typing helpers.
# Explicit aliases below make domain types visible with no_implicit_reexport.
from .types import *
from .types import (
    FileKind as FileKind,
    CompatibilityTarget as CompatibilityTarget,
    BundleFile as BundleFile,
    BundlePayload as BundlePayload,
    CreateBundleRequest as CreateBundleRequest,
    Bundle as Bundle,
    VersionMetadata as VersionMetadata,
    ChannelResolution as ChannelResolution,
    CreateVersionRequest as CreateVersionRequest,
    CreateReleaseRequest as CreateReleaseRequest,
    PolicyOverride as PolicyOverride,
    PolicyReceiptReference as PolicyReceiptReference,
    Release as Release,
    ReleasePage as ReleasePage,
    ProposalRequest as ProposalRequest,
    Proposal as Proposal,
    CaseKey as CaseKey,
    Usage as Usage,
    Outcome as Outcome,
    CasePair as CasePair,
    EvaluationBinding as EvaluationBinding,
    ComparisonRequest as ComparisonRequest,
    Comparison as Comparison,
    VerifiedVersion as VerifiedVersion,
    EvaluationDescriptor as EvaluationDescriptor,
    EvaluationHandoff as EvaluationHandoff,
    EvaluationRequest as EvaluationRequest,
    Evaluation as Evaluation,
    EvaluationPage as EvaluationPage,
    StartEvaluationRequest as StartEvaluationRequest,
    FinishEvaluationRequest as FinishEvaluationRequest,
    AbandonEvaluationRequest as AbandonEvaluationRequest,
    InterruptEvaluationRequest as InterruptEvaluationRequest,
    ComparisonPolicyIdentity as ComparisonPolicyIdentity,
    ComparisonPolicyCheck as ComparisonPolicyCheck,
    ComparisonPolicyReport as ComparisonPolicyReport,
    ComparisonPolicyReceipt as ComparisonPolicyReceipt,
    ComparisonPolicyReceipts as ComparisonPolicyReceipts,
    EvaluationAbandonmentPolicy as EvaluationAbandonmentPolicy,
    EvaluationCapabilities as EvaluationCapabilities,
    EvaluationRights as EvaluationRights,
    ConnectionLatestObservation as ConnectionLatestObservation,
    ConnectionObservation as ConnectionObservation,
    ConnectionObservationPage as ConnectionObservationPage,
    Draft as Draft,
    CreateDraftRequest as CreateDraftRequest,
    SaveDraftRequest as SaveDraftRequest,
    DiscardDraftRequest as DiscardDraftRequest,
    PublishDraftRequest as PublishDraftRequest,
    DraftSnapshot as DraftSnapshot,
    DraftPage as DraftPage,
    DraftSnapshotPage as DraftSnapshotPage,
    OperationCommitted as OperationCommitted,
    OperationNotObserved as OperationNotObserved,
    OperationClosed as OperationClosed,
    Operation as Operation,
)

from .receipts import (
    DeliveryReporter as DeliveryReporter,
    BoundDeliveryReporter as BoundDeliveryReporter,
)

from .types import (
    EvaluationProgressRequest as EvaluationProgressRequest,
    EvaluationProgressObservation as EvaluationProgressObservation,
    EvaluationProgressView as EvaluationProgressView,
)
from .evaluation_progress import EvaluationProgressReporter as EvaluationProgressReporter

# Deprecated compatibility exports.
from .types import (
    VerifiedBundle as VerifiedBundle,
    Promotion as Promotion,
    PromotionPage as PromotionPage,
    PromoteRequest as PromoteRequest,
    IntegrationObservation as IntegrationObservation,
    IntegrationLatestObservation as IntegrationLatestObservation,
    IntegrationObservationPage as IntegrationObservationPage,

)
