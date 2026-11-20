# Python evaluation starter

This starter runs your Python agent and an independent grader on the parent and candidate versions of a bundle, then compares the results. It needs Python 3.11 or later on Linux or macOS. It does not need Node.

For a complete working agent, see the [Python support agent example](../python-support-agent/README.md).

## Install

```sh
python3.11 -m venv .venv
.venv/bin/python -m pip install acclimate-sdk
```

For an offline or air-gapped install, verify the release files against `SHA256SUMS` and install the wheel directly:

```sh
.venv/bin/python -m pip install --no-index --no-deps /absolute/path/to/release/acclimate_sdk-0.2.0-py3-none-any.whl
```

The package installs an `acclimate` command. `python -m acclimate` runs the same CLI.

## Connect your agent

Copy `application.example.py` to `application.py` and replace its imports with your own agent, scorer and cases. The module needs three exports.

| Export | Purpose |
| --- | --- |
| `cases` | A list of `{"caseId", "input", "expected"}` dictionaries, with optional `"repetitions"`. Case IDs are public. Inputs and expected answers stay private. |
| `execute(run)` | Runs your agent with `run.version`, the version under test, on `run.input`. Returns `ExecutionResult(output=..., usage=...)`. |
| `grade(run)` | Scores `run.output` against `run.expected`. Returns `GradeResult(reward=..., explanation=...)` with a reward between 0 and 1. |

Callbacks can be synchronous functions or coroutines. Return `ExecutionResult(output=..., execution_status="task_failed")` when the task fails but still produces output you can grade. Raise `ExecutionUncertainError` from `acclimate.evaluation` when external work might still be running.

The SDK fingerprints your cases, `application.py` and the local modules it imports. List files your agent reads at runtime, such as lockfiles, prompt templates and data, in `revision_files`. To keep cases out of the module, set `ACCLIMATE_EVALUATOR_CASES` to the absolute path of a JSON file with mode 0600.

## Check the setup

```sh
acclimate coverage
acclimate describe
acclimate doctor --config "$EVALUATOR_CONFIG" --bundle "$BUNDLE_ID" --policy quality-policy.json
```

`coverage` lists the files that make up the build identity. `describe` prints the public descriptor: revision hashes and case IDs, never inputs or expected answers. `doctor` checks the evaluator configuration and service access.

## Compare a change

Copy [quality-policy.example.json](quality-policy.example.json) to `quality-policy.json` and adjust it. The example requires the mean reward and each case's reward to hold steady or improve.

To compare a candidate from the console, paste the `describe` output, download the handoff file, and run:

```sh
acclimate compare --config "$EVALUATOR_CONFIG" --handoff "$HANDOFF" --policy quality-policy.json --live
```

To compare a candidate payload from your repository, give the run a stable name. Repeat the same command to recover it.

```sh
acclimate compare --config "$EVALUATOR_CONFIG" --bundle "$BUNDLE_ID" --channel stable \
  --payload candidate.json --name "$RUN_NAME" --policy quality-policy.json --live
acclimate status --config "$EVALUATOR_CONFIG" --name "$RUN_NAME"
acclimate check --config "$EVALUATOR_CONFIG" --name "$RUN_NAME" --policy quality-policy.json
acclimate export --config "$EVALUATOR_CONFIG" --name "$RUN_NAME" --out "$NEW_REVIEW_DIRECTORY"
```

`--live` authorizes both arms and their graders to run, including model costs and tool side effects. With a policy, `compare` and `check` exit 0 for pass, 2 for a violation and 3 when the evidence cannot decide.

## Other files

| File | Use |
| --- | --- |
| `acclimate_eval.py` | Runs the CLI against the `application.py` next to it, from any working directory: `python acclimate_eval.py describe`. |
| `async_eval.py` | Runs a whole evaluation from an asyncio application. Caller cancellation signals the worker and waits for it to stop. |
| `analyze.py` | Analyzes a saved comparison: `python analyze.py comparison.json descriptor.json binding.json [analysis-config.json]`. |
| `test/` | Tests for the async helper. Run `python -m unittest discover -s test`. |

The [evaluator CLI reference](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/evaluator-cli.mdx) and the [Python SDK reference](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/reference/python-sdk.mdx) cover every command and option.
