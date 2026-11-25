"""Answer one support request with the released bundle, and optionally record a correction.

    python examples/support-agent/agent.py "I was charged twice this month."
    python examples/support-agent/agent.py "I was charged twice this month." --expected corrected.txt
"""

import argparse
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from acclimate import Acclimate, ApiError


def system_prompt(payload) -> str:
    """Render the bundle the way the learning executor does.

    Instructions come first, then skills, then memory, each file under a ``# path`` heading.
    Building the prompt the same way means the loop measures the prompt your jobs run with.
    """
    files = [file for kind in ("instruction", "skill", "memory") for file in payload["files"] if file["kind"] == kind]
    return "\n\n".join(f"# {file['path']}\n{file['text']}" for file in files)


def setting(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Set {name}.")
    return value


def complete(system: str, request: str) -> str:
    body = {
        "model": setting("AGENT_MODEL"),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": request}],
    }
    call = Request(
        setting("OPENAI_BASE_URL").rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + setting("OPENAI_API_KEY"), "Content-Type": "application/json"},
    )
    try:
        with urlopen(call, timeout=120) as response:
            return json.load(response)["choices"][0]["message"]["content"]
    except HTTPError as error:
        raise SystemExit(f"The model provider answered {error.code}.") from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("request")
    parser.add_argument("--expected", type=Path, help="a file holding the reply a person corrected")
    args = parser.parse_args()

    # Reads ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN.
    acclimate = Acclimate.from_env()

    # Pin the released version for this job. Every job re-reads the channel, so a release made by
    # the learning loop reaches the next job without a deploy.
    job = acclimate.job(
        os.environ.get("ACCLIMATE_BUNDLE_NAME", "Example agent"),
        channel=os.environ.get("ACCLIMATE_CHANNEL", "stable"),
        input=args.request,
    )
    version = job.version
    reply = complete(system_prompt(version["payload"]), args.request)
    print(reply, flush=True)
    # Keep the version with the result, so you can tell later which instructions produced it.
    print(f"\nAnswered with version {version['version']['id']} ({version['version']['digest']}).", file=sys.stderr)

    if args.expected:
        # A person corrected the reply. Report what it should have been. The request becomes a
        # learning task, graded against criteria the judge model drafts from the corrected reply.
        expected = args.expected.read_text(encoding="utf-8").strip()
        try:
            receipt = job.expect(expected, output=reply, grading="criteria")
        except ApiError as error:
            if error.status == 404:
                raise SystemExit("Learning is not set up for this bundle. Save its settings on the Learning tab first.") from None
            raise
        # The service chooses the split. A held-out task waits for a person to confirm its criteria.
        split = "an evolve task" if receipt.get("taskId") else "a held-out task, to confirm on the Learning tab"
        print(f"Recorded the correction as outcome {job.outcome_id}. It becomes {split}.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
