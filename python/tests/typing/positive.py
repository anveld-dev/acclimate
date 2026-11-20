"""Consumer of every root domain export and public evaluator annotations."""
from typing import Literal, assert_type

from acclimate import (
    Acclimate,
    AcclimateClient,
    Job,
    LearningEvolveCasesPage,
    LearningJson,
    LearningOutcomeReceipt,
    ApiError,
    TransportError,
    DeliveryError,
    PreparedFiles,
    PreparedDelivery,
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
    CreateReleaseRequest,
    Release,
    ReleasePage,
    VerifiedVersion,
    VerifiedVersionConnection,
    ConnectionLatestObservation,
    ConnectionObservation,
    ConnectionObservationPage,
    OperationCommitted,
    OperationNotObserved,
    OperationClosed,
    Operation,
    Page,
    Workspace,
    Channel,
    BundleSetup,
    BundleSetupRequest,
    Connection,
)
from acclimate.learning import LoopDefinition, define_loop, exact
from acclimate.evaluation import (
    Case, EvaluationApp, ExecuteInput, ExecutionResult, GradeInput, GradeResult,
    define_evaluation, preflight_evaluation,
)
def release(client: AcclimateClient, request: CreateReleaseRequest) -> None:
    assert_type(client.create_release("p", "b", "stable", request, "key"), Release)


def delivery(client: AcclimateClient, api_error: ApiError) -> None:
    with client.prepare("p", "b", channel="stable") as job:
        assert_type(job, PreparedDelivery)
        assert_type(job.version, VerifiedVersion)
        assert_type(job.version["version"], VersionMetadata)
        assert_type(job.instructions, str)
    assert_type(api_error.status, int)
    version = resolve_and_cache(client, "workspace", "bundle", channel="stable", cache_dir="/private/cache")
    assert_type(version, VerifiedVersion)
    assert_type(version["payload"], BundlePayload)
    assert_type(prepare_files(version, "/private/workspace"), PreparedFiles)
    validate_payload(version["payload"])
    stale = resolve_and_cache(client, "workspace", "bundle", channel="stable", cache_dir="/private/cache",
                              offline={"max_age_ms": 300_000})
    assert_type(stale["stale"], bool)
    connection = version.get("connection")
    if connection is not None:
        assert_type(connection, VerifiedVersionConnection)
        assert_type(connection["workspaceId"], str)
        assert_type(connection["connectionId"], str)
    pinned = client.prepare("p", "b", version_id="v", offline={"pinned_version_id": "v"})
    pinned.cleanup()
    assert_type(api_error.request_id, str)


def listings(client: AcclimateClient, setup: BundleSetupRequest) -> None:
    workspaces = client.list_workspaces(limit=10)
    assert_type(workspaces, Page[Workspace])
    assert_type(workspaces["nextCursor"], str | None)
    assert_type(client.list_channels("p", "b")["items"], list[Channel])
    assert_type(client.list_connections("p")["items"], list[Connection])
    assert_type(client.create_bundle_setup("p", setup, "key"), BundleSetup)


def execute(run: ExecuteInput[dict[str, str]]) -> ExecutionResult[dict[str, str]]:
    assert_type(run.version, VerifiedVersion)
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


def typed_results(bundle_id: str) -> None:
    preflight = preflight_evaluation(app=app, config_path="/private/evaluator.json", target={"bundleId": bundle_id})
    assert_type(preflight["status"], Literal["ready", "blocked"])
    assert_type(app.execution, Literal["model-free", "live"])


def helpers(run: ExecuteInput[dict[str, str]]) -> ExecutionResult[dict[str, str]]:
    assert_type(run.instructions, str)
    assert_type(run.skill_files, tuple[BundleFile, ...])
    return ExecutionResult({"queue": run.instructions}, usage={"inputTokens": 3, "costUsd": 0.01})


def learning(client: AcclimateClient, input: LearningJson) -> None:
    assert_type(client.list_learning_evolve_cases("w", "b"), LearningEvolveCasesPage)
    job = Acclimate.from_env().job("support", channel="stable", input=input)
    assert_type(job, Job)
    assert_type(job.version, VerifiedVersion)
    assert_type(job.outcome_id, str)
    assert_type(job.prepare(), PreparedDelivery)
    assert_type(job.expect({"action": "refund"}), LearningOutcomeReceipt)


def learning_execute(version: VerifiedVersion, input: LearningJson, rollout: int) -> LearningJson:
    return input


assert_type(define_loop(
    bundle="support", channel="stable", execute=learning_execute, policy_model="model",
    cases="cases.jsonl", grade=exact(),
), LoopDefinition)
