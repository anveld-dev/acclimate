# Acclimate Python SDK

Deliver versioned agent instructions, skills and memory to jobs with the Acclimate Python SDK. It requires Python 3.11 or later on Linux or macOS and has no third-party dependencies.

## Test an evaluator adapter

[Install the wheel](#install) in your application's Python environment.

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

```sh
acclimate describe
acclimate try --live --payload ./bundle
```

`try` runs the selected cases and checks the values your callbacks return. `describe` prints revision hashes and case IDs while keeping inputs and expected answers local. `python -m acclimate` runs the same CLI as `acclimate`.

For a complete agent you can run without a model provider, see the [Python support agent example](https://github.com/anveld-dev/acclimate/tree/main/examples/python-support-agent). To start your own, copy the [Python evaluation starter](https://github.com/anveld-dev/acclimate/tree/main/examples/python-evaluation-starter).

## Install

Use the wheel from a GitHub release or build it from a checkout. Verify release artifacts against `SHA256SUMS` and install the wheel without an index. Registry installation with `pip install acclimate-sdk` requires a separate PyPI publication.

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

## Run a learning loop

With your bundle released and the service optimizer configured, set `ACCLIMATE_URL`, `ACCLIMATE_WORKSPACE` and `ACCLIMATE_TOKEN` for a machine principal with `evaluate` and `promote`. Save `acclimate_loop.py` in your app directory.

```python
from acclimate.learning import define_loop, exact, openai

loop = define_loop(
    bundle="support-agent",
    channel="stable",
    agent=openai(model="gpt-6.2-sol"),
    cases="cases.jsonl",
    grade=exact(),
)
```

Each case needs `input` and `expected`. This example grades raw model text, so use string answers. Configure `OPENAI_API_KEY` and, for a compatible endpoint such as CLIProxyAPI, `OPENAI_BASE_URL`. Run `python -m acclimate learn` to enroll and serve the loop. Use `Acclimate().job(bundle, channel="stable", input=task)` to pin a production version. The enrolled app principal can call `job.expect(expected)` when a known answer is available.

## Client conventions

- Method names, keyword arguments and attributes are snake_case. HTTP dictionaries keep the service's camelCase keys, described by the TypedDicts in `acclimate.types`.
- Use the same idempotency key and request when retrying a mutation that accepts an explicit key. Learning outcomes use their outcome UUID for durable replay.
- `ApiError` has `status`, `code`, `request_id` and `details`. Transport failures raise `TransportError`.
- The client rejects redirects, so the token never leaves the configured origin, and bounds every response.
- See the [Python SDK reference](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/python-sdk.mdx).

The client and delivery helpers are synchronous. `define_evaluation` accepts coroutine callbacks and runs them to completion.

## Report delivery

With a separate reporting credential, pass a `DeliveryReporter` to `client.prepare` and call `prepared.report_started()` from the job's actual start event. Save the returned record with your job ID so the connection can link it to the outcome. Calling it again on the same job returns the same event ID. Without a reporter, or when the queue is full, it returns `None`.

`DeliveryReporter` starts one daemon thread on the first observation and keeps at most `max_queue` events. Report failures never affect delivery. `flush()` retries failed events with their original IDs, `wait(timeout=1)` waits for scheduled work, and `close(timeout=0.1)` stops the worker. A short-lived CLI can call `wait(1.2)` and then `close(0)` before it exits. Reports live in memory; a missing report means unknown, not that the agent didn't use the content.

The checkout's delivery check prints the pinned version, digest and staged files:

```sh
export ACCLIMATE_URL=http://127.0.0.1:3000
export ACCLIMATE_WORKSPACE=YOUR_WORKSPACE ACCLIMATE_BUNDLE=YOUR_BUNDLE
export ACCLIMATE_SCOPE=your-stable-app-identity
# Set ACCLIMATE_TOKEN privately to your content-read credential.
export ACCLIMATE_CONNECTION=YOUR_CONNECTION_ID
# Optional: set ACCLIMATE_RECEIPT_TOKEN privately to report delivery.
PYTHONPATH=python python3.11 python/examples/delivery_check.py
```

## Diagnose an evaluation

Run `acclimate try --json` to see callback shape issues. Use `--verbose` for a setup error traceback. Run `acclimate doctor --config "$EVALUATOR_CONFIG" --bundle "$BUNDLE_ID"` to check configuration, local storage and bundle access.

## Develop the SDK

From the repository root, run the offline tests with `PYTHONPATH=python python3.11 -m unittest discover -s python/tests -v`. The [strict typing fixtures](https://github.com/anveld-dev/acclimate/blob/main/python/tests/typing/README.md) check an installed wheel from outside the checkout.
