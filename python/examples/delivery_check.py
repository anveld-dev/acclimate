"""Check the files delivered by the configured service."""
import json
import os
from pathlib import Path
import sys
from acclimate import AcclimateClient, DeliveryReporter


def main():
    for key in ("ACCLIMATE_URL", "ACCLIMATE_TOKEN", "ACCLIMATE_SCOPE", "ACCLIMATE_PROJECT", "ACCLIMATE_BUNDLE"):
        if not os.environ.get(key):
            raise ValueError("Set " + key)
    base_url = os.environ["ACCLIMATE_URL"]
    project, bundle_id = os.environ["ACCLIMATE_PROJECT"], os.environ["ACCLIMATE_BUNDLE"]
    scope = os.environ["ACCLIMATE_SCOPE"]
    client = AcclimateClient(base_url, os.environ["ACCLIMATE_TOKEN"], scope)
    reporter = None
    if os.environ.get("ACCLIMATE_RECEIPT_TOKEN") or os.environ.get("ACCLIMATE_INTEGRATION"):
        try:
            # Reporting has its own short deadline and never retries automatically.
            receipt_client = AcclimateClient(base_url, os.environ["ACCLIMATE_RECEIPT_TOKEN"],
                                            scope + ":receipts", timeout=1, retries=0)
            reporter = DeliveryReporter(receipt_client, project, os.environ["ACCLIMATE_INTEGRATION"])
        except Exception:
            print("Optional delivery reporting is unavailable.", file=sys.stderr)
    try:
        with client.prepare(
            project, bundle_id, channel=os.environ.get("ACCLIMATE_CHANNEL", "stable"),
            cache_dir=Path(os.environ["ACCLIMATE_CACHE"]).resolve() if os.getenv("ACCLIMATE_CACHE") else None,
            destination=Path(os.environ["ACCLIMATE_JOB_DIR"]).resolve() if os.getenv("ACCLIMATE_JOB_DIR") else None,
            reporter=reporter,
        ) as prepared:
            for file in prepared.files:
                Path(file["absolutePath"]).read_bytes()
            print(json.dumps(dict(
                versionId=prepared.version["id"], digest=prepared.version["digest"],
                files=[file["path"] for file in prepared.files], checkedFiles=len(prepared.files),
                reporting="optional" if reporter else "disabled",
            )))
    finally:
        if reporter is not None:
            reporter.wait(1.2)
            reporter.close(0)


if __name__ == "__main__":
    main()
