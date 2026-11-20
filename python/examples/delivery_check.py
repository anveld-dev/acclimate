"""Check the files delivered by the configured service."""
import json
import os
from pathlib import Path
import sys
from acclimate import AcclimateClient, DeliveryReporter


def check_renamed_environment():
    # 0.2.0 renamed these variables. Fail rather than ignore a setting from an older setup.
    for old, new in (("ACCLIMATE_PROJECT", "ACCLIMATE_WORKSPACE"), ("ACCLIMATE_INTEGRATION", "ACCLIMATE_CONNECTION")):
        if os.environ.get(old) and not os.environ.get(new):
            raise ValueError(f"{old} was renamed to {new} in 0.2.0")


def main():
    check_renamed_environment()
    for key in ("ACCLIMATE_URL", "ACCLIMATE_TOKEN", "ACCLIMATE_SCOPE", "ACCLIMATE_WORKSPACE", "ACCLIMATE_BUNDLE"):
        if not os.environ.get(key):
            raise ValueError("Set " + key)
    base_url = os.environ["ACCLIMATE_URL"]
    workspace_id, bundle_id = os.environ["ACCLIMATE_WORKSPACE"], os.environ["ACCLIMATE_BUNDLE"]
    scope = os.environ["ACCLIMATE_SCOPE"]
    client = AcclimateClient(base_url, os.environ["ACCLIMATE_TOKEN"], scope)
    reporter = None
    if os.environ.get("ACCLIMATE_RECEIPT_TOKEN") or os.environ.get("ACCLIMATE_CONNECTION"):
        try:
            # Reporting has its own short deadline and never retries automatically.
            receipt_client = AcclimateClient(base_url, os.environ["ACCLIMATE_RECEIPT_TOKEN"],
                                            scope + ":receipts", timeout=1, retries=0)
            reporter = DeliveryReporter(receipt_client, workspace_id, os.environ["ACCLIMATE_CONNECTION"])
        except Exception:
            print("Optional delivery reporting is unavailable.", file=sys.stderr)
    try:
        with client.prepare(
            workspace_id, bundle_id, channel=os.environ.get("ACCLIMATE_CHANNEL", "stable"),
            cache_dir=Path(os.environ["ACCLIMATE_CACHE"]).resolve() if os.getenv("ACCLIMATE_CACHE") else None,
            destination=Path(os.environ["ACCLIMATE_JOB_DIR"]).resolve() if os.getenv("ACCLIMATE_JOB_DIR") else None,
            reporter=reporter,
        ) as prepared:
            for file in prepared.files:
                Path(file["absolutePath"]).read_bytes()
            print(json.dumps(dict(
                versionId=prepared.version["version"]["id"], digest=prepared.version["version"]["digest"],
                files=[file["path"] for file in prepared.files], checkedFiles=len(prepared.files),
                reporting="optional" if reporter else "disabled",
            )))
    finally:
        if reporter is not None:
            reporter.wait(1.2)
            reporter.close(0)


if __name__ == "__main__":
    main()
