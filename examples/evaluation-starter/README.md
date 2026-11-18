# Evaluate your installed agent

This entry point calls your application's agent and independent grader on the parent and candidate bundles in an Acclimate evaluation request. Add one application module with three exports: the cases to run, the agent call, and the grader.

## Install and bind the application

Install the SDK into your existing application or evaluator image. The package includes the CLI. JavaScript needs Node 22.22+ and Python 3 with fcntl for durable worker locks. Python needs 3.11+. Both runners use POSIX and persistent local journal storage.

```sh
npm install --offline --ignore-scripts /absolute/path/to/release/acclimate-sdk-0.1.0.tgz
# Or for Python
python3.11 -m pip install --no-index --no-deps /absolute/path/to/release/acclimate_sdk-0.1.0-py3-none-any.whl
```

Put `application.mjs` or `application.mts` in your Node app directory, or `application.py` in your Python app directory. Run the CLI there. Import your existing agent, scorer and cases. Use modules that only start work when their callbacks are called.

```js
// application.mjs
import { runAgent, scoreResult, savedCases } from './dist/support-agent.mjs';

export const cases = savedCases;
export const revisionFiles = ['package-lock.json'];

export async function execute({ bundle, input, signal, context }) {
  const result = await runAgent({ bundle, task: input, signal, job: context });
  return { output: result.answer, usage: result.measuredUsage };
}

export async function grade({ output, expected }) {
  return scoreResult(output, expected); // { reward, explanation? }
}
```

```python
# application.py
from acclimate.evaluation import ExecutionResult, GradeResult
from support_agent import run_agent, score_result, saved_cases

cases = saved_cases
revision_files = ["support_agent.py", "requirements.lock"]

async def execute(run):
    result = await run_agent(bundle=run.bundle, task=run.input, cancellation=run.cancellation)
    return ExecutionResult(output=result.answer, usage=result.measured_usage)

def grade(run):
    verdict = score_result(run.output, run.expected)
    return GradeResult(reward=verdict.reward, explanation=verdict.explanation)
```

Each saved case has a unique public `caseId`, private `input` and private `expected`, plus optional `repetitions`. The application decides how the pinned instructions, skills and approved memory reach its own loop. Use a fresh isolated workspace for each arm when tools have side effects.

The SDK hashes your cases, application module and local source imports reached at startup. Run `acclimate-eval coverage` or `python -m acclimate coverage` to inspect that inventory locally. Node reports `packageImports` separately so you can identify package builds that need explicit revisions. Add package builds, deferred imports, lockfiles and runtime-read assets in `revisionFiles` (Python `revision_files`). These paths resolve relative to the application module. Their names and contents contribute to the build and default grader revisions. Changing any declared file invalidates an older handoff. For external services, you can also export `runtime` with `settings` (model deployment or tool configuration) and `artifacts` (named build digests), or `grader = {artifactDigest: graderDigest}` for a separately versioned grader. Only the revision hashes and case IDs appear in the public descriptor.

Supply plain bounded JSON as the gradeable output. Map SDK response objects to the fields your grader needs. `usage` accepts measured `inputTokens`, `outputTokens` and `costUsd`. Omit fields you cannot measure. The cost policy reports unknown when it requires a missing measurement. Return `executionStatus: 'task_failed'` (Python `execution_status="task_failed"`) for a failed task with gradeable output. Await the actual tool, stream or background job through termination and preserve its inputs if termination is uncertain. The SDK provides `ExecutionUncertainError` for that case.

Python accepts synchronous and coroutine callbacks. The worker keeps one asyncio loop for all coroutine callbacks during a CLI invocation. Create loop-bound clients on that loop and await their work. To embed the synchronous evaluator lifetime in an existing async application, await `async_eval.run_evaluation_async(config_path=..., handoff=..., allow_live=True)`. Caller cancellation signals the worker and waits for it to finish. Your callback can observe `run.cancellation` while waiting on external work.

TypeScript apps can implement `application.mts` with erasable types and run the same Node CLI directly. Import `ApplicationAdapter` from `@acclimate/sdk/evaluation` as a type for the callback signatures. The source loader resolves relative NodeNext imports such as `./agent.js` to `agent.ts` when the emitted file is absent. To run a compiled build or select a module outside the current directory, use `acclimate-eval describe --app dist/application.mjs` and pass the same `--app` to compare. Revision files resolve relative to that module. When both files exist, the CLI uses `application.mjs`. Run a fresh CLI process after rebuilding an imported dependency so the language runtime loads the new code.

## Describe and run

Invoke `acclimate-eval` from an npm script, or use `npm exec --offline -- acclimate-eval` from the shell. The optional starter archive provides adjacent-file entry points, an asyncio embedding helper and analysis scripts.

```sh
acclimate-eval describe
acclimate-eval doctor --config "$EVALUATOR_CONFIG" --bundle "$BUNDLE_ID" --policy "$QUALITY_POLICY"
```

To keep cases in a separate JSON file, set `ACCLIMATE_EVALUATOR_CASES` to its absolute path and give it mode 0600. This array overrides the module's cases. Only the grader receives the expected answer.

