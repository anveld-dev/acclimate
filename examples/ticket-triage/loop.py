"""Teach a ticket router from 64 labelled tickets, driving the learning loop over the API.

    python examples/ticket-triage/loop.py

Learning runs on the service and its executor. This script sets the loop up, starts it and
prints what happens. Stopping the script does not stop learning.
"""

import os
from pathlib import Path
import time
import uuid

from acclimate import AcclimateClient, ApiError, resolve_and_cache

HERE = Path(__file__).resolve().parent
NAME = os.environ.get("ACCLIMATE_BUNDLE_NAME", "Ticket triage")
CHANNEL = "stable"


def setting(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Set {name}.")
    return value


def payload_from_directory(directory: Path):
    """Files under skills/ are skills, files under memory/ are memory, and the rest are instructions."""
    paths = sorted(
        path.relative_to(directory).as_posix()
        for path in directory.rglob("*")
        if path.is_file() and not path.name.startswith(".")
    )
    files = []
    for path in paths:
        top = path.split("/", 1)[0]
        kind = "skill" if top == "skills" else "memory" if top == "memory" else "instruction"
        files.append({"path": path, "kind": kind, "text": (directory / path).read_text(encoding="utf-8")})
    return {"schemaVersion": 1, "files": files}


def percent(score) -> str:
    return "not scored" if score is None else f"{round(score * 100)}%"


def describe(round_) -> str:
    number, state, reason = round_["number"], round_["state"], round_["reason"]
    ended = "" if state == "completed" else f" The round ended as {state} ({reason})."
    if round_["decision"] == "adopted":
        return (
            f"Round {number} adopted and released version {round_['adoptedVersionId']}. Evolve tasks: "
            f"{percent(round_['incumbentScore'])} before, {percent(round_['evolveScore'])} for the adopted version. "
            f"Held-out tasks: {percent(round_['heldOutScore'])}.{ended}"
        )
    if round_["decision"] == "kept":
        return (
            f"Round {number} kept the current version ({reason}). Evolve tasks: "
            f"{percent(round_['incumbentScore'])}. Held-out tasks: {percent(round_['heldOutScore'])}.{ended}"
        )
    cause = round_.get("failureCause")
    return f"Round {number} {state} ({reason}{': ' + cause['code'] if cause else ''})."


def find_bundle(client: AcclimateClient, workspace: str) -> str | None:
    cursor = None
    while True:
        page = client.list_bundles(workspace, cursor=cursor, limit=100)
        for bundle in page["items"]:
            if bundle["name"] == NAME:
                return bundle["id"]
        cursor = page["nextCursor"]
        if cursor is None:
            return None


def main() -> int:
    workspace = setting("ACCLIMATE_WORKSPACE")
    task_model, judge_model = setting("TASK_MODEL"), setting("JUDGE_MODEL")
    client = AcclimateClient(
        setting("ACCLIMATE_URL"), setting("ACCLIMATE_TOKEN"), os.environ.get("ACCLIMATE_SCOPE", "ticket-triage-example")
    )

    # 1. Publish the starting instructions, unless an earlier run already did.
    bundle = find_bundle(client, workspace)
    if bundle:
        print(f'Using the existing bundle "{NAME}".')
    else:
        setup = client.create_bundle_setup(
            workspace,
            {
                "name": NAME,
                "origin": "created",
                "channel": CHANNEL,
                "payload": payload_from_directory(HERE / "bundle"),
                "reason": "Starting instructions for the ticket triage example",
            },
            str(uuid.uuid4()),
        )
        bundle = setup["bundle"]["id"]
        print(f'Published "{NAME}" and released version {setup["version"]["id"]} on {CHANNEL}.')

    # 2. Learning needs a verified model provider. A signed-in administrator saves it in the console.
    provider = client.get_model_provider(workspace)
    if (provider.get("verification") or {}).get("status") != "verified":
        raise SystemExit("Save a model provider on the workspace Members page and wait until it is verified.")
    for model in (task_model, judge_model):
        if model not in provider["allowedModels"]:
            raise SystemExit(f"Add {model} to the provider's allowed models.")

    # 3. Turn learning on for the channel, unless it already is. Settings changed later in the
    #    console are left alone.
    try:
        loop = client.get_learning_loop(workspace, bundle)
    except ApiError as error:
        if error.status != 404:
            raise
        loop = client.enroll_learning_loop(workspace, bundle, {
            "channel": CHANNEL,
            "setting": {"domain": "support", "benchmark": "ticket-triage"},
            "taskModel": task_model,
            "judgeModel": judge_model,
            "maxRoundsPerDay": 3,
        })

    # 4. Import the tickets. Each row has `input` and a short `expected`, so it becomes an exact-match
    #    task. Importing the same bytes again returns the first import, so a second run adds nothing.
    imported = client.import_learning_tasks(workspace, bundle, (HERE / "tickets.csv").read_bytes(), "text/csv", "tickets.csv")
    while imported["pending"] > 0 and imported.get("status") != "failed":
        time.sleep(2)
        imported = client.get_learning_import(workspace, bundle, imported["importId"])
    if imported.get("status") == "failed":
        raise SystemExit(f"Import failed: {imported.get('message')}")
    print(f"Imported {imported['converted']} of {imported['rows']} rows as tasks.")

    # 5. The executor checks each task before it counts. A machine token lists evolve tasks only,
    #    and gets a count of the held-out tasks that match the filter.
    while True:
        pending = client.list_learning_tasks(workspace, bundle, admission="pending", limit=100)
        waiting = len(pending["items"]) + pending["heldOutCount"]
        if waiting == 0:
            break
        print(f"Checking tasks: {waiting} still pending.")
        time.sleep(10)
    loop = client.get_learning_loop(workspace, bundle)
    print(f"Admitted {loop['admittedEvolve']} evolve tasks and {loop['admittedHeldOut']} held-out tasks.")

    # 6. Start a loop that has never run. The service refuses when a split has fewer than 20 admitted
    #    tasks or it has no optimizer. A loop someone paused or stopped stays that way.
    if loop["status"] != "running" and loop["nextRound"] == 1:
        try:
            loop = client.start_learning_loop(workspace, bundle)
        except ApiError as error:
            if error.status == 409:
                raise SystemExit(f"Start refused: {error}") from None
            raise

    # 7. Report each round as it ends, until the loop waits for something or stops.
    if loop["status"] == "running":
        print("Learning is running. Press Ctrl-C to stop watching. Learning continues on the service.")
    reported = {item["id"] for item in loop["rounds"] if item["endedAt"]}
    stage = ""
    while True:
        loop = client.get_learning_loop(workspace, bundle)
        for item in reversed(loop["rounds"]):
            if not item["endedAt"] or item["id"] in reported:
                continue
            reported.add(item["id"])
            print(describe(item))
        active = loop["activeRound"]
        if active and f"{active['number']} {active['state']}" != stage:
            stage = f"{active['number']} {active['state']}"
            print(f"Round {active['number']}: {active['state'].replace('_', ' ')}")
        if not active and (loop["status"] != "running" or loop["waiting"]):
            break
        time.sleep(15)
    if loop["status"] == "running":
        next_round = f" Next round at {loop['nextRoundAt']}." if loop.get("nextRoundAt") else ""
        print(f"Learning is waiting: {loop['waiting']}.{next_round}")
    else:
        reason = f" ({loop['pauseReason']})." if loop["pauseReason"] else "."
        print(f"Learning is {loop['status']}{reason} Start it again on the Learning tab.")
    if loop["alert"]:
        print(f"The loop raised an alert on round {loop['alert']['roundId']}. Open the Learning tab.")

    # 8. Show what the next job will run with.
    cache = os.environ.get("ACCLIMATE_CACHE") or str(Path.home().resolve() / ".cache" / "acclimate" / "python")
    released = resolve_and_cache(client, workspace, bundle, channel=CHANNEL, cache_dir=cache)
    print(f"\nReleased on {CHANNEL}: version {released['version']['id']}")
    for file in released["payload"]["files"]:
        print(f"\n# {file['path']}\n{file['text']}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit("\nStopped watching. Learning continues on the service.") from None
