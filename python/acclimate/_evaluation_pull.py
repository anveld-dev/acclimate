"""Save a channel's published payload to a JSON file."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from ._evaluation_shared import EvaluationError, EvaluationUsageError, make_client, read_evaluator_config
from .client import ApiError
from .delivery import resolve_and_cache

USAGE = "pull --config CONFIG --bundle ID [--channel CHANNEL] --out FILE  Save the published bundle as a payload to edit."


def pull_payload(*, config_path, bundle_id, channel, out):
    """Write a new private payload file."""
    config = read_evaluator_config(config_path)
    try:
        client = make_client(config)
        source = client.inspect_source(config["workspaceId"], bundle_id, channel)
        if not source:
            raise EvaluationError("bundle.missing", field="--bundle", reason="This channel has no release.")
        resolved = resolve_and_cache(client, config["workspaceId"], bundle_id, version_id=source["version"]["id"],
                                     cache_dir=str(Path(config["journalRoot"]) / "command-cache"))
    except ApiError as error:
        if error.status == 404:
            raise EvaluationError("bundle.missing", field="--bundle", http_status=error.status,
                                  reason=f"No published version of this bundle on channel {json.dumps(channel)}.",
                                  hint="Check the bundle ID, the --channel and the evaluator config workspace.") from None
        raise
    target = os.path.abspath(out)
    try:
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise EvaluationUsageError("usage.invalid_flag", field="--out",
                                   reason=f"{out} already exists. Choose a new --out file.") from None
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(json.dumps(resolved["payload"], indent=2, ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    return {"schemaVersion": 1, "bundleId": bundle_id, "channel": channel, "versionId": resolved["version"]["id"],
            "digest": resolved["version"]["digest"], "revision": source["revision"],
            "files": len(resolved["payload"]["files"]), "out": target}


def pull_command(flags):
    """The `pull` command body. The shared evaluator parser has already checked the flags."""
    for name in ("config", "bundle", "out"):
        if not flags.get(name):
            raise EvaluationUsageError("usage.missing_flag", field="--" + name, hint=USAGE)
    channel = flags.get("channel") or "stable"
    result = pull_payload(config_path=flags["config"], bundle_id=flags["bundle"], channel=channel, out=flags["out"])
    if sys.stderr.isatty():
        noun = "file" if result["files"] == 1 else "files"
        print(f"Saved {channel} (version {result['versionId']}, {result['files']} {noun}) to {result['out']}.", file=sys.stderr)
    return 0, result
