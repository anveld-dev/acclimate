# Does connected learning improve an LLM CLI support agent?

This experiment tested whether Acclimate could learn reusable instruction or memory changes from routine LLM CLI support failures and improve on disjoint paired tasks. [Pre-registration](preregistration.md)

The [replication on policy v3](replication.md) used two repetitions per arm and a fresh audit cohort.

## Setup

LLM 0.38 at `46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f`, Click 8.5.1 and Python 3.13.1. Acclimate service source `c542f0435ba7d2828c8c4b7baa6c2d03afc0e4e7`, Rust 1.89.0 and a disposable PostgreSQL 18.6 database. The validation turn used Codex CLI 0.169.1. The SDK used @openai/codex-sdk 0.169.0 with its bundled Codex CLI 0.169.0. Each turn explicitly requested `gpt-6-luna` at low reasoning effort. The protocol records the frozen task, grader and baseline SHA-256 digests. [Pinned LLM source](https://github.com/simonw/llm/tree/46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f)

All 70 reference argv arrays and their negative controls passed the pinned Click checks. The frozen upstream encode/decode test file passed both pytest cases and had SHA-256 `e58ddf81693245422a58900ef6ebd1b02bc539ae2975eac43af4d2012a6ac034`. The experiment used 30 development, 30 audit and 10 separate field requests, with one observation per arm and the SDK's retry for missing evidence. The connected SDK evaluator graded binary command correctness. A local adapter routed service proposer and critic requests to the same authenticated Codex SDK. The Rust service managed enrollment, assignment, candidate creation and selection.

## Results

A/A used the same baseline in both arms. The service recorded a **16.67% flip rate** (5/30), paired SD of 0.43994, standard error of **8.03 percentage points**, and minimum detectable effect of **17.05 points**. The resolved baseline bundle digest was `sha256:5ae11b8aedac22d0f849f9be2636c9aae891689f9c82858a05b155ee205b92b2`.

| Stage | Comparison ID | Parent | Candidate | Paired gain | One-sided lower bound | Decision |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| A/A calibration | `f0c863b7-03f9-4bb1-af11-ad2ddc8537e0` | 10/30 | 7/30 | −10.00 pp | — | Calibration recorded |
| Development | `7b4ffd05-0585-44d5-a08c-e74f1550b8be` | 12/30 | 17/30 | +16.67 pp | +4.25 pp (90%) | Passed |
| Independent audit | `fcc77a9d-49c0-462f-90a0-ea1cf80b158d` | 10/30 | 10/30 | 0.00 pp | −13.66 pp (95%) | Rejected |

All three completed comparisons had 30 scored pairs. The dev bound came from the round record. The audit bound was reconstructed from the stored scores with the service's one-sided paired formula and its calibrated variance floor. The service reused the step comparison as the cumulative check because the incumbent chain had one accepted step and the configured drift interval was one. The audit rejection closed the round before the manual review endpoint became available. The operator decision was to retain the baseline.

All ten field outcomes were reported. The baseline passed three. The runner processed eligible failures in predeclared case order and stopped submitting corrections after consuming the sole audit cohort. Two of the seven field failures became corrections. Proposal `d166493f-8e06-4479-9318-0e4ef7ab8745` and its repair failed critic screening for case-specific guidance. Proposal `9cb89b83-a521-480c-a28f-08071f96860a` cleared screening after repair and produced the evaluated bundle at `sha256:13db8d69008cba18dd5378a2f63d2bd949499604e3f69fc9a5955f20c95c87b5`.

The candidate changed one sentence in `AGENTS.md`.

```diff
-Consult the local CLI help or source when you are uncertain.
+Consult the local CLI help or source when you are uncertain, and verify that the command and its options match the requested operation.
```

The experiment used **255/600 Luna attempts** in about **44 minutes** from the start of preflight. This included 1 readiness turn, 55 interrupted calibration attempts, 60 completed calibration turns, 10 field turns, 5 proposer turns, 4 critic turns, 60 development turns and 60 audit turns. Codex reported **6,329,265 input tokens** and **12,552 output tokens** across 253 attempts. The two interrupted attempts had no usage report.

## Conclusion

The development gain did not carry over to the independent audit. This run found no held-out improvement. Scope is limited to one pinned CLI, one argv-support workload and one audit cohort. The strict parsed-parameter target can reject operationally equivalent answers that choose different parameters. A single repetition per arm leaves substantial sampling noise. The task agent, proposer and critic all requested the same model, and execution always ran the parent first. The harness recorded the model request and Codex reported token usage. The resolved model identity was independently unverified.

## Reproduce

Run from the Acclimate repository root on macOS with authenticated Codex, Rust, uv and PostgreSQL 18 installed. Keep the command log private. The runner creates a fresh private database and removes it at exit.

```bash
npm ci --ignore-scripts
mkdir -m 700 .real-app-scratch
git init -q .real-app-scratch/llm
git -C .real-app-scratch/llm fetch --depth=1 https://github.com/simonw/llm.git 46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f
git -C .real-app-scratch/llm checkout --detach FETCH_HEAD
export TMPDIR="$PWD/.real-app-scratch"
export UV_CACHE_DIR="$TMPDIR/uv"
uv venv --python 3.13.1 "$TMPDIR/venv"
uv pip install --python "$TMPDIR/venv/bin/python" ./.real-app-scratch/llm click==8.5.1 pytest==9.2.0 pytest-asyncio==1.4.1 numpy==2.5.4
CARGO_TARGET_DIR="$TMPDIR/target" CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked
bash examples/real-app-learning/preflight.sh </dev/null
python3 examples/real-app-learning/run.py /opt/homebrew/opt/postgresql@18/bin > "$TMPDIR/run.log" 2>&1
```

For a restart, retain the previous run and readiness logs and include their turn counts and reported tokens in the totals. If the service requests manual review, write an `operator-decision.json` file in the scratch directory with the reported `roundId` and a boolean `approve`. Review the audit bound and candidate diff first. Remove the scratch directory after recording aggregate evidence.

## Deviations and service issues

- The initial calibration lost its database ownership lease during concurrent repository lint. The service exited with `proposal queue ownership lost: database connection timed out` and the next enrollment status poll received `ECONNREFUSED`. To reproduce the observed conditions, start the runner and run full repository lint, including Rust Clippy, against the same local build directory during live calibration. The timeout's underlying cause was unverified. The initial A/A furnished no completed comparison. A fresh database restarted the entire calibration with concurrent builds stopped. The restart charged all prior attempts, added a network-denied grader subprocess and exposed the operator review endpoint through a local decision file. The task split, grading code, baseline and thresholds stayed frozen for that restart.
- The second calibration exposed an experiment-harness bug. Run the original grader with `{"output":["llm","--help"],"expected":"llm logs path"}` on stdin. Click emitted help followed by a zero, which the TypeScript number conversion treated as missing. The corrected grader captures Click stdout and emits only the score. The exact Click command-and-parameter comparison stayed the same. The entire A/A arm restarted again with a fresh database and a new grader revision. Both interrupted calibrations consumed budget and furnished no completed comparisons.
- The runner processed corrections within its available proposal and audit inventory. It stopped after two corrections and left five other graded failures as terminal outcomes. The protocol called for corrections on failing field runs.
