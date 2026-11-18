# Run an agent evaluation for a pull request

From the PR checkout, point CI at the directory containing your bundle's source files and the trusted evaluator installed on the worker.

```sh
sh "$ACCLIMATE_CI/ci.sh" \
  --commit "$CI_EXPECTED_SHA" --bundle-dir agent \
  --app "$EVALUATOR_APP" --policy "$EVALUATOR_APP/quality-policy.json" \
  --bundle "$BUNDLE_ID" --channel stable --config "$WORKER_CONFIG" \
  --output-dir "$PRIVATE_PR_STATE" --live
```

Set `CI_EXPECTED_SHA` from the CI event to the full commit ID the check represents. If the job checks a merge commit, check out that merge commit and pass its SHA. The wrapper verifies HEAD and reads the exact committed files. It can run from a different directory with `--repo "$PR_CHECKOUT"`.

Use a dedicated bundle directory. Relative paths are preserved. Files under `skills/` become skill files and other files outside `memory/` become instructions. When the directory contains memory, repeat `--memory memory/approved-fact.md` for the files approved for this candidate, or pass `--no-memory`. The evaluator still owns the choice of memory to apply to an individual job. For a repository that already stores a complete bundle payload, replace `--bundle-dir agent` with `--payload agent/bundle.json`.

Point `--app` at the trusted evaluator directory with its SDK installed. For `application.mjs` or `application.mts`, CI invokes the application or workspace's installed `acclimate-eval`. For `application.py`, CI invokes `python -m acclimate`. Both run inside that directory. If it contains both languages, select `--language javascript` or `--language python`. Existing executable JavaScript and Python CLI files are supported as `--app` entries.

Keep the evaluator's agent, grader and private cases installed there. Git and Python 3 are required for the CI wrapper. Python evaluators require 3.11+. Set `ACCLIMATE_CI_PYTHON` to select a specific interpreter. Otherwise a Python app uses its own `.venv/bin/python` when present or the interpreter running the wrapper, including an activated virtual environment. The config, policy and optional selection paths resolve from the directory where you launch CI. Pass `--live` for model-backed execution.

Use a private persistent output directory and an owner-only evaluator config with a project-scoped credential and stable journal. By default the wrapper stores the request intent and handoff together under `requests/` inside that directory. A retry with the same commit, target and candidate reuses its intent. A new commit or different candidate receives a separate path. If your pipeline manages an existing intent, supply its absolute path with `--intent` and keep its original output directory. A new runner without the original journal needs an operator to reconcile uncertain work before scheduling another attempt.

### Rerun after repairing a terminal evaluation

Use the same command to recover an interrupted CI process or read its saved result. If you change the evaluator code or case definition for the same PR commit, the old intent belongs to the original evaluator. A mismatch reports the original `priorHandoff` and lifecycle state when available. To deliberately evaluate the repaired build, repeat the command with one additional option:

```sh
--retry-after "$(jq -r '.priorHandoff // .handoff' previous-result.json)"
```

Use the original private output directory. CI verifies the predecessor belongs to this commit, source and target and reads its current service state. A completed or failed request with a bound attempt and comparison permits one successor. A new request pins the current channel baseline. Its `parentVersionId` identifies the baseline it evaluated. Repeating the same retry command resumes that successor. To start a later generation, supply the most recent finished successor's handoff. Requested, running, interrupted and unverifiable work requires reconciliation on the original worker. Pipelines with a custom `--intent` continue to own their operation identity. The `--retry-after` option uses CI-managed state.

## Publish the check result

Stdout is one JSON object. Stderr carries individual CLI results and diagnostics. The summary contains the verified source `commit`, target `channel`, and the service's `requestId`, `candidateVersionId` and `candidateDigest` when request creation succeeds. Its `handoff` field points to the request file relative to the output directory. Use `executionStatus` and `comparisonId` to identify the recorded run. `quality` includes the bound policy, case and pair counts, parent and candidate mean scores, oriented improvement, failed criteria and criteria with unavailable evidence. `counts.incompletePairs` gives the number of pairs missing a comparable score. `quality.evidenceGaps` and `quality.policyReceipt` appear when the installed evaluator provides them. `qualityVerdict` is the application's `pass`, `fail`, or `indeterminate` policy verdict when available. `phaseExitCodes` records each command's integer exit code, with `null` for skipped phases.

| Summary result | CI action |
| --- | --- |
| `pass` | Mark the PR check successful and associate the commit with its evaluated candidate. |
| `quality_failed` or `quality_indeterminate` | Surface the application policy verdict and retained evidence to the reviewer. |
| `prior_execution_unresolved`, `prior_status_unavailable` | Inspect the predecessor and its worker before requesting a successor. |
| `execution_unresolved` | Inspect the original worker and its journal before retrying. |
| `execution_failed`, `check_failed`, `export_failed`, `preflight_failed`, `request_failed` or `configuration_error` | Show the phase and diagnostic to the evaluation owner. |

The wrapper preserves the underlying command's failure exit code. A failed execution and a quality regression can both exit 2. Use `result` to route them. After a terminal failed execution the wrapper attempts the policy check to capture its verdict. It attempts review export after every run and sets `reviewDirectory` only after successful export verification.

For scalar evidence, omit `--selection`. To export selected app-owned artifacts, supply `--selection "$EVALUATOR_APP/share-selection.json"` and install a review mapper. Upload only the verified `reviewDirectory` under the private output directory. Use your CI provider's access controls and retention settings. The journal, config, private request intent and case inventory belong on the worker.

An authorized reviewer can use the immutable candidate ID, digest and current channel revision to release the reviewed candidate separately. The CI credential needs project read/write and the quality check requires no promotion permission.
