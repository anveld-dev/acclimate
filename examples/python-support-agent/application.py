"""Evaluation adapter for the support agent.

``python -m acclimate`` loads this module from the current directory. It needs
three exports: the saved ``cases``, an ``execute`` callback that runs the agent
with one version's instructions, and an independent ``grade`` callback.
"""

import json
from pathlib import Path

from acclimate.evaluation import ExecutionResult, GradeResult

from support_agent import answer, score

HERE = Path(__file__).resolve().parent

# Names this evaluation configuration in the public descriptor.
config_id = "python-support-agent"

# Each case has a public caseId, a private input and a private expected answer.
cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))

# Files read at runtime are part of the build identity. Imported Python modules
# such as support_agent.py are fingerprinted automatically.
revision_files = ["cases.json", "knowledge_base.json"]


def system_prompt(version):
    """Join the instruction files of the version under test into one system prompt."""
    files = version["payload"]["files"]
    return "\n\n".join(item["text"] for item in sorted(files, key=lambda f: f["path"]) if item["kind"] == "instruction")


def execute(run):
    reply = answer(system_prompt(run.version), run.input["question"])
    return ExecutionResult(
        output={"text": reply.text, "citations": list(reply.citations), "escalated": reply.escalated},
        usage={"inputTokens": reply.input_tokens, "outputTokens": reply.output_tokens},
    )


def grade(run):
    reward, checks = score(run.output, run.expected)
    return GradeResult(reward=reward, explanation=checks)
