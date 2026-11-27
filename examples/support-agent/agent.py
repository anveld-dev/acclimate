"""Answer one support request with the released bundle.

    python examples/support-agent/agent.py "I was charged twice this month."
"""

import argparse
import json
import os
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from acclimate import Acclimate, system_prompt


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
    args = parser.parse_args()

    # Reads ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN.
    acclimate = Acclimate.from_env()

    # Pin the released version for this job. Every job re-reads the channel, so a release made by
    # the learning loop reaches the next job without a deploy.
    job = acclimate.job(
        os.environ.get("ACCLIMATE_BUNDLE_NAME", "Example agent"),
        channel=os.environ.get("ACCLIMATE_CHANNEL", "stable"),
    )
    version = job.version
    # Send the bundle as the learning loop does, so the loop scores the prompt this job runs with.
    reply = complete(system_prompt(version["payload"]), args.request)
    print(reply, flush=True)
    # Keep the version with the result, so you can tell later which instructions produced it.
    print(f"\nAnswered with version {version['version']['id']} ({version['version']['digest']}).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
