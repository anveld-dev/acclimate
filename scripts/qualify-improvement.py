#!/usr/bin/env python3
"""Qualify disposable service delivery, one paid Sol draft, and four paid Luna reviews."""

import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "python"))
from scripts.testing.production import service_env
from acclimate import AcclimateClient, prepare_files, resolve_and_cache

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--live", action="store_true", help="Authorize one Sol draft and up to four Luna reviews."
)
args = parser.parse_args()
if not args.live:
    parser.error("--live is required to authorize one paid Sol draft and up to four paid Luna reviews")
database = os.environ.get("EVALUATION_TEST_DATABASE_URL")
if not database:
    parser.error("EVALUATION_TEST_DATABASE_URL must name an owned disposable qualification database")
artifacts = Path(tempfile.mkdtemp(prefix="acclimate-live-review-")).resolve()
project = "qualification-" + uuid.uuid4().hex
principal = "qualification-app"
token = secrets.token_hex(32)
with socket.socket() as reserve:
    reserve.bind(("127.0.0.1", 0))
    port = reserve.getsockname()[1]
base = f"http://127.0.0.1:{port}"
env = service_env(database_url=database, bind=f"127.0.0.1:{port}", project=project,
                  tokens={"operator": token}, login_token=secrets.token_hex(32),
                  console_token=secrets.token_hex(32))
for name in ("ACCLIMATE_MODEL_ENDPOINT", "ACCLIMATE_MODEL_TOKEN", "ACCLIMATE_MODEL"):
    env.pop(name, None)
env.update(
    DATABASE_URL=database,
    ACCLIMATE_BIND=f"127.0.0.1:{port}",
    ACCLIMATE_AUTH=json.dumps(
        [
            {
                "token": token,
                "principalId": principal,
                "workspaceId": project,
                "rights": ["read", "write", "propose", "promote"],
            }
        ]
    ),
)
log = os.fdopen(
    os.open(artifacts / "service.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
)
service = subprocess.Popen(
    [str(ROOT / "target/debug/acclimate-service")],
    cwd=ROOT,
    env=env,
    stdout=log,
    stderr=log,
)
try:
    client = AcclimateClient(base, token, principal, timeout=2, retries=0)
    deadline = time.monotonic() + 15
    while True:
        if service.poll() is not None:
            raise RuntimeError(
                f'Service exited; private startup log: {artifacts / "service.log"}'
            )
        try:
            if client.health() == "ok":
                break
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.1)
    bundle = client.create_bundle(
        project, {"name": "Sol and Luna improvement qualification"}, uuid.uuid4().hex
    )
    payload = json.loads((ROOT / "contracts/fixtures/bundle-v1.json").read_text())
    skill_path = "skills/retry-review/SKILL.md"
    payload["files"][1]["text"] = (
        "---\nname: retry-review\ndescription: Review saved code snapshots for correctness.\n---\nReview the provided code and identify correctness concerns.\n"
    )
    parent = client.create_version(
        project,
        bundle["id"],
        {"parentVersionId": None, "payload": payload},
        uuid.uuid4().hex,
    )
    client.create_release(
        project,
        bundle["id"],
        "stable",
        {
            "versionId": parent["id"],
            "expectedRevision": "0",
            "unevaluatedReason": "Disposable live qualification seed; not measured improvement.",
        },
        uuid.uuid4().hex,
    )
    verified = resolve_and_cache(
        client,
        project,
        bundle["id"],
        cache_dir=str(artifacts / "python-cache"),
        channel="stable",
    )
    assert verified["version"]["digest"] == parent["digest"]
    with prepare_files(verified, str(artifacts / "python-prepared")) as prepared:
        assert len(prepared.files) == 3
        assert (
            Path(prepared.files[1]["absolutePath"]).read_text()
            == payload["files"][1]["text"]
        )
    live_env = dict(env)
    live_env.update(
        ACCLIMATE_URL=base,
        ACCLIMATE_TOKEN=token,
        ACCLIMATE_SCOPE=principal,
        ACCLIMATE_WORKSPACE=project,
        ACCLIMATE_BUNDLE=bundle["id"],
        ACCLIMATE_CHANNEL="stable",
        ACCLIMATE_SKILL_PATH=skill_path,
        ACCLIMATE_CODEX_MODEL="gpt-6-luna",
        ACCLIMATE_OUTPUT_DIR=str(artifacts / "review"),
    )
    output = artifacts / "workflow-output.json"
    with os.fdopen(
        os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
    ) as stdout:
        subprocess.run(
            [
                str(ROOT / "node_modules/.bin/tsx"),
                "examples/improve-review.ts",
                "run",
                "--live",
            ],
            cwd=ROOT,
            env=live_env,
            stdout=stdout,
            check=True,
            timeout=600,
        )
    result = json.loads(output.read_text())
    summary = result["summary"]
    assert summary["authorModel"] == "gpt-6.2-sol"
    assert summary["model"] == "gpt-6-luna"
    comparison = client.get_comparison(project, bundle["id"], summary["comparisonId"])
    assert comparison["runtime"]["model"] == summary["model"]
    assert comparison["candidateVersionId"] == summary["candidate"]["id"]
    assert comparison["candidateDigest"] == summary["candidate"]["digest"]
    assert len(comparison["expectedCases"]) == 2 and len(comparison["results"]) == 2
    channel, _, _ = client.resolve_channel(project, bundle["id"], "stable")
    assert (
        channel["version"]["id"] == parent["id"]
    ), "Workflow must stop before candidate promotion"
    print(
        json.dumps(
            {
                "authorModel": summary["authorModel"],
                "model": summary["model"],
                "summaryPath": result["summaryPath"],
                "comparisonComplete": comparison["complete"],
                "expectedPairs": 2,
                "automaticPromotion": False,
                "pythonDelivery": "passed",
                "note": "Tiny fixture sample proves wiring, not a general quality gain.",
            },
            indent=2,
        )
    )
finally:
    service.terminate()
    try:
        service.wait(timeout=8)
    except subprocess.TimeoutExpired:
        service.kill()
        service.wait()
    log.close()
