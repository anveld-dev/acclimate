"""These application mistakes must remain static errors; never execute this file."""
from acclimate import AcclimateClient, Evaluation, FinishEvaluationRequest, StartEvaluationRequest
from acclimate.evaluation import (
    Case, EvaluationApp, EvaluationError, ExecuteInput, ExecutionResult, GradeInput, GradeResult, define_evaluation,
)
from acclimate.evaluation_analysis import AnalysisComparisonBinding

missing_analysis_comparison: AnalysisComparisonBinding = {  # reject: typeddict-item
    "parentVersionId": "parent", "candidateVersionId": "candidate",
    "parentDigest": "sha256:parent", "candidateDigest": "sha256:candidate",
    "requestId": "request", "attemptId": "attempt",
}

bad_start: StartEvaluationRequest = {"attempt_id": "attempt"}  # reject: typeddict-unknown-key,typeddict-item
bad_finish: FinishEvaluationRequest = {"attemptId": "attempt"}  # reject: typeddict-item


def invalid_status(evaluation: Evaluation) -> None:
    evaluation["status"] = "sealed"  # reject: typeddict-item


def execute(run: ExecuteInput[dict[str, str]]) -> ExecutionResult[dict[str, str]]:
    return ExecutionResult({"queue": run.input["category"]})


def bad_execute(run: ExecuteInput[dict[str, str]]) -> str:
    return "invalid execution result"


def grade(run: GradeInput[dict[str, str], dict[str, str]]) -> GradeResult:
    return GradeResult(float(run.output == run.expected))


def bad_grade(run: GradeInput[dict[str, str], dict[str, str]]) -> str:
    return "invalid grading result"


bad_grader_app: EvaluationApp[dict[str, str], dict[str, str], dict[str, str]] = define_evaluation(
    config_id="typing", config_revision="1", dataset_revision="1", grader_revision="1",
    runtime={"model": "none"}, execution="model-free",
    cases=[Case("case", {"category": "billing"}, {"queue": "billing"})],
    execute=execute, grade=bad_grade,  # reject: arg-type
)

bad_executor_app: EvaluationApp[dict[str, str], dict[str, str], dict[str, str]] = define_evaluation(
    config_id="typing", config_revision="1", dataset_revision="1", grader_revision="1",
    runtime={"model": "none"}, execution="model-free",
    cases=[Case("case", {"category": "billing"}, {"queue": "billing"})],
    execute=bad_execute, grade=grade,  # reject: arg-type
)


# Execution status, usage keys, execution mode and error codes are closed sets.
done_status = ExecutionResult({"queue": "billing"}, execution_status="done")  # reject: arg-type
snake_usage = ExecutionResult({"queue": "billing"}, usage={"input_tokens": 3})  # reject: arg-type
typo_mode: EvaluationApp[dict[str, str], dict[str, str], dict[str, str]] = define_evaluation(
    config_id="typing", config_revision="1", dataset_revision="1", grader_revision="1",
    runtime={"model": "none"}, execution="modelfree",  # reject: arg-type
    cases=[Case("case", {"category": "billing"}, {"queue": "billing"})],
    execute=execute, grade=grade,
)
typo_code = EvaluationError("config.schmea")  # reject: arg-type
def legacy_offline_option(client: AcclimateClient) -> None:
    client.prepare("p", "b", channel="stable", offline_max_age=60)  # reject: call-arg


# The client option renamed in 0.2.0 is gone, not aliased.
def renamed_connection_option() -> AcclimateClient:
    return AcclimateClient("https://acclimate.example", "token", "app", integration_id="c")  # reject: call-arg
