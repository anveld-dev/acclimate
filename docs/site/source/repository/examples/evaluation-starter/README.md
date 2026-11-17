# Evaluate a change in your application

This is an installed-app starter. It imports the published SDK interfaces; no file imports Acclimate's checkout. Its default agent is an in-memory payment-retry simulator. The grader independently checks the task result (one charge and a successful response). This verifies deterministic application wiring, not native agent quality.

## Install and try without a service

Obtain the versioned release and checksums from your operator. Install its SDK tarball in this directory:

```sh
npm install --offline --ignore-scripts /your/release/acclimate-sdk-0.1.0.tgz
node trial.mjs
node acclimate-eval.mjs describe
```

Node >=22.22 is required. The offline trial records no service data, requires no identity provider/model credentials, and produces no promotable evidence. It prints simulated parent reward 0.5 and candidate reward 1. The `describe` command prints only the installed evaluator's public configuration; task inputs and expected answers remain local.

For Python >=3.11, install the matching wheel:

```sh
python3.11 -m pip install --no-index --no-deps /your/release/acclimate_sdk-0.1.0-py3-none-any.whl
python3.11 trial.py
python3.11 acclimate_eval.py describe
```

The Python SDK requires no Node or third-party runtime dependencies. Durable execution in either language requires POSIX and private local persistent storage. The TypeScript evaluator additionally uses `python3` with `fcntl` for kernel ownership locks.

`async_eval.py` supplies a complete asyncio integration with the same explicit config/handoff flags. It offloads the whole synchronous lifetime, signals a threading cancellation event, and shields/drains its private worker through repeated caller cancellation. The caller receives CancelledError only after the actual worker settles. A forced process/event-loop teardown leaves uncertain work for inspection; it does not authorize cleanup. The included two-cancellation test keeps a real file and kernel lock until the worker confirms completion.

To use the optional TypeScript source, copy `typescript/acclimate-eval.ts.template` to `typescript/acclimate-eval.ts` and `typescript/agent.ts.template` to `typescript/agent.ts`, use TypeScript **5.9.3** and `@types/node` **22.20.5** in your existing build, and compile with `tsc -p typescript/tsconfig.json`. Its emitted entry point is `typescript/dist/acclimate-eval.js`. Plain JavaScript above needs neither compiler nor an implicit `npx` download.

## Connect your actual agent

Replace `runExistingAgent` in `agent.mjs`/`agent.py` with your existing agent call. It receives the verified immutable version, task input and cancellation notification. Attach the instruction and approved memory explicitly; expose skill/reference paths through the app's own tools or selected native plugin. Await actual quiescence and retain outputs before prepared-file cleanup. If external work may still be running, signal `ExecutionUncertainError` and preserve its workspace; canceling a promise or thread await is not proof of stopped execution.

Change the definition's config/build, dataset and grader revisions for your app and mark `execution:'live'` when paid/model work is possible. Your application owns model credentials, tools, network policy, budgets and runtime. Live definitions require the explicit `--live` flag. Keep expected answers out of agent inputs; the independent grader receives them only after execution. For a coding repository, use the separately distributed native-repository starter and its persistent-workspace/context rules.

## First console-created evaluation

You need an existing workspace/bundle/channel, a saved immutable candidate, and a separate evaluator principal with project read/write access. Connections' content-read credential cannot read unpublished candidates or execute evaluations. Your service operator provisions the evaluator; broad project write is currently required, and static grant changes require a coordinated restart. No promote right is required.

Create an owner-only config file (0600) in a private canonical directory (0700), outside version control. It contains schemaVersion 1, serviceUrl, projectId, evaluatorPrincipalId, evaluatorToken and an absolute fixed journalRoot. Receive the token through your secret manager; never paste it into a command, console, log or this starter. The evaluator reads only the explicitly selected file. Public HTTPS is required; explicit same-host loopback HTTP is supported for private fixture/development hops.

```sh
node acclimate-eval.mjs doctor --config /absolute/private/config/evaluator.json --bundle YOUR_BUNDLE_UUID --policy quality-policy.json
```

Paste `describe` output into the console's “My app's evaluator” configuration, create the request for your saved candidate, and download its public handoff as `evaluation-request.json`. Then:

