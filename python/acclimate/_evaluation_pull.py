"""Save a channel's published payload as the JSON file `compare --payload` reads."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from ._evaluation_shared import EvaluationError, make_client, read_evaluator_config
from .client import ApiError
from .delivery import resolve_and_cache

USAGE = "pull --config CONFIG --bundle ID [--channel CHANNEL] --out FILE  Save the published bundle as a payload to edit."


class _Usage(Exception):
    pass


def _parse(args):
    flags = {}
    for index in range(1, len(args), 2):
        name = args[index][2:] if args[index].startswith("--") else ""
        if name not in ("config", "bundle", "channel", "out") or name in flags:
            raise _Usage("Usage: python -m acclimate " + USAGE)
        if index + 1 >= len(args) or args[index + 1].startswith("--"):
            raise _Usage("Supply a value for --" + name + ".")
        flags[name] = args[index + 1]
    for name in ("config", "bundle", "out"):
        if not flags.get(name):
            raise _Usage("Missing --" + name + ". Usage: python -m acclimate " + USAGE)
    flags.setdefault("channel", "stable")
    return flags


def pull_payload(*, config_path, bundle_id, channel, out):
    """Write a new private payload file. Edit it, then compare it with its parent."""
    config = read_evaluator_config(config_path)
    resolved = resolve_and_cache(make_client(config), config["projectId"], bundle_id, channel=channel,
                                 cache_dir=str(Path(config["journalRoot"]) / "command-cache"))
    target = os.path.abspath(out)
    try:
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise _Usage(out + " already exists. Choose a new --out file.") from None
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(json.dumps(resolved["payload"], indent=2, ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    resolution = resolved.get("resolution") or {}
    return {"schemaVersion": 1, "bundleId": bundle_id, "channel": channel, "versionId": resolved["version"]["id"],
            "digest": resolved["version"]["digest"], "revision": resolution.get("revision"),
            "files": len(resolved["payload"]["files"]), "out": target}


def pull_main(args):
    try:
        flags = _parse(args)
        result = pull_payload(config_path=flags["config"], bundle_id=flags["bundle"], channel=flags["channel"], out=flags["out"])
    except _Usage as error:
        print(str(error), file=sys.stderr)
        return 1
    except ApiError as error:
        print(f"The service refused the request ({error.status} {error.code}). Check the bundle ID, channel and evaluator config.", file=sys.stderr)
        return 1
    except EvaluationError as error:
        print(f"Could not read the evaluator config ({error.code}).", file=sys.stderr)
        return 1
    except OSError:
        print("Could not save the payload. Check the service URL, CA trust and output path.", file=sys.stderr)
        return 1
    print(json.dumps(result))
    if sys.stderr.isatty():
        noun = "file" if result["files"] == 1 else "files"
        print(f"Saved {flags['channel']} (version {result['versionId']}, {result['files']} {noun}) to {flags['out']}.\n"
              f"Edit it, then run: python -m acclimate compare --config {flags['config']} --bundle {flags['bundle']} "
              f"--channel {flags['channel']} --payload {flags['out']} --name NAME --live", file=sys.stderr)
    return 0