Use `python -m acclimate` in your Python environment. Ask the service operator for the evaluator's project read/write principal and private configuration file. Keep its service URL, principal and canonical journal root stable across retries. Copy [quality-policy.example.json](quality-policy.example.json) to `quality-policy.json` and edit it for your application. The example checks that both the equal-case mean and each case reward hold steady or improve. List release-critical case IDs in `requiredCases`. Add a measured cost ceiling with `"cost": {"maximumCandidateUsd": 1}` if that is your budget. Pass the edited file explicitly with `--policy`.

From the console, select your saved immutable candidate, paste the public `describe` output and download its handoff. Run the comparison and apply your policy with one command:

```sh
acclimate-eval compare --config "$EVALUATOR_CONFIG" --handoff "$HANDOFF" --policy "$QUALITY_POLICY" --live
```

To compare a full candidate bundle payload directly from your repository, give the change a stable name. Repeat the same command and name when recovering this run. Choose a new name for a different change.

```sh
acclimate-eval compare --config "$EVALUATOR_CONFIG" --bundle "$BUNDLE_ID" --channel "$CHANNEL" --payload "$CANDIDATE_PAYLOAD" --name "$RUN_NAME" --policy "$QUALITY_POLICY" --live
```

The terminal prints `--name RUN_NAME` and whether callbacks ran this time. The JSON fields `runName`, `invocation.callbacksStarted` and `invocation.reusedEvidence` expose the same facts. Use the name with your private evaluator config for follow-up commands:

```sh
acclimate-eval status --config "$EVALUATOR_CONFIG" --name "$RUN_NAME"
acclimate-eval check --config "$EVALUATOR_CONFIG" --name "$RUN_NAME" --policy "$QUALITY_POLICY"
acclimate-eval export --config "$EVALUATOR_CONFIG" --name "$RUN_NAME" --out "$NEW_REVIEW_DIRECTORY"
```

For another machine or a read-only reviewer, share the public handoff at `comparisons/RUN_NAME/request.json` inside the evaluator's configured journal root. Copy that one JSON file and use `--handoff` with the reviewer's credentials.

Omit `--policy` when you only need paired evidence. `--live` authorizes both evaluation arms and their graders, including provider costs and tool side effects. For separately scheduled stages, the same CLI provides `request`, `run` and `check`. A complete comparison can contain a losing candidate. An authorized release reviewer decides whether to promote the change.

## Review evidence and recover

With a policy, `compare` and `check` exit 0 for pass, 2 for a known violation,
and 3 for an indeterminate decision. A known threshold violation still fails
when required cost measurements are missing. Inspect the individual checks for
both conditions. In JSON output, `evidenceGaps` identifies each affected case,
repetition, arm and stage, up to 32 entries with the total count. Complete cases
retain their scores when another case is incomplete.

A policy check with `--config` computes the verdict locally and records a receipt for release review. A passing policy returns exit 0 only when the service confirms that receipt. If `policyReceipt.status` is `unconfirmed`, retry `check` with the same evaluator config and policy. A reviewer can use `--read-config` with a public handoff to compute an independent verdict. Its receipt status is `read_only`.

To debug an unexpected agent or grader exception, set `"captureCallbackErrors": true`
in the private evaluator configuration before execution. Inspect `callback-error.json`
in the affected arm's private job directory for the phase, exception type, and up to
eight stack frame locations. The public comparison identifies the stage and reason
through `evidenceGaps`. Private diagnostics omit exception messages and local variables.

To deliberately rerun the same candidate after a completed or failed comparison, substitute `--retry-after "$RUN_NAME"` for `--name "$RUN_NAME"` in the headless compare command. The SDK verifies the original target, candidate payload and channel base, then creates one new run under a name derived from the prior request ID. The new attempt can use a repaired adapter, different case set or different policy. Repeat the same command to recover that successor. For policy-only changes, `check` can score the retained evidence without any new execution. Requests still marked requested, running or interrupted cannot serve as predecessors.

Keep the service request ID, app build, private case inventory and journal for the attempt. Use the same version of the application and journal to recover a sealed report after transport failure. If execution might still be running, inspect the original worker before interrupting or starting new work.

Export scalar evidence to a fresh private directory. To share selected outputs or grader explanations, implement a field-allowlisting `toReviewArtifact` (Python `to_review_artifact`) in your own adapter and pass a `--selection` file naming the desired case, repetition, side and role.

```sh
acclimate-eval export --config "$EVALUATOR_CONFIG" --handoff "$HANDOFF" --out "$NEW_REVIEW_DIRECTORY"
acclimate-eval verify-export --manifest "$NEW_REVIEW_DIRECTORY/manifest.json"
```

A teammate can run `acclimate-eval verify-export --manifest review/manifest.json` in the directory containing the downloaded review. The installed CLI also supports `status --read-config READER --handoff HANDOFF` independently of the agent module.

The companion [analysis guide](ANALYSIS.md) covers saved comparison evidence, named metrics, binding verification and repeated executions.