```sh
node acclimate-eval.mjs doctor --config /absolute/private/config/evaluator.json --handoff evaluation-request.json
node acclimate-eval.mjs run --config /absolute/private/config/evaluator.json --handoff evaluation-request.json
node acclimate-eval.mjs check --config /absolute/private/config/evaluator.json --handoff evaluation-request.json --policy quality-policy.json
```

Python uses the same arguments with `python3.11 acclimate_eval.py`. Preflight may create a private probe directory but never starts callbacks, mutates service data or calls a model. A capability snapshot is not a reservation or proof of provider readiness.

## Headless candidate and request creation

The `request` command freezes a fresh channel baseline, creates a durable draft/candidate, and creates its bound evaluation request. Keep the private intent at a stable canonical location for retries:

```sh
node acclimate-eval.mjs request --config /absolute/private/config/evaluator.json --bundle YOUR_BUNDLE_UUID --channel stable --payload candidate.json --intent /absolute/private/ci-intent.json --out evaluation-request.json
```

Retry the identical command to recover original creation outcomes. Changed payload, app definition or target requires explicit new intent. A channel conflict never silently rebases. Already committed requests remain pinned to their original baseline. No command automatically releases a channel. An unused draft can later be reviewed/discarded using the existing workspace/operator workflow.

## Review and share one failed case

The checked-in mapper shares only deliberate task-result fields. The selection requests candidate output and grader explanation for `lost-response`; change it consciously for your app. Original reports and journal files never move into the export.

```sh
node acclimate-eval.mjs export --config /absolute/private/config/evaluator.json --handoff evaluation-request.json --selection share-selection.json --out /absolute/private/new-review-export
node acclimate-eval.mjs verify-export --manifest /absolute/private/new-review-export/manifest.json
```

Omit `--selection` for scalar-only evidence with no raw outputs. A missing required role prevents a complete manifest. Upload only the final export directory through your organization's authenticated artifact storage with explicit retention. Never upload its parent, evaluator config, journal, expected answers or provider credentials.

A teammate with project-read access can verify scalar binding using their own private reader file `{schemaVersion:1,serviceUrl,projectId,readToken}` and an independently selected expected request:

```sh
node acclimate-eval.mjs verify-export --manifest /downloaded/review/manifest.json --read-config /absolute/private/reader.json --handoff independently-selected-request.json
```

Local hash consistency is not provenance; online verification matches authoritative scalars, not proof that redacted outputs are true execution traces.

## Analyze named metrics and repeated executions

The archive includes `analyze.mjs`, `analyze.py` and the complete
[analysis guide](ANALYSIS.md). After installing the matching SDK, analyze saved
comparison evidence with a separately retained trusted binding:

```sh
node analyze.mjs comparison.json descriptor.json trusted-binding.json analysis-config.json
python3.11 analyze.py comparison.json descriptor.json trusted-binding.json analysis-config.json
```

Omit `analysis-config.json` for descriptive scalar reward. The optional config
supplies named component metrics, explicit units/direction and app-retained
observations bound to the exact case/version/grader. Each case receives equal
weight regardless of repetition count. The guide explains missingness and the
opt-in paired bootstrap for independently collected stochastic repetitions on
fixed tasks. This starter's deterministic simulator uses descriptive mode; its
repeats do not support stochastic confidence or automatic release.

## CI and recovery meanings

`run` returns 0 for completed evidence (including a losing candidate), 2 for failed/incomplete evidence and 3 for interruption/uncertain recovery. `check` returns 0 for policy pass, 2 for a complete quality violation and 3 for incomplete/unknown evidence; invalid input/policy/access returns 1. A policy pass is descriptive and never release authorization. The policy labels its direction and equal weighting across distinct cases; it makes no statistical-confidence claim.

Keep journal root, exact service URL, principal and originating language/release stable. Saved reports recover with the same bytes/keys and no callback rerun. Execution marked started without a sealed report is uncertain: inspect the original worker, explicitly interrupt when appropriate, then create new work only after safe app review. Never delete a journal, move it, switch languages or infer stopped execution from age. Private journals require their own backup/retention policy; PostgreSQL backups alone do not preserve worker files.

The CI starter archive provides a provider-neutral script and workflow integration guidance. The release manifest records exactly which installed-consumer checks actually ran; no live/native-quality claim follows from this fixture.
