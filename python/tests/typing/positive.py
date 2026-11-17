"""Consumer of every root domain export and public evaluator annotations."""
from typing import assert_type

from acclimate import (
    AcclimateClient,
    ApiError,
    TransportError,
    DeliveryError,
    PreparedFiles,
    prepare_files,
    resolve_and_cache,
    validate_payload,
    DeliveryReporter,
    BoundDeliveryReporter,
    FileKind,
    CompatibilityTarget,
    BundleFile,
    BundlePayload,
    CreateBundleRequest,
    Bundle,
    VersionMetadata,
    ChannelResolution,
    CreateVersionRequest,
    PromoteRequest,
    Promotion,
    PromotionPage,
    ProposalRequest,
    Proposal,
    CaseKey,
    Usage,
    Outcome,
    CasePair,
    EvaluationBinding,
    ComparisonRequest,
    Comparison,
    VerifiedBundle,
    EvaluationDescriptor,
    EvaluationHandoff,
    EvaluationRequest,
    Evaluation,
    EvaluationPage,
    StartEvaluationRequest,
    FinishEvaluationRequest,
    InterruptEvaluationRequest,
    EvaluationCapabilities,
    EvaluationProgressRequest,
    EvaluationProgressObservation,
    EvaluationProgressView,
    EvaluationProgressReporter,
    IntegrationLatestObservation,
    IntegrationObservation,
    IntegrationObservationPage,
    Draft,
    CreateDraftRequest,
    SaveDraftRequest,
    DiscardDraftRequest,
    PublishDraftRequest,
    DraftSnapshot,
    DraftPage,
    DraftSnapshotPage,
    OperationCommitted,
    OperationNotObserved,
    OperationClosed,
    Operation,
)
from acclimate.evaluation import (
    Case, EvaluationApp, ExecuteInput, ExecutionResult, GradeInput, GradeResult,
    define_evaluation,
)
from acclimate.evaluation_analysis import (
    AnalysisComparisonBinding, AnalysisMetric, ComponentObservation,
    ComparisonAnalysis, PairedUncertainty, analyze_comparison,
)


def analysis(comparison: Comparison, descriptor: EvaluationDescriptor,
             metrics: list[AnalysisMetric], observations: list[ComponentObservation],
             uncertainty: PairedUncertainty) -> ComparisonAnalysis:
    binding: AnalysisComparisonBinding = {
        "parentVersionId": "parent", "candidateVersionId": "candidate",
        "parentDigest": "sha256:parent", "candidateDigest": "sha256:candidate",
        "requestId": "request", "attemptId": "attempt", "comparisonId": "comparison",
    }
    result = analyze_comparison(
        comparison=comparison, expected_descriptor=descriptor, expected_binding=binding,
        metrics=metrics, observations=observations, uncertainty=uncertainty,
    )
    assert_type(result, ComparisonAnalysis)
    assert_type(result["expectedBinding"]["comparisonId"], str)
    return result


def lifecycle(client: AcclimateClient, evaluation: Evaluation) -> None:
    start: StartEvaluationRequest = {"attemptId": "attempt"}
    finish: FinishEvaluationRequest = {"attemptId": "attempt", "comparisonId": "comparison"}
    interrupt: InterruptEvaluationRequest = {"reason": "operator requested"}
    evaluation["status"] = "completed"
    assert_type(client.start_evaluation("p", "b", "r", start, "key"), Evaluation)
    assert_type(client.finish_evaluation("p", "b", "r", finish, "key"), Evaluation)
    assert_type(client.interrupt_evaluation("p", "b", "r", interrupt, "key"), Evaluation)
    assert_type(client.get_evaluation("p", "b", "r"), Evaluation)
    assert_type(client.list_evaluations("p", "b"), EvaluationPage)
    assert_type(client.get_evaluation_capabilities("p"), EvaluationCapabilities)


def delivery(client: AcclimateClient, api_error: ApiError) -> None:
    assert_type(api_error.status, int)
    bundle = resolve_and_cache(client, "project", "bundle", channel="stable", cache_dir="/private/cache")
    assert_type(bundle, VerifiedBundle)
    assert_type(bundle["payload"], BundlePayload)
    assert_type(prepare_files(bundle, "/private/workspace"), PreparedFiles)
    validate_payload(bundle["payload"])


def execute(run: ExecuteInput[dict[str, str]]) -> ExecutionResult[dict[str, str]]:
    assert_type(run.bundle, VerifiedBundle)
    return ExecutionResult({"queue": run.input["category"]})


def grade(run: GradeInput[dict[str, str], dict[str, str]]) -> GradeResult:
    assert_type(run.output, dict[str, str])
    assert_type(run.expected, dict[str, str])
    return GradeResult(float(run.output == run.expected))


app = define_evaluation(
    config_id="typing", config_revision="1", dataset_revision="1", grader_revision="1",
    runtime={"model": "none"}, execution="model-free",
    cases=[Case("case", {"category": "billing"}, {"queue": "billing"})],
    execute=execute, grade=grade,
)
assert_type(app, EvaluationApp[dict[str, str], dict[str, str], dict[str, str]])
