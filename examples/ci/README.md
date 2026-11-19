# Gate pull requests on agent quality

This starter evaluates the agent files committed at one Git commit, compares them with the channel's current release using your installed evaluator, and fails the check when your quality policy fails. It never releases. A separate job with a separate credential releases after merge.

| File | Use |
| --- | --- |
| `ci.sh`, `ci.py` | The wrapper. It needs Git and Python 3.8 or later. |
| `action.yml` | A GitHub composite action around the wrapper. |
| `workflows/pr-check.yml` | A fork-safe `pull_request` workflow to copy. |
| `workflows/release.yml` | A post-merge job that releases the evaluated candidate with a separate credential. |

The full guide covers runner choice, credentials, cancellation, forks and releasing: [Run a pull request check](https://github.com/anveld-dev/acclimate/blob/main/apps/docs/content/docs/guides/ci-pr-check.mdx).

## Runner requirements

Use a **self-hosted runner with a persistent journal**: one host, a persistent owner-only POSIX volume (not NFS), and the same journal and output directory on every run. Then the wrapper reuses unchanged results across commits and resumes or replaces cancelled work.

Ephemeral runners, including GitHub-hosted ones, work in a degraded mode. Each attempt creates a fresh request and runs every case. Cancelled or lost attempts stay `running` until the service expires them. `actions/cache` can't carry the journal, because the journal is locked while in use and must stay on one host.

Never evaluate forked or otherwise untrusted pull requests on a self-hosted runner, and don't use `pull_request_target`. Keep `--live` off for code you don't trust.

## GitHub Action

```yaml
- uses: actions/checkout@v4
  with:
    persist-credentials: false
- id: gate
  uses: anveld-dev/acclimate/examples/ci@v0.2.0 # the first release with the action, or ./.github/actions/acclimate when vendored
  with:
    app: /opt/acclimate/evaluator
    policy: /opt/acclimate/evaluator/quality-policy.json
    bundle: ${{ vars.ACCLIMATE_BUNDLE_ID }}
    config-json: ${{ vars.ACCLIMATE_EVALUATOR_CONFIG }}
    token: ${{ secrets.ACCLIMATE_EVALUATE_TOKEN }}
    live: true
    comment: true
```

`config-json` holds the non-secret config fields `serviceUrl`, `projectId`, `evaluatorPrincipalId` and optionally `journalRoot` (default `~/.acclimate-ci/journal`). Alternatively, set `config` to a config file on the runner. The token comes from a secret, ideally a workspace evaluator token that holds only the `evaluate` right (**Settings → Members → Evaluator tokens**). The action writes a step summary and annotations, optionally keeps one PR comment up to date, and outputs `result`, `verdict`, `comparison-id`, `request-id`, `candidate-version-id`, `candidate-digest`, `parent-version-id`, `exit-code` and `summary-json`. See `action.yml` for every input.

## Wrapper

```sh
sh "$ACCLIMATE_CI/ci.sh" \
  --commit "$CI_EXPECTED_SHA" --bundle-dir agent --no-memory \
  --app "$EVALUATOR_APP" --policy "$EVALUATOR_APP/quality-policy.json" \
  --bundle "$BUNDLE_ID" --channel stable --config "$WORKER_CONFIG" --token-env ACCLIMATE_TOKEN \
  --output-dir "$PRIVATE_PR_STATE" --live
```

Run `sh ci.sh --help` for every option.

**Commit.** `--commit` is the full commit ID the check represents, and it must be checked out in `--repo` (default: the current directory). The wrapper reads the committed files, never the working tree. On GitHub `pull_request` events, `actions/checkout` checks out the test merge commit, `github.sha`. Pass that, or check out `pull_request.head.sha` and pass it. `--base-commit SHA` adds the list of bundle files changed since that commit to the summary.

**Bundle source.** Use a dedicated bundle directory with `--bundle-dir`. Files under `skills/` become skills, files under `memory/` are memory, and other files become instructions. When the directory contains memory, repeat `--memory memory/approved-fact.md` for the approved files, or pass `--no-memory`. For a committed bundle payload, use `--payload agent/bundle.json` instead.

**Evaluator.** Point `--app` at the trusted evaluator directory with its SDK installed. For `application.mjs` or `application.mts`, the wrapper runs the installed `acclimate-eval`. For `application.py`, it runs `python -m acclimate` with the app's `.venv/bin/python` when present, otherwise `ACCLIMATE_CI_PYTHON` or the interpreter running the wrapper. Python evaluators need Python 3.11 or later, and the wrapper says so instead of failing with an import error. If the directory contains both languages, pass `--language`. An executable JavaScript or Python CLI file also works as `--app`.

**Parent.** The parent is the channel's current release. A channel with no release fails with `request.channel_empty`. Publish a baseline release first.

**Credentials.** `--config` is an owner-only evaluator config. With `--token-env NAME` or `--token-file FILE` (mode 0600), the config may omit `evaluatorToken`. The token never lands in a config file: the wrapper writes a temporary, token-free owner-only copy of the config inside the output directory, deletes it when the run ends, and passes the token to each evaluator process in `ACCLIMATE_EVALUATOR_TOKEN`. A config can also name its own `evaluatorTokenFile`. The token needs the `evaluate` right, which covers request creation, runs, policy receipts and `--abandon-uncertain`. The config, policy and selection paths resolve from the directory where you launch the wrapper.

**Cost and time.** `--deadline`, `--case-timeout`, `--max-cost-usd`, `--shard` and `--cases` are passed to the evaluator's `run` command under the same names. A run they stop early, or a case subset, is partial evidence: the run exits 3 and the summary reports `execution_partial` unless the policy already fails. Concurrency is not a run flag; declare `concurrency` in the evaluator definition, where it is part of the descriptor. Also set a CI job timeout.

**Reuse.** The wrapper reuses a request when the bundle content, the channel's release, the evaluator descriptor and the selected cases are unchanged, even across commits. It reads the channel with the evaluator token to decide. When it can't, or with `--no-reuse`, it keeps one request per commit. The summary's `reuse` field records the decision and, when reused, the commit that created the request.

## Cancellation

On `SIGINT`, `SIGTERM` or `SIGHUP`, the wrapper forwards the signal to the evaluator's process group, so the evaluator stops starting cases and closes the request with the cases it finished. If the evaluator is still running after `--cancel-grace` seconds (default 20), or 1.5 seconds after a second signal, the wrapper kills the process group. Nothing is orphaned or left holding the journal. It then prints the summary with `result: cancelled` and exits with 128 plus the signal number: 130 for `SIGINT` and 143 for `SIGTERM`.

GitHub's `cancel-in-progress` sends `SIGINT`, `SIGTERM` 7.5 seconds later, and kills the step 2.5 seconds after that. The second signal makes the wrapper stop the evaluator before GitHub kills the step.

A cancelled run isn't a verdict. Running the same command again for that commit starts a fresh request. If the evaluator had to be killed mid-execution, the next run reports `execution_unresolved`. Either wait until the service marks the attempt `abandoned` after its inactivity timeout, or pass `--abandon-uncertain` to abandon it now through the service and start a fresh request.

## Output

By default, stdout is one JSON object, and stderr carries the evaluator's output.

| Option | Output |
| --- | --- |
| `--format json` | One JSON summary on stdout (default). |
| `--format github` | Log lines and workflow annotations on stdout. `::error` lines name failed criteria and regressed cases, and `::warning` lines name cases with missing evidence. The evaluator's output is grouped by phase and fenced with `::stop-commands::`, so it can't issue workflow commands. |
| `--format markdown` | A Markdown summary on stdout, for a PR comment. |
| `--summary-json FILE` | The JSON summary, also written to a file. |
| `--summary-md FILE` | Append the Markdown summary, for example to `$GITHUB_STEP_SUMMARY`. Repeatable. |
| `--github-output FILE` | Append `result`, `exit-code`, `verdict`, `comparison-id`, `request-id`, `candidate-version-id`, `candidate-digest` and `parent-version-id` lines, for example to `$GITHUB_OUTPUT`. |

The summary contains:

- `result` and `exitCode`, always, including after a configuration error or a cancellation.
- the verified `commit`, the `channel`, and when request creation succeeds, `requestId`, `parentVersionId`, `candidateVersionId`, `candidateDigest` and `handoff` (relative to the output directory).
- `executionStatus`, `comparisonId`, `qualityVerdict` and `quality`. `quality` holds the bound policy, case and pair counts (`counts.incompletePairs` is the number of pairs without a comparable score), mean scores, `failedCriteria`, `unknownCriteria`, `regressedCases` and `criteriaCases` when the evaluator reports them, `evidenceGaps`, and `policyReceipt`.
- `failedPhase`, `diagnosticCode`, `failedChecks`, `hint` and `nextAction` for a failure in any phase. A preflight failure lists each failed check, such as `serviceIdentity` with `service.unavailable`.
- `phaseExitCodes`, with each phase's exit code or `null` when skipped, and `reviewDirectory` after a verified export.
- `reuse`, `cancellation`, `changedFiles`, `reconciled` and `previous*` fields when they apply.

| Result | Exit | CI action |
| --- | --- | --- |
| `pass` | 0 | Mark the check successful and associate the commit with its candidate. |
| `quality_failed` | 2 | Show the verdict and evidence to the PR author. |
| `quality_indeterminate` | 3 | The policy could not decide, for example too few cases for its confidence bound. Show the evidence gaps. |
| `execution_partial` | 3 | The run stopped at `--deadline` or `--max-cost-usd`, or covered only `--cases` or `--shard`. Rerun with a larger budget or the full inventory. |
| `execution_failed` | 4 (1 for a command or config error) | Show the diagnostic to the evaluation owner. Use `--rerun-after` after a repair. |
| `execution_unresolved`, `prior_execution_unresolved` | 5 | Wait for the service to mark the earlier attempt abandoned, or pass `--abandon-uncertain`. |
| `prior_status_unavailable` | 1 or 4 | Check the credential and service, then rerun. |
| `cancelled` | 130, 143 | Rerun. |
| `preflight_failed`, `request_failed`, `check_failed`, `export_failed`, `configuration_error`, `wrapper_error` | 1, 3, 4 or 5 | Fix the reported diagnostic and rerun. |

The exit codes follow the [evaluator CLI](../../apps/docs/content/docs/reference/evaluator-cli.mdx#errors-and-exit-codes): 0 ok, 1 fix the command, config or application, 2 quality gate failed, 3 indeterminate, 4 run or service failed, 5 recovery required. Route on `result` for the detail. After a failed execution that still bound a comparison, the wrapper applies the policy to capture its verdict.

## Rerun the same commit

Rerunning the same command recovers the existing request or its saved result. Interrupted requests, requests the service or a caller abandoned, and cancelled runs are followed by a fresh request automatically.

A changed evaluator descriptor already gets a new request. To deliberately run the same commit again with an unchanged evaluator, for example after an infrastructure failure, repeat the command with the previous summary's handoff:

```sh
--rerun-after "$(jq -r '.priorHandoff // .handoff' previous-result.json)"
```

The wrapper checks that the handoff belongs to this commit, source, target, release and evaluator, then reads the request's service state. A completed or failed request with a bound comparison, or an interrupted or abandoned request, permits one successor. A `requested` or `running` request is interrupted for you when this host's journal shows execution never started. Otherwise the wrapper stops unless you pass `--abandon-uncertain`, which abandons it through the service's abandon route. The successor compares against the channel's current release. Repeating the command resumes the successor, and later plain runs follow it.

`--retry-after` is a deprecated spelling of `--rerun-after`. Unlike `compare --retry-after`, which keeps the original parent, the wrapper always compares against the current release.

To manage your own request intent, pass its absolute path with `--intent` and keep its output directory. `--intent` disables reuse and automatic successors.

## Reviews, retention and cleanup

After each run, the wrapper exports review evidence once per request to `reviews/REQUEST_ID` (with a selection digest suffix when `--selection` is used) and verifies it. Upload only the verified `reviewDirectory`, using your CI provider's access controls and retention, and then delete it. For selected app artifacts, supply `--selection "$EVALUATOR_APP/share-selection.json"` and install a review mapper.

`requests/` holds one directory per candidate, release and evaluator. Delete directories you no longer need to reuse or recover, for example with `find "$OUTPUT/requests" -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {} +`. The journal, config, private request intent and case inventory stay on the worker.

## Release after merge

An authorized reviewer, or the job in `workflows/release.yml`, releases the evaluated candidate with the operator CLI from the SDK:

```sh
acclimate-operator promote --project "$PROJECT" --bundle "$BUNDLE" --channel stable \
  --version "$CANDIDATE" --comparison "$COMPARISON" --expected-revision "$REVISION"
```

Give that job its own releasing credential in a protected environment. The PR check's credential needs only evaluate rights.
