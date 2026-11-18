# Compare a change on your agent

Use a real task your agent handles today. The SDK calls your agent on both the published parent and saved candidate, passes each output to your grader, and records the paired results in your workspace. Your application owns the model, tools and private task data.

## 1. Obtain a release and choose a language

Ask your workspace operator for the SDK release, checksums and a private evaluator config for the target workspace. Install the verified SDK in the environment that runs your agent.

```sh
npm install --ignore-scripts /absolute/path/to/release/acclimate-sdk-0.1.0.tgz
# Or use Python 3.11+
python -m pip install --no-deps /absolute/path/to/release/acclimate_sdk-0.1.0-py3-none-any.whl
```

The JavaScript evaluator requires Node 22.22+ and Python 3 with `fcntl`. Both workers require POSIX and private persistent storage. [Release metadata](../scripts/packaging/release-metadata.json)

## 2. Connect your app

Put `application.mjs`, `application.mts`, or `application.py` in your evaluator's working directory. Export three things:

- `cases` contains a public case ID, private input and expected result for each real task. Choose IDs that can appear in the console.
- `execute` calls your existing agent with the supplied pinned bundle and task input. Return its gradeable output and any measured usage.
- `grade` compares the output with the private expected result and returns a numeric reward.

Run `./node_modules/.bin/acclimate-eval coverage` or `python -m acclimate coverage` to see which application sources and declared files the SDK fingerprints alongside the cases. The coverage report is for local inspection and can include private paths. To use an existing app entry, pass `--app path/to/application.mjs` or `--app your_package.evaluator` in Python. Put deferred imports, lockfiles, prompts and runtime-read assets in `revisionFiles` (Python `revision_files`). Record remote model versions and tool settings in `runtime.settings` and external build digests in `runtime.artifacts`. Updating a covered input changes the descriptor. The [application examples](../examples/evaluation-starter/README.md) give both language signatures and show how to bind dependencies.

For ordinary traffic, open **App setup** on your bundle and channel to configure the client. In JavaScript, `await client.prepare({ projectId, bundleId, channel: 'stable' })` returns the verified instructions, skill files and pinned version. Python exposes the same operation as `client.prepare(project_id, bundle_id, channel="stable")`. Keep the prepared files until the job finishes, save its pinned version with the result, then clean up. If your connection tracks jobs after release, configure reporting and save the startup record returned by `prepared.reportStarted()` (Python `prepared.report_started()`) when the job starts. The [native repository guide](../examples/native-repository/README.md) covers coding agents that need a writable workspace and frozen grading tests.

## 3. Obtain evaluator access before creating a request

The operator supplies `EVALUATOR_CONFIG`, a private file that identifies the service, workspace, machine principal and journal directory. An evaluator needs workspace read/write access to read unpublished candidates and submit paired evidence. Delivery and release use separate credentials. [Evaluator configuration and recovery](evaluator-operations.md)

## 4. Compare the change

From the application directory, describe the installed evaluator using `./node_modules/.bin/acclimate-eval describe` or `python -m acclimate describe`. In the console, save your candidate, paste the public descriptor under evaluation and download the request. Execute it in the same application environment:

```sh
./node_modules/.bin/acclimate-eval compare --config "$EVALUATOR_CONFIG" --handoff evaluation-request.json --live
# Or
python -m acclimate compare --config "$EVALUATOR_CONFIG" --handoff evaluation-request.json --live
```

The result identifies the versions and gives parent and candidate means, paired case coverage and individual case scores. To require a non-decreasing mean reward and zero regression on each case, save this policy as `quality-policy.json` and pass `--policy quality-policy.json`:

```json
{
  "schemaVersion": 1,
  "id": "no-regression",
  "revision": "1",
  "metric": { "name": "task reward", "unit": "reward", "direction": "higher" },
  "aggregation": "equal-case-means",
  "minimumMeanImprovement": 0,
  "maximumCaseRegression": 0,
  "requiredCases": []
}
```

Edit the thresholds, direction and required case IDs for your tasks. A required cost that the agent cannot measure yields an indeterminate verdict. The starter includes an [editable policy file](../examples/evaluation-starter/quality-policy.example.json).

**Working entirely from the command line?** Pass a bundle, channel and candidate payload in place of the downloaded request. Give each change a name. Reusing the name resumes the original operation and rejects changed inputs.

```sh
python -m acclimate compare --config "$EVALUATOR_CONFIG" \
  --bundle "$BUNDLE_ID" --channel stable --payload agent/bundle.json \
  --name "$CHANGE_ID" --live
```

A named comparison prints its run handle. Use that handle to inspect the request, apply a different policy, or export the recorded evidence:

```sh
python -m acclimate status --config "$EVALUATOR_CONFIG" --name "$CHANGE_ID"
python -m acclimate check --config "$EVALUATOR_CONFIG" --name "$CHANGE_ID" --policy quality-policy.json
python -m acclimate export --config "$EVALUATOR_CONFIG" --name "$CHANGE_ID" --out review
```

The result tells you how many execution callbacks this invocation started and whether it reused saved evidence. Repeating a completed run returns its original scores. Keep the same evaluator identity and physical journal for recovery. If the process stopped during execution, inspect the original job and its external tasks. Status and heartbeats cannot confirm those tasks stopped.

To measure a fixed evaluator or collect another sample after a completed or failed named run, repeat the headless compare command with `--retry-after "$CHANGE_ID"` in place of `--name "$CHANGE_ID"`. This starts a fresh pair against the same target, parent and candidate content. Repeat that exact command to recover its single successor. It refuses an unresolved or interrupted predecessor. A different candidate change uses its own name.

`compare --policy` and `check --config` apply your policy locally and submit the verdict and policy digest to the workspace for release review. Check `policyReceipt.status` for `recorded`. If it is `unconfirmed`, retry `check` with the evaluator config and the same policy. A reader can apply their own policy using `check --read-config READER --handoff FILE --policy POLICY`; that returns `read_only` and sends no verdict. Neither checking nor exporting repeats the agent callbacks. Release approval is a separate decision. For pull requests, use the [CI integration](../examples/ci/README.md) to bind the evaluation to the expected Git commit. To use outcomes for future proposals, use the [connected learning setup](../deploy/README.md#operate-connected-learning).
