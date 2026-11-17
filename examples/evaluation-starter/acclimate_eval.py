"""Application-owned entry point; requests never select an executable or callback."""
import sys
from acclimate.evaluation import Case, ExecutionResult, GradeResult, define_evaluation
from acclimate.evaluation_cli import evaluation_main
from agent import run_existing_agent


def execute(run):
    return ExecutionResult(
        output=run_existing_agent(bundle=run.bundle, task=run.input, cancellation=run.cancellation),
        usage={"inputTokens": 0, "outputTokens": 0, "costUsd": 0},
    )


def grade(run):
    output, expected = run.output, run.expected
    return GradeResult(
        reward=float(output["charges"] == expected["charges"] and output["succeeded"] == expected["succeeded"]),
        explanation={"singleCharge": output["charges"] == 1, "succeeded": output["succeeded"] is True},
    )


app = define_evaluation(
    config_id="installed-payment-starter", config_revision="1",
    dataset_revision="payment-response-fixtures-1", grader_revision="single-charge-result-1",
    runtime={"app": "payment-starter-1", "model": "none", "writes": "in-memory-only"},
    execution="model-free",
    cases=[
        Case(case_id="lost-response", input={"scenario": "lost-response"}, expected={"charges": 1, "succeeded": True}),
        Case(case_id="clean", input={"scenario": "clean"}, expected={"charges": 1, "succeeded": True}),
    ],
    execute=execute, grade=grade,
)


def to_review_artifact(item):
    value = item["value"]
    if item["identity"]["role"] == "output":
        value = {"charges": value["charges"], "succeeded": value["succeeded"]}
    else:
        value = {"singleCharge": value["singleCharge"], "succeeded": value["succeeded"]}
    return {"mediaType": "application/json", "value": value}


if __name__ == "__main__":
    sys.exit(evaluation_main(app, sys.argv[1:], review={"to_review_artifact": to_review_artifact}))
