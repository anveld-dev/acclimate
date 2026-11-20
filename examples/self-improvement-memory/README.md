# Self-improvement memory experiment

This example runs the Acclimate learning loop on W1, an LLM CLI support workload. It compares Full SIM, Harness Transfer and Cold Start in 10 checkpoint-paired blocks. The primary outcome is the round-10 held-out score after the task model changes from `gpt-6-luna` to `gpt-6.2-sol`. The [experiment plan](../../docs/architecture/self-improvement-memory/experiment.md) defines the protocol and integrity gates.

## Prepare and check the fixtures

Run from the repository root with Node, Rust, PostgreSQL 16 and Python 3.11 or newer. Paid stages use macOS `sandbox-exec` to seal the experiment repository and evidence from Codex subprocesses. The example uses a clean checkout of [LLM at 46f0461d](https://github.com/simonw/llm/tree/46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f) outside the Acclimate repository as the Codex task working directory. Install the grader into a dedicated virtual environment.

```sh
npm ci --ignore-scripts
cargo build --locked --bin acclimate-service
python3 -m venv /tmp/w1-sim-venv
/tmp/w1-sim-venv/bin/python -m pip install -r examples/self-improvement-memory/requirements.txt
SIM_PYTHON=/tmp/w1-sim-venv/bin/python \
  npm --prefix examples/self-improvement-memory run test:sim-experiment
/tmp/w1-sim-venv/bin/python -m pytest examples/self-improvement-memory
/tmp/w1-sim-venv/bin/python examples/self-improvement-memory/freeze.py --check
```

These steps make zero model calls. The TypeScript runner starts private PostgreSQL 16 clusters on loopback, uses the real Rust service and provides scripted optimizer replies and fake policy outputs. Set `SIM_PG_BIN` to override `/opt/homebrew/opt/postgresql@16/bin`. The Python tests check canonical Click parsing, disjointness, negative controls and known-answer statistics.

## Freeze and run

Set paths for the grader environment, the pinned LLM checkout and the evidence directory.

```sh
sim_python=/tmp/w1-sim-venv/bin/python
sim_llm=/absolute/path/to/clean/llm
sim_out="$PWD/artifacts/sim-experiment"
sim_pg=/opt/homebrew/opt/postgresql@16/bin

"$sim_python" examples/self-improvement-memory/freeze.py \
  --source-tree "$sim_llm" --pg-bin "$sim_pg" \
  --output "$sim_out/pilot-freeze.json"
```

The freeze is zero-call. Review and archive it before S0c. It records fixture and code hashes, the executable hash, tool versions, model settings, and both split commitments. Build the service from the commit being registered and use the same service binary for every condition. Use `--service-bin` on both scripts if the binary is outside `target/debug`.

**Paid S0c.** Authenticate the Codex CLI with an account that can run `gpt-6-luna` and `gpt-6.2-sol` at low effort. The optimizer proxy uses the same Codex account for the fixed `gpt-6.2-astra` optimizer at high effort. The private Acclimate operator, app and model-proxy tokens are generated locally. Select the provider and credentials before freezing and verify the available context and concurrency for that account. Keep the provider fixed through the study. Use a dedicated Codex configuration without external MCP servers or user instructions. Each model turn uses an ephemeral Codex session, and optimizer turns have shell tools disabled.

```sh
"$sim_python" examples/self-improvement-memory/run.py --stage S0c --live \
  --source-tree "$sim_llm" --pg-bin "$sim_pg" --output "$sim_out" \
  --freeze "$sim_out/pilot-freeze.json"
```

S0c runs two three-round source legs and three one-round targets from the first source. Review `S0c/pilot.json` for rates, token growth and the cost projection. If either target round-zero W1 held-out score (H0 or H_S under `gpt-6.2-sol`) reaches 85%, stop before S1 for a maintainer decision. For other K3 failures, resolve the finding and run a new pilot. Archive the prior pilot directory and use a fresh evidence root for the repeat. When K3 passes, generate the final preregistration and record it with the frozen protocol before S1. This step makes zero model calls.

```sh
"$sim_python" examples/self-improvement-memory/freeze.py \
  --source-tree "$sim_llm" --pg-bin "$sim_pg" \
  --pilot-report "$sim_out/S0c/pilot.json" --output "$sim_out/preregistration.json"
```

**Paid S1 and S2.** S1 saves each paused source checkpoint. S2 starts the three targets on independent copies in a seeded submission order, checks K4 at the fifth complete block, and measures retention after all target blocks resolve. It shares the Full SIM round-zero measurement with HT and measures Cold Start at its own baseline. S2 grades the final evolve harness offline to measure the overfitting gap.

```sh
"$sim_python" examples/self-improvement-memory/run.py --stage S1 --live --blocks 1-10 \
  --source-tree "$sim_llm" --pg-bin "$sim_pg" --output "$sim_out" \
  --freeze "$sim_out/preregistration.json"
"$sim_python" examples/self-improvement-memory/run.py --stage S2 --live --blocks 1-10 \
  --source-tree "$sim_llm" --pg-bin "$sim_pg" --output "$sim_out" \
  --freeze "$sim_out/preregistration.json"
```

Rerun the same command to resume published runs from their verified ledgers. Keep one driver per evidence directory. For each failed run it keeps the attempt evidence and retries at most twice. K1 and K2 halt the stage for investigation. K3 gates the move from S0c to S1. Monitor provider announcements for K6 and pause the stage on a model change. The repository checks should run outside live stages.

## Analyze

After S2 and its retention measurements, run the frozen analyzer. This step makes zero model calls.

```sh
"$sim_python" examples/self-improvement-memory/analyze.py "$sim_out" \
  --freeze "$sim_out/preregistration.json"
```

The analyzer verifies ledger hashes, recomputes held-out scores with case-bootstrap errors, saves `analysis/coded.json`, then opens the condition key. It writes paired effects and mechanism estimates to `analysis/results.json` and raw per-round means and intervals to `analysis/curves.tsv`. Scores and effects are fractions. During S2, `analyze.py "$sim_out" --harm-only` emits the K4 Boolean.

Keep raw evidence and `key.json` private. The SDK currently owns case scheduling within a learning evaluation. The driver seeds local rollout labels and fully shuffles offline scoring. Per-evaluation case ordering would need an SDK scheduling option before it can be frozen as part of the in-loop protocol. See the experiment plan for this limitation and the optional pre-change control.
