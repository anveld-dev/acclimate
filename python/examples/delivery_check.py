"""Model-free app delivery with an independent optional receipt-write client."""
import json
import os
from pathlib import Path
import subprocess
import sys
from acclimate import AcclimateClient, DeliveryReporter, prepare_files, resolve_and_cache


def main():
    for key in ("ACCLIMATE_TOKEN", "ACCLIMATE_PROJECT", "ACCLIMATE_BUNDLE",
                "ACCLIMATE_CACHE", "ACCLIMATE_JOB_DIR"):
        if not os.environ.get(key):
            raise ValueError("Set " + key)
    base_url = os.environ.get("ACCLIMATE_URL", "http://127.0.0.1:3000")
    project, bundle_id = os.environ["ACCLIMATE_PROJECT"], os.environ["ACCLIMATE_BUNDLE"]
    scope = os.environ.get("ACCLIMATE_SCOPE", "delivery-check")
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
        bundle = resolve_and_cache(client, project, bundle_id,
                                   channel=os.environ.get("ACCLIMATE_CHANNEL", "stable"),
                                   cache_dir=str(Path(os.environ["ACCLIMATE_CACHE"]).resolve()),
                                   reporter=reporter)
        with prepare_files(bundle, str(Path(os.environ["ACCLIMATE_JOB_DIR"]).resolve())) as prepared:
            # prepare_files reports prepared only after every file is staged.
            app = subprocess.Popen([sys.executable, "-c", """
import pathlib, sys
print('delivery-check started', flush=True)
for path in sys.argv[1:]:
    pathlib.Path(path).read_text()
""", *[file["absolutePath"] for file in prepared.files]], stdout=subprocess.PIPE, text=True)
            try:
                started = app.stdout.readline().strip() == "delivery-check started"
                if started and bundle.get("reporter") is not None:
                    try:
                        bundle["reporter"].report_started()
                    except Exception:
                        pass
                if app.wait(timeout=10) != 0 or not started:
                    raise RuntimeError("Application start or file read failed")
                print(json.dumps(dict(versionId=bundle["version"]["id"], digest=bundle["version"]["digest"],
                                      files=[file["path"] for file in prepared.files], started=started,
                                      reporting="optional" if reporter else "disabled")))
            finally:
                app.stdout.close()
                if app.poll() is None:
                    app.kill()
                    app.wait()
    finally:
        if reporter is not None:
            reporter.wait(1.2)
            reporter.close(0)


if __name__ == "__main__":
    main()
