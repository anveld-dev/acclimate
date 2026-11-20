"""Test-only application installed next to the distributed evaluator entry point."""
import hashlib
import inspect
from pathlib import Path

from acclimate.evaluation import ExecutionResult, GradeResult
from agent import run_existing_agent

config_id = "installed-qualification-worker"
runtime = {
    "settings": {"app": "payment-retry-qualification"},
    "artifacts": {"app": "sha256:" + hashlib.sha256(Path(__file__).with_name("agent.py").read_bytes()).hexdigest()},
}

def execute(run):
    with Path(__file__).with_name("executions.log").open("a") as count:
        count.write("executed\n")
    output = run_existing_agent(version=run.version, task=run.input, cancellation=run.cancellation)
    return ExecutionResult(output=output, usage={"costUsd": 0})

def grade(run):
    single_charge = run.output["charges"] == run.expected["charges"]
    succeeded = run.output["succeeded"] == run.expected["succeeded"]
    return GradeResult(reward=float(single_charge and succeeded),
                       explanation={"singleCharge": single_charge, "succeeded": succeeded})

grader = {"sourceUtf8": inspect.getsource(grade)}
