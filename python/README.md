# Acclimate Python SDK

Evaluate changes to your agent's instructions, skills and memory against saved cases, and deliver the released version to each job. [Acclimate](https://github.com/anveld-dev/acclimate) is a self-hosted service; this package is its Python client and evaluator. It needs Python 3.11 or later on Linux or macOS and has no third-party dependencies.

## Quickstart: evaluate a change

```sh
pip install acclimate-sdk
```

```python
# application.py, next to your agent
from acclimate.evaluation import ExecutionResult, GradeResult
from support_agent import run_agent, score_result, saved_cases

cases = saved_cases  # [{"caseId": ..., "input": ..., "expected": ...}]

def execute(run):  # run.version holds the version under test
    result = run_agent(files=run.version["payload"]["files"], task=run.input)
    return ExecutionResult(output=result.answer)

def grade(run):
    return GradeResult(reward=score_result(run.output, run.expected))
```

Try the change on your laptop first. Put the current files in `parent/` and your edit in `candidate/`:

```sh
acclimate try --live --payload candidate
acclimate compare --local --parent parent --candidate candidate --live
```

`try` runs one case and checks every value your callbacks return. `compare --local` grades both versions with the same pairing as a service run and writes an advisory report that is never release evidence. Neither needs a service, config or handoff. Then compare against the service to gate a release:

```sh
acclimate describe
acclimate compare --config "$EVALUATOR_CONFIG" --handoff "$HANDOFF" --live
```

`describe` prints the public descriptor: revision hashes and case IDs, never inputs or expected answers. `compare` runs both versions through `execute` and `grade` and records the comparison for review. `python -m acclimate` runs the same CLI as the `acclimate` command.

For a complete agent you can run without a model provider, see the [Python support agent example](https://github.com/anveld-dev/acclimate/tree/main/examples/python-support-agent). To start your own, copy the [Python evaluation starter](https://github.com/anveld-dev/acclimate/tree/main/examples/python-evaluation-starter).

## Install

`pip install acclimate-sdk` installs from PyPI. For an air-gapped machine, verify the release files against `SHA256SUMS` and install the wheel without an index:

```sh
python3.11 -m pip install --no-index --no-deps /absolute/path/to/release/acclimate_sdk-0.1.0-py3-none-any.whl
```

To build a wheel from a checkout, run `python3.11 -m pip wheel --no-deps --wheel-dir /tmp/acclimate-wheel ./python` or `uv build --wheel --out-dir /tmp/acclimate-wheel ./python`. Neither writes build files into the checkout, and neither needs Node.js. Importing the package on Python 3.10 or earlier fails with a message naming the version found.

## Deliver the released version to a job

```python
import os
from acclimate import AcclimateClient

client = AcclimateClient(
    os.environ["ACCLIMATE_URL"], os.environ["ACCLIMATE_TOKEN"], "support-agent",
    connection_id=os.environ["ACCLIMATE_CONNECTION"],
)
with client.prepare(workspace_id, bundle_id, channel="stable") as prepared:
    result = run_agent(task, instructions=prepared.instructions, skill_files=prepared.skill_files)
    save_job_result(result, version=prepared.version["version"]["id"], digest=prepared.version["version"]["digest"])
```

`run_agent` and `save_job_result` belong to your application. For background work, keep the prepared object and call `cleanup()` after the job stops and its result is saved. The verified cache defaults to `~/.cache/acclimate/python`; set `cache_dir` and `destination` to change the cache and job directories. Only use directories the current user controls.

Set the connection UUID in `ACCLIMATE_CONNECTION`. Each new job checks its connection online. Verified file contents can then be reused from disk. A job already running keeps its prepared files until cleanup.

## Client conventions

- Method names, keyword arguments and attributes are snake_case. HTTP dictionaries keep the service's camelCase keys, described by the TypedDicts in `acclimate.types`.
- Every mutation takes an explicit printable ASCII idempotency key. Retry with the same key and request.
- `ApiError` has `status`, `code`, `request_id` and `details`. Transport failures raise `TransportError`.
- The client rejects redirects, so the token never leaves the configured origin, and bounds every response.
- The client has every method of the TypeScript client, in snake_case. See the [Python SDK reference](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/python-sdk.mdx).

The client, delivery helpers and evaluation runner are synchronous. `define_evaluation` accepts coroutine callbacks and runs them to completion. To run a whole evaluation from an asyncio application, await `acclimate.evaluation.run_evaluation_async`, which runs it in a worker thread, signals cancellation and waits for the worker to finish. The starter's `async_eval.py` shows the call.

## Report delivery

With a separate reporting credential, pass a `DeliveryReporter` to `client.prepare` and call `prepared.report_started()` from the job's actual start event. Save the returned record with your job ID so the connection can link it to the outcome. Calling it again on the same job returns the same event ID. Without a reporter, or when the queue is full, it returns `None`.

`DeliveryReporter` starts one daemon thread on the first observation and keeps at most `max_queue` events. Report failures never affect delivery. `flush()` retries failed events with their original IDs, `wait(timeout=1)` waits for scheduled work, and `close(timeout=0.1)` stops the worker. A short-lived CLI can call `wait(1.2)` and then `close(0)` before it exits. Reports live in memory; a missing report means unknown, not that the agent didn't use the content.

The checkout's delivery check prints the pinned version, digest and staged files:

```sh
export ACCLIMATE_URL=http://127.0.0.1:3000
export ACCLIMATE_WORKSPACE=YOUR_WORKSPACE ACCLIMATE_BUNDLE=YOUR_BUNDLE
export ACCLIMATE_SCOPE=your-stable-app-identity
# Set ACCLIMATE_TOKEN privately to your content-read credential.
export ACCLIMATE_CONNECTION=YOUR_ENROLLED_CONNECTION_ID
# Optional: set ACCLIMATE_RECEIPT_TOKEN privately to report delivery.
PYTHONPATH=python python3.11 python/examples/delivery_check.py
```

## Diagnose an evaluation

If a comparison reports `output_invalid`, read `output-validation.json` in the private job directory for the failing field and a suggested fix. When a callback raises, the worker writes `callback-error.json` to that private job directory with the phase, exception class, redacted message and traceback, and the command output names the first failure's file. The file never leaves the machine. Set `"captureCallbackErrors": false` in the evaluator configuration to opt out. Add `--verbose` or set `ACCLIMATE_DEBUG=1` to see the full traceback of a setup error such as an `ImportError` in your module. Every error has a documented code and exit status; see [error codes](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/error-codes.mdx).

Durable evaluation needs a stable, private, local journal directory. Keep its path, the service URL, the principal and the SDK language and release the same until a run finishes. A sealed report retries its saved request without rerunning callbacks. A run that started executing without a sealed report needs inspection; see [recovery decisions](https://github.com/anveld-dev/acclimate/blob/main/docs/evaluator-operations.md#recovery-decisions).

## Develop the SDK

From the repository root, run the offline tests with `PYTHONPATH=python python3.11 -m unittest discover -s python/tests -v`. The [strict typing fixtures](https://github.com/anveld-dev/acclimate/blob/main/python/tests/typing/README.md) check an installed wheel from outside the checkout.
