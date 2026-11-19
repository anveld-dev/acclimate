"""Copy this file to application.py and connect it to your agent.

``python -m acclimate`` loads application.py from the current directory. It
needs three exports: ``cases``, ``execute`` and ``grade``.
"""

from acclimate.evaluation import ExecutionResult, GradeResult

# Replace these imports with your own agent, scorer and saved cases.
from support_agent import run_agent, saved_cases, score_result

# Each case: {"caseId": "...", "input": ..., "expected": ..., "repetitions": 1}.
# Only the grader sees "expected".
cases = saved_cases

# Files your agent reads at runtime, relative to this module. Imported Python
# modules are fingerprinted automatically.
revision_files = ["requirements.lock"]


def execute(run):
    # run.bundle["payload"]["files"] holds the instructions, skills and memory of
    # the version under test. Decide how they reach your agent.
    result = run_agent(bundle=run.bundle, task=run.input, cancellation=run.cancellation)
    return ExecutionResult(output=result.answer, usage=result.measured_usage)


def grade(run):
    verdict = score_result(run.output, run.expected)
    return GradeResult(reward=verdict.reward, explanation=verdict.explanation)
