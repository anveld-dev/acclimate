# Acclimate Python SDK

Python 3.11+ is required; private cache, materialization and durable evaluation helpers require POSIX. No Node or third-party runtime dependencies are needed.

Obtain the versioned SDK release, starter archives, manifest and `SHA256SUMS` from your workspace operator, then verify the received files against those checksums. Distribution is operator-managed; this guide does not assume a public package registry. [Getting started](../docs/getting-started.md#1-obtain-a-release-and-choose-a-language) explains release acquisition and connecting an existing agent; [evaluator operations](../docs/evaluator-operations.md) covers evaluator access and private persistent storage. For release 0.1.0, install the exact obtained wheel into your application's environment:

```sh
python3.11 -m venv .venv
.venv/bin/python -m pip install --no-index --no-deps /absolute/path/to/release/acclimate_sdk-0.1.0-py3-none-any.whl
```

Contributors can instead build from a source checkout. From the repository root, run:

```sh
python3.11 -m pip wheel --no-deps --wheel-dir /absolute/path/to/new-wheel-output ./python
```

Install that generated wheel with the same application-environment command above, replacing its path. Building requires the build tooling declared in `pyproject.toml` and may download it; installing an obtained wheel with `--no-index --no-deps` does not. See [source development](../docs/development.md#use-python) and the [release verification command](../docs/development.md#publish-and-consume-content) for packaging details.

Prepare the published content for one real job:

```python
import os
from acclimate import AcclimateClient
from application import run_agent

client = AcclimateClient(os.environ["ACCLIMATE_URL"], os.environ["ACCLIMATE_TOKEN"], "support-agent")
with client.prepare(project_id, bundle_id, channel="stable") as prepared:
    result = run_agent(task, instructions=prepared.instructions, skill_files=prepared.skill_files)
    save_job_result(result, version=prepared.version["id"], digest=prepared.version["digest"])
```

`run_agent` and `save_job_result` belong to your application. Use the context manager when the call owns and completes all use of the files before it returns or raises. For background work, keep the prepared object and call `cleanup()` after the real job has stopped and the result is retained. Pass `version_id` for a pinned release. The default verified cache is `~/.cache/acclimate/python`, and each call creates its own private working directory. Override these with `cache_dir` and `destination` for persistent jobs. Use a distinct cache directory for each SDK language. `prepared.directory` locates the staged files, and `prepared.bundle` carries the original verified payload and resolution metadata. Your app selects which memory files to use.

The scope identifies the authenticated principal and namespaces the cache; it must remain stable and must never be a token. Reads resolve online by default. To permit fallback only on transport failure or HTTP 503, specify `offline_max_age` in seconds (up to 30 days) for a cached channel, or `offline_pinned_version` for an exact version. Returned `stale` marks fallback; `resolvedAt` is milliseconds since the Unix epoch. Denials, missing resources, malformed responses, and integrity failures never trigger fallback. A cached payload is always verified against metadata before parsing. Only use cache and destination directories controlled by the current user.

All mutation methods require an explicit printable ASCII idempotency key, and serialize once for retries. Reuse the same key and request for a retry across calls. `ApiError` exposes `status`, `code`, and `request_id` (also `requestId`); transport failures raise `TransportError`. Redirects are rejected, including same-origin redirects, to prevent credential forwarding. Responses and timeouts are bounded. `resolve_channel` returns `(resolution, etag, not_modified)`. The remaining method names mirror R0 routes in snake case; wire dictionaries use the camelCase keys in `acclimate.types`.

For paired evaluations, export your cases, execute callback and independent grader from a Python module. The installed CLI accepts a module name or a source file. Package-relative imports work in both forms. The default adapter is `application.py` in the current directory.

```sh
python -m acclimate coverage --app support_agent.evals
python -m acclimate describe --app support_agent.evals
python -m acclimate compare --app support_agent.evals --config "$EVALUATOR_CONFIG" --handoff "$HANDOFF" --live
python -m acclimate status --read-config "$READER_CONFIG" --handoff "$HANDOFF"
```

`coverage` lists the adapter, local source imports, external packages, declared revision files and artifact names. The worker fingerprints ordinary imports recursively within your application. Direct external imports bind their available Python source and installed wheel records. Declare dynamic imports, dependency lockfiles, assets and deployment settings in `revision_files` or `runtime`. The public descriptor contains revision hashes. Start a fresh evaluator process after changing imported code. The CLI uses the selected callbacks to run both pinned versions, and the read-only `status` and `verify-export` commands can run independently on another machine. [Application signatures](../examples/evaluation-starter/README.md) · [Evaluation setup](../docs/getting-started.md)

If the comparison reports `output_invalid`, inspect `output-validation.json` in the private job directory for the failing field and a suggested correction. To diagnose application exceptions, enable `"captureCallbackErrors": true` in the private evaluator configuration. The worker writes `callback-error.json` with the callback phase, exception class and up to eight stack locations. Exception messages and locals stay out of the diagnostic.

The client, delivery helpers and evaluation runner are synchronous. Async applications should use the starter's [complete `async_eval.py` recipe](../examples/evaluation-starter/async_eval.py), which offloads the entire run, signals cooperative cancellation and drains the worker through repeated caller cancellations. Keep preparation, execution, result capture and cleanup in the worker's lifetime: cancelling an await does not stop a thread or external work. Durable evaluation needs a stable private local journal volume; preserve its exact root, service URL, principal and originating language/release for retries. A sealed report retries its saved body/key without rerunning callbacks. Started execution without a sealed report requires inspection; see [recovery decisions](../docs/evaluator-operations.md#recovery-decisions).

Run offline source tests from the repository root with `PYTHONPATH=python python3.11 -m unittest discover -s python/tests -v`. This deliberately imports the checkout. Installed applications omit `PYTHONPATH=python`; the wheel contains the SDK, while examples and starter scripts are obtained separately. The [strict typing fixtures](tests/typing/README.md) check an installed wheel from outside the checkout.

The delivery-check command reads each staged file and prints the pinned version, digest and checked file inventory. With a separate receipt-write credential, it can also report preparation. In your app, pass a `DeliveryReporter` to `client.prepare` and call `prepared.report_started()` from the job’s actual start event. Retain its returned receipt with your job ID for a connected field audit. Calling it again on the same prepared job returns the same event ID. A missing reporter or a full reporting queue returns `None`. Once a full queue drains, call `report_started()` on the same prepared job to enqueue the original start event.

```sh
export ACCLIMATE_URL=http://127.0.0.1:3000
export ACCLIMATE_PROJECT=YOUR_PROJECT ACCLIMATE_BUNDLE=YOUR_BUNDLE
export ACCLIMATE_SCOPE=your-stable-app-identity
# Set ACCLIMATE_TOKEN privately to your content-read credential.
# Optional: set ACCLIMATE_INTEGRATION and ACCLIMATE_RECEIPT_TOKEN privately.
PYTHONPATH=python python3 python/examples/delivery_check.py
```

The command above uses the checkout's example script and source SDK. For an installed wheel, run a separately copied `delivery_check.py` without `PYTHONPATH=python`. Create cache/job directories with
mode `0700` if they already exist. Preparation cleans only the files it creates.
Reporting clients in the recipe use a one-second timeout and no retries. Optional
report failures leave delivery available. Without optional credentials,
no reporting client or worker is created.

`DeliveryReporter` starts one daemon thread lazily on the first accepted observation,
keeps at most `max_queue` events including in-flight work, and retains failed events
without spinning. Fresh observations drain independently of failures. Call `flush()`
to explicitly retry the original event IDs/times. `wait(timeout=1)` waits for scheduled
work, returns a boolean, and does not retry failures. `pending_count` includes failed
and in-flight events. `close(timeout=0.1)` stops claiming additional events and returns
whether its worker stopped. Both timeouts accept 0–30 seconds. An already claimed
request may finish after close; even a stuck injected client cannot hold up interpreter
exit. A best-effort CLI can call `wait(1.2)` followed by `close(0)` before returning.
Reports are memory-only; missing observations mean unknown and never prove model
consumption.
