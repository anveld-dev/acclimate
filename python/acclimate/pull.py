"""Save a channel's published payload to a JSON file."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

import stat
from urllib.parse import urlsplit
from .errors import AcclimateError
from .client import AcclimateClient, ApiError
from .delivery import resolve_and_cache

USAGE = "pull --config CONFIG --bundle ID [--channel CHANNEL] --out FILE  Save the published bundle as a payload to edit."


def pull_payload(*, config_path, bundle_id, channel, out):
    """Write a new private payload file."""
    config = read_pull_config(config_path)
    try:
        client = AcclimateClient(
            config["serviceUrl"], token=config["token"], scope=config["scope"]
        )
        source = client.inspect_source(config["workspaceId"], bundle_id, channel)
        if not source:
            raise PullError(
                "bundle.missing",
                field="--bundle",
                reason="This channel has no release.",
            )
        resolved = resolve_and_cache(
            client,
            config["workspaceId"],
            bundle_id,
            version_id=source["version"]["id"],
            cache_dir=config["cacheDir"],
        )
    except ApiError as error:
        if error.status == 404:
            raise PullError(
                "bundle.missing",
                field="--bundle",
                http_status=error.status,
                reason=f"No published version of this bundle on channel {json.dumps(channel)}.",
                hint="Check the bundle ID, the --channel and the pull config workspace.",
            ) from None
        raise
    target = os.path.abspath(out)
    try:
        fd = os.open(
            target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600
        )
    except FileExistsError:
        raise PullError(
            "usage.invalid_flag",
            field="--out",
            reason=f"{out} already exists. Choose a new --out file.",
        ) from None
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(
            json.dumps(resolved["payload"], indent=2, ensure_ascii=False) + "\n"
        )
        stream.flush()
        os.fsync(stream.fileno())
    return {
        "schemaVersion": 1,
        "bundleId": bundle_id,
        "channel": channel,
        "versionId": resolved["version"]["id"],
        "digest": resolved["version"]["digest"],
        "revision": source["revision"],
        "files": len(resolved["payload"]["files"]),
        "out": target,
    }


def pull_command(flags):
    """Save the requested payload and return a machine-readable receipt."""
    for name in ("config", "bundle", "out"):
        if not flags.get(name):
            raise PullError("usage.missing_flag", field="--" + name, hint=USAGE)
    channel = flags.get("channel") or "stable"
    result = pull_payload(
        config_path=flags["config"],
        bundle_id=flags["bundle"],
        channel=channel,
        out=flags["out"],
    )
    if sys.stderr.isatty():
        noun = "file" if result["files"] == 1 else "files"
        print(
            f"Saved {channel} (version {result['versionId']}, {result['files']} {noun}) to {result['out']}.",
            file=sys.stderr,
        )
    return 0, result


class PullError(Exception):
    def __init__(self, code, **detail):
        self.detail = {"code": code, **detail}
        super().__init__(code)


def _private_text(filename, limit):
    path = Path(filename).absolute()
    parent = path.parent.stat()
    if path.resolve() != path or parent.st_mode & 0o077 or parent.st_uid != os.getuid():
        raise PullError("config.permissions")
    with os.fdopen(
        os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    ) as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_mode & 0o077
            or info.st_uid != parent.st_uid
            or info.st_size > limit
        ):
            raise PullError("config.permissions")
        return stream.read(limit + 1)


def read_pull_config(filename):
    config = json.loads(_private_text(filename, 65536))
    if not isinstance(config, dict):
        raise PullError("config.schema")
    if "tokenFile" in config:
        if (
            "token" in config
            or not isinstance(config["tokenFile"], str)
            or not Path(config["tokenFile"]).is_absolute()
        ):
            raise PullError("config.schema")
        config["token"] = (
            _private_text(config["tokenFile"], 8192)
            .removesuffix("\n")
            .removesuffix("\r")
        )
    else:
        config.setdefault("token", os.getenv("ACCLIMATE_TOKEN"))
    if (
        config.get("schemaVersion") != 1
        or not all(
            isinstance(config.get(k), str) and config[k].strip()
            for k in ("token", "serviceUrl", "scope", "cacheDir", "workspaceId")
        )
        or not Path(config["cacheDir"]).is_absolute()
    ):
        raise PullError("config.schema")
    url = urlsplit(config["serviceUrl"])
    if (
        url.username
        or url.password
        or url.query
        or url.fragment
        or url.path not in ("", "/")
        or not (
            url.scheme == "https"
            or url.scheme == "http"
            and url.hostname in ("localhost", "127.0.0.1", "::1")
        )
    ):
        raise PullError("config.url")
    return config


def main(argv=None):
    parser = argparse.ArgumentParser(prog="acclimate")
    pull = parser.add_subparsers(dest="command", required=True).add_parser("pull")
    for field in ("config", "bundle", "channel", "out"):
        pull.add_argument("--" + field)
    flags = vars(parser.parse_args(argv))
    try:
        _, result = pull_command(flags)
        print(json.dumps(result))
        return 0
    except PullError as error:
        print(json.dumps({"error": error.detail}), file=sys.stderr)
    except (OSError, ValueError, TypeError, KeyError, AcclimateError):
        print(json.dumps({"error": {"code": "pull.failed"}}), file=sys.stderr)
    return 1
