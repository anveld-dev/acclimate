"""``python -m acclimate pull``: save a channel's released payload to a new JSON file."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.parse import urlsplit

from .errors import AcclimateError
from .client import AcclimateClient, ApiError
from .delivery import resolve_and_cache

USAGE = "pull --bundle <name or id> --out <file> [--channel <name>] [--config <file>]"
_UUID = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.IGNORECASE)


class PullError(Exception):
    """A failure the command reports with a stable ``code``."""

    def __init__(self, code, message, **detail):
        self.detail = {"code": code, "message": message, **detail}
        super().__init__(message)


def _target(flags):
    """The client, workspace and cache directory from --config, or from the environment."""
    if flags.get("config"):
        config = read_pull_config(flags["config"])
        client = AcclimateClient(config["serviceUrl"], token=config["token"], scope=config["scope"])
        return client, config["workspaceId"], config["cacheDir"]
    url = flags.get("url") or os.getenv("ACCLIMATE_URL")
    workspace = flags.get("workspace") or os.getenv("ACCLIMATE_WORKSPACE")
    token = os.getenv("ACCLIMATE_TOKEN")
    if not (url and workspace and token):
        raise PullError(
            "config.missing", "Set ACCLIMATE_URL, ACCLIMATE_WORKSPACE and ACCLIMATE_TOKEN.",
            hint="--url and --workspace can replace the first two. The token is read only from ACCLIMATE_TOKEN.",
        )
    scope = "python:" + hashlib.sha256(token.encode()).hexdigest()
    cache = Path.home().resolve() / ".cache" / "acclimate" / "python"
    return AcclimateClient(url, token, scope), workspace, str(cache)


def _bundle_id(client, workspace, value):
    """Find a bundle by name, or take a UUID as its ID."""
    if _UUID.match(value):
        return value
    matches, cursor = [], None
    while True:
        page = client.list_bundles(workspace, cursor=cursor, limit=100)
        matches += [bundle["id"] for bundle in page["items"] if bundle["name"] == value]
        cursor = page["nextCursor"]
        if cursor is None:
            break
    if len(matches) > 1:
        raise PullError("bundle.ambiguous", f"More than one bundle is named {json.dumps(value)}.",
                        field="--bundle", hint="Pass the bundle ID instead.")
    if not matches:
        raise PullError("bundle.missing", f"No bundle is named {json.dumps(value)} in this workspace.",
                        field="--bundle", hint="Check the name and ACCLIMATE_WORKSPACE.")
    return matches[0]


def pull_payload(flags):
    """Write a new private payload file and return the command's result."""
    client, workspace, cache_dir = _target(flags)
    channel = flags.get("channel") or "stable"
    out = flags["out"]
    bundle_id = _bundle_id(client, workspace, flags["bundle"])

    def missing(**detail):
        return PullError("bundle.missing", f"No version of this bundle is released on {json.dumps(channel)}.",
                         field="--bundle", hint="Check the bundle, the --channel and the workspace.", **detail)

    try:
        source = client.inspect_source(workspace, bundle_id, channel)
        if not source:
            raise missing()
        resolved = resolve_and_cache(
            client, workspace, bundle_id, version_id=source["version"]["id"], cache_dir=cache_dir,
        )
    except ApiError as error:
        if error.status == 404:
            raise missing(httpStatus=404) from None
        raise
    target = os.path.abspath(out)
    try:
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise PullError("usage.invalid_flag", f"{out} already exists. Choose a new --out file.",
                        field="--out") from None
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(json.dumps(resolved["payload"], indent=2, ensure_ascii=False) + "\n")
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


def _private_text(filename, limit):
    path = Path(filename).absolute()
    try:
        parent = path.parent.stat()
        resolved = path.resolve(strict=True)
    except FileNotFoundError:
        raise PullError("config.unreadable", f"Cannot read {filename}.", field="--config") from None
    if resolved != path or parent.st_mode & 0o077 or parent.st_uid != os.getuid():
        raise _permissions()
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)) as stream:
        info = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_mode & 0o077
            or info.st_uid != parent.st_uid
            or info.st_size > limit
        ):
            raise _permissions()
        return stream.read(limit + 1)


def _permissions():
    return PullError("config.permissions", "Keep the pull config and token file private to their owner.",
                     field="--config")


def _schema():
    return PullError("config.schema", "The pull config is not valid.", field="--config")


def read_pull_config(filename):
    try:
        config = json.loads(_private_text(filename, 65536))
    except json.JSONDecodeError:
        raise _schema() from None
    if not isinstance(config, dict):
        raise _schema()
    if "tokenFile" in config:
        if (
            "token" in config
            or not isinstance(config["tokenFile"], str)
            or not Path(config["tokenFile"]).is_absolute()
        ):
            raise _schema()
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
        raise _schema()
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
        raise PullError("config.url", "serviceUrl must be an HTTPS origin, or HTTP on localhost.",
                        field="--config")
    return config


def _failure(error):
    if isinstance(error, PullError):
        return error.detail
    if isinstance(error, ApiError):
        detail = {"code": error.code, "message": str(error), "httpStatus": error.status}
        if error.request_id:
            detail["requestId"] = error.request_id
        return detail
    if isinstance(error, AcclimateError):
        return {"code": error.code, "message": str(error)}
    return {"code": "cli.failed", "message": "The command failed. Check the command, the settings and the service."}


def main(argv=None):
    """Run ``pull`` and return its exit status: 0, 1 for a failure, 2 for a usage error."""
    parser = argparse.ArgumentParser(prog="python -m acclimate")
    pull = parser.add_subparsers(dest="command", required=True).add_parser("pull", usage=USAGE)
    for field in ("config", "bundle", "channel", "out", "url", "workspace"):
        pull.add_argument("--" + field)
    flags = vars(parser.parse_args(argv))
    try:
        for name in ("bundle", "out"):
            if not flags.get(name):
                raise PullError("usage.missing_flag", f"--{name} is required.", field="--" + name,
                                hint="Usage: " + USAGE)
        result = pull_payload(flags)
        noun = "file" if result["files"] == 1 else "files"
        print(json.dumps(result))
        print(f"Saved {result['channel']} (version {result['versionId']}, {result['files']} {noun}) to {result['out']}.",
              file=sys.stderr)
        return 0
    except (PullError, OSError, ValueError, TypeError, KeyError, AcclimateError) as error:
        detail = _failure(error)
        print(json.dumps({"error": detail}))
        hint = detail.get("hint")
        print(f"acclimate: {detail['message']}" + (f" {hint}" if hint else ""), file=sys.stderr)
        return 2 if detail["code"].startswith("usage.") else 1
