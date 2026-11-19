# Compare a change on your agent

Acclimate grades a change to your agent's instructions, skills, or approved memory against the version it replaces. Your evaluator calls your agent on both versions with the same saved tasks, passes each output to your grader, and reports the paired scores. Your application keeps the model, tools, and private task data. Terms such as *parent*, *candidate*, *handoff*, and *descriptor* are defined in the [glossary](../apps/docs/content/docs/concepts/glossary.mdx).

There are two ways in:

- **On your own laptop.** Compare locally with no server, then run the local stack. Start at [step 1](#1-install-the-sdk).
- **In a team's workspace.** Someone else runs the service and gives you access. Skip to [join a team](#join-a-team).

## 1. Install the SDK

Install the verified SDK in the environment that runs your agent. The TypeScript SDK needs Node 22.22+ and Python 3 with `fcntl`. The Python SDK needs Python 3.11+. Both need POSIX and a private persistent directory for the evaluator journal.

```sh
npm install --ignore-scripts /absolute/path/to/release/acclimate-sdk-0.1.0.tgz
# Or use Python 3.11+
python -m pip install --no-deps /absolute/path/to/release/acclimate_sdk-0.1.0-py3-none-any.whl
```

[Install the SDKs](../apps/docs/content/docs/get-started/install.mdx) · [Release metadata](../scripts/packaging/release-metadata.json)

## 2. Connect your app

Put `application.mjs`, `application.mts`, or `application.py` in your evaluator's working directory. Export three things:

- `cases` contains a public case ID, private input and expected result for each real task. Choose IDs that can appear in the console.
- `execute` calls your existing agent with the supplied pinned bundle and task input. Return its gradeable output and any measured usage.
- `grade` compares the output with the private expected result and returns a numeric reward.

Run `./node_modules/.bin/acclimate-eval coverage` or `python -m acclimate coverage` to see which application sources and declared files the SDK fingerprints alongside the cases. The coverage report is for local inspection and can include private paths. To use an existing app entry, pass `--app path/to/application.mjs` or `--app your_package.evaluator` in Python. Put deferred imports, lockfiles, prompts and runtime-read assets in `revisionFiles` (Python `revision_files`). Record remote model versions and tool settings in `runtime.settings` and external build digests in `runtime.artifacts`. Updating a covered input changes the descriptor. The [application examples](../examples/evaluation-starter/README.md) give both language signatures and show how to bind dependencies.

## 3. Try it with no server

Put the current instructions in one folder and your edit in another. Files under `skills/` become skill files, files under `memory/` become memory files, and every other file becomes an instruction. A payload JSON file such as `{"schemaVersion":1,"files":[{"path":"AGENTS.md","kind":"instruction","text":"..."}]}` also works. Check the adapter on one case, then compare the two versions:

```sh
./node_modules/.bin/acclimate-eval try --live --payload candidate
./node_modules/.bin/acclimate-eval compare --local --parent parent --candidate candidate --live
# Python: python -m acclimate try … and python -m acclimate compare --local …
```

Nothing is sent to a server. `try` runs `execute` and `grade` once and checks every returned shape. `compare --local` uses the same pairing and grading as a service comparison and writes an advisory `local-report.json` under `.acclimate/local/`. It is never release evidence. Omit `--live` when the adapter exports `execution` as `model-free`. [Local runs](../apps/docs/content/docs/reference/evaluator-cli.mdx#local-runs)

## 4. Run the local stack

From an Acclimate checkout with Docker running:

```sh
npm run local:up
source .local/stack/env.sh
```

`local:up` prints the console URL and a login, makes that login the administrator of the `local-demo` workspace, publishes an example bundle on `stable`, and writes `EVALUATOR_CONFIG`, `BUNDLE_ID`, and CA settings to `env.sh`. [Run Acclimate locally](../apps/docs/content/docs/get-started/run-locally.mdx)

## 5. Compare a change

Save the published version as a payload, edit it, and compare it with its parent. Give each change a name. Reusing the name resumes the original operation and rejects changed inputs.

```sh
./node_modules/.bin/acclimate-eval pull --config "$EVALUATOR_CONFIG" --bundle "$BUNDLE_ID" --out candidate.json
./node_modules/.bin/acclimate-eval compare --config "$EVALUATOR_CONFIG" \
  --bundle "$BUNDLE_ID" --channel stable --payload candidate.json \
  --name first-change --live
# Python: python -m acclimate pull … and python -m acclimate compare …
```

In a terminal the result identifies the versions and gives parent and candidate means, pair coverage and individual case scores. With `--json` or piped output it is one JSON object with the same fields. The change appears in the console under **Changes → Ready to review** with its name.

A named comparison prints its run handle. Use that handle to inspect the request, apply a policy, or export the recorded evidence:

```sh
python -m acclimate status --config "$EVALUATOR_CONFIG" --name first-change
python -m acclimate check --config "$EVALUATOR_CONFIG" --name first-change --policy quality-policy.json
python -m acclimate export --config "$EVALUATOR_CONFIG" --name first-change --out review
```

To require a non-decreasing mean reward and zero regression on each case, save this policy as `quality-policy.json` and pass `--policy quality-policy.json`:

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

The result tells you how many execution callbacks this invocation started and whether it reused saved evidence. Repeating a completed run returns its original scores. Keep the same evaluator identity and physical journal for recovery. If the process stopped during execution, inspect the original job and its external tasks. Status and heartbeats cannot confirm those tasks stopped.

To measure a fixed evaluator or collect another sample after a finished named run, repeat the compare command with `--retry-after first-change` and a new `--name`, such as `--name first-change-2`. Without `--name`, the CLI names the attempt `after-<request ID>`. The new attempt uses the same target and parent and the same candidate content, saved as a new candidate version. Repeat that exact command to recover it. Each run has at most one retry, and the console shows the earlier attempt under its retry. A completed, failed, interrupted or [abandoned](../apps/docs/content/docs/operate/evaluator-access.mdx#recover-a-cancelled-run) predecessor permits a successor; one that is still requested or running is refused. A different candidate change uses its own name.

`compare --policy` and `check --config` apply your policy locally and submit the verdict and policy digest to the workspace for release review. Check `policyReceipt.status` for `recorded`. If it is `unconfirmed`, retry `check` with the evaluator config and the same policy. A reader can apply their own policy using `check --read-config READER --handoff FILE --policy POLICY`; that returns `read_only` and sends no verdict. Neither checking nor exporting repeats the agent callbacks. Release approval is a separate decision. For pull requests, use the [CI integration](../examples/ci/README.md) to bind the evaluation to the expected Git commit.

## Join a team

When a team runs the service, the operator gives you an SDK release, a workspace login, and a private evaluator config for the workspace. The evaluator config identifies the service, workspace, machine principal and journal directory. An evaluator needs the `evaluate` right to read unpublished candidates and submit paired evidence. A workspace administrator issues an evaluator token under **Settings → Members → Evaluator tokens** and can download a ready `evaluator.json` there. Delivery and release use separate credentials. [Evaluator configuration and recovery](evaluator-operations.md)

From the application directory, print the evaluator's public descriptor with `./node_modules/.bin/acclimate-eval describe` or `python -m acclimate describe`. In the console, open the saved change, paste the descriptor under **Review release** and download the evaluation request. The CLI calls it a handoff. Run it in the same application environment:

```sh
./node_modules/.bin/acclimate-eval compare --config "$EVALUATOR_CONFIG" --handoff evaluation-request.json --live
# Or
python -m acclimate compare --config "$EVALUATOR_CONFIG" --handoff evaluation-request.json --live
```

[Join a team's workspace](../apps/docs/content/docs/get-started/join-a-team.mdx)

## Deliver content to jobs

For ordinary traffic, open **App setup** on your bundle and channel to configure the client. In JavaScript, `await client.prepare({ projectId, bundleId, channel: 'stable' })` returns the verified instructions, skill files and pinned version. Python exposes the same operation as `client.prepare(project_id, bundle_id, channel="stable")`. Keep the prepared files until the job finishes, save its pinned version with the result, then clean up. If your connection tracks jobs after release, configure reporting and save the startup record returned by `prepared.reportStarted()` (Python `prepared.report_started()`) when the job starts. The [native repository guide](../examples/native-repository/README.md) covers coding agents that need a writable workspace and frozen grading tests. To use outcomes for future proposals, use the [connected learning setup](../deploy/README.md#operate-connected-learning).
