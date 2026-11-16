# Acclimate Python SDK

Install the wheel with `pip install acclimate_sdk-*.whl`. Python 3.11+ is required; private cache and materialization helpers require POSIX. No third-party runtime dependencies are needed.

```python
from acclimate import AcclimateClient, resolve_and_cache, prepare_files

client = AcclimateClient('https://acclimate.example', token='TOKEN', scope='stable-principal-id')
bundle = resolve_and_cache(client, 'project', 'bundle', channel='stable', cache_dir='/private/cache')
with prepare_files(bundle, '/private/workspace') as prepared:
    print(prepared.files)
```

The scope identifies the authenticated principal and namespaces the cache; it must remain stable and must never be a token. Reads resolve online by default. To permit fallback only on transport failure or HTTP 503, specify `offline_max_age` in seconds (up to 30 days) for a cached channel, or `offline_pinned_version` for an exact version. Returned `stale` marks fallback; `resolvedAt` is milliseconds since the Unix epoch. Denials, missing resources, malformed responses, and integrity failures never trigger fallback. A cached payload is always verified against metadata before parsing. Only use cache and destination directories controlled by the current user.

All mutation methods require an explicit printable ASCII idempotency key, and serialize once for retries. Reuse the same key and request for a retry across calls. `ApiError` exposes `status`, `code`, and `request_id` (also `requestId`); transport failures raise `TransportError`. Redirects are rejected, including same-origin redirects, to prevent credential forwarding. Responses and timeouts are bounded. `resolve_channel` returns `(resolution, etag, not_modified)`. The remaining method names mirror R0 routes in snake case; wire dictionaries use the camelCase keys in `acclimate.types`.

Run offline tests from the repository root with `PYTHONPATH=python python3 -m unittest discover -s python/tests -v`.

Optional delivery observations use a separate receipt-write credential. The model-free
recipe at `python/examples/delivery_check.py` stages a pinned bundle, starts a real child
application that reads the files, and reports `started` only after observing its output.
It makes no provider calls. From this checkout, use Python 3.11+:

```sh
export ACCLIMATE_URL=http://127.0.0.1:3000
export ACCLIMATE_PROJECT=YOUR_PROJECT ACCLIMATE_BUNDLE=YOUR_BUNDLE
export ACCLIMATE_SCOPE=your-stable-app-identity
export ACCLIMATE_CACHE=/absolute/private/cache
export ACCLIMATE_JOB_DIR=/absolute/private/empty-job
# Set ACCLIMATE_TOKEN privately to your content-read credential.
# Optional: set ACCLIMATE_INTEGRATION and ACCLIMATE_RECEIPT_TOKEN privately.
PYTHONPATH=python python3 python/examples/delivery_check.py
```

For an installed wheel, omit `PYTHONPATH=python`. Create cache/job directories with
mode `0700` if they already exist. Preparation cleans only the files it creates.
Reporting clients in the recipe use a one-second timeout and no retries. Optional
report failures never change delivery or application start. Without optional credentials,
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
