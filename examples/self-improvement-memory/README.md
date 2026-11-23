# Self-improvement memory experiment

This experiment uses the removed application-side loop and is waiting to be ported to the executor.

This example runs the Acclimate learning loop on W1, an LLM CLI support workload. It compares Full SIM, Harness Transfer and Cold Start in 10 checkpoint-paired blocks. The primary outcome is the round-10 held-out score after the task model changes from `gpt-6-luna` to `gpt-6.2-sol`. The [experiment plan](experiment.md) defines the protocol and integrity gates.

## Prepare and check the fixtures

Run from the repository root with Node.js 22.22 or newer, Rust, PostgreSQL 16 and Python 3.12 or newer. Install the grader into a dedicated virtual environment. The requirements pin the LLM version and commit used for Click grading. Task models receive only the harness and case request.

```sh
npm ci --ignore-scripts
cargo build --locked --bin acclimate-service
python3.12 -m venv /tmp/w1-sim-venv
/tmp/w1-sim-venv/bin/python -m pip install -r examples/self-improvement-memory/requirements.txt
SIM_PYTHON=/tmp/w1-sim-venv/bin/python \
  npm run test:sim-experiment
/tmp/w1-sim-venv/bin/python -m pytest examples/self-improvement-memory
/tmp/w1-sim-venv/bin/python examples/self-improvement-memory/freeze.py --check
```

These steps make zero live model calls. The TypeScript runner starts private PostgreSQL 16 clusters on loopback, uses the real Rust service and sends all three models’ requests to one local fake OpenAI-compatible server. Set `SIM_PG_BIN` to override `/opt/homebrew/opt/postgresql@16/bin`. The Python tests check canonical Click parsing, disjointness, negative controls and known-answer statistics.

## Freeze and run

Set up a private CLIProxyAPI instance with Codex sign-in using the [deployment guide](../../deploy/README.md#cliproxyapi-with-codex-sign-in). Use one Codex credential with access to all three exact model IDs. Keep its configuration and routing fixed through the study. Set `SIM_PROXY_API_KEY` in the driver's environment to the client key configured in CLIProxyAPI. Set the following paths and record the exact revision of the running proxy. The example revision is the one inspected for compatibility.

```sh
sim_python=/tmp/w1-sim-venv/bin/python
sim_proxy_config=/absolute/path/to/config.yaml
sim_proxy_revision=f5c5681a8361c9da53e93c60b6507816eee7468b
sim_proxy_base_url=http://127.0.0.1:8317/v1
sim_out="$PWD/artifacts/sim-experiment"
sim_pg=/opt/homebrew/opt/postgresql@16/bin

"$sim_python" examples/self-improvement-memory/freeze.py \
  --proxy-base-url "$sim_proxy_base_url" --proxy-revision "$sim_proxy_revision" \
  --proxy-config "$sim_proxy_config" --pg-bin "$sim_pg" \
  --output "$sim_out/pilot-freeze.json"
```

The freeze is zero-call. Review and archive it before S0c. It records fixture and code hashes, the executable hash, tool versions, model settings, both split commitments, and the proxy revision, config SHA-256 and base URL. Verify that the running proxy uses that revision and config. Build the service from the commit being registered and use the same service binary for every condition. Use `--service-bin` on both scripts if the binary is outside `target/debug`.

**Paid S0c.** Task calls use `gpt-6-luna` and `gpt-6.2-sol` at `low` effort through the SDK’s `openai()` adapter. The service sends optimizer requests for `gpt-6.2-astra` at `high` effort through the driver’s loopback audit relay, which checks the request and forwards it unchanged to the same frozen Chat Completions URL. The driver's private operator, evaluator and relay tokens are generated locally. The relay uses `SIM_PROXY_API_KEY` for the upstream hop. Request ledgers record the upstream endpoint and model. Keep the config and OAuth credential store private.

```sh
"$sim_python" examples/self-improvement-memory/run.py --stage S0c --live \
  --proxy-config "$sim_proxy_config" --pg-bin "$sim_pg" --output "$sim_out" \
  --freeze "$sim_out/pilot-freeze.json"
```

S0c runs two three-round source legs and three one-round targets from the first source. Review `S0c/pilot.json` for repeated-case disagreement, rates, token growth and the cost projection. Re-estimate noise and cost with the prompt-only setup because the historical Codex-agent calibration used repository access. If either target round-zero W1 held-out score (H0 or H_S under `gpt-6.2-sol`) reaches 85%, stop before S1 for a maintainer decision. For other K3 failures, resolve the finding and run a new pilot. Archive the prior pilot directory and use a fresh evidence root for the repeat. When K3 passes, generate the final preregistration and record it with the frozen protocol before S1. This step makes zero model calls.

```sh
"$sim_python" examples/self-improvement-memory/freeze.py \
  --proxy-base-url "$sim_proxy_base_url" --proxy-revision "$sim_proxy_revision" \
  --proxy-config "$sim_proxy_config" --pg-bin "$sim_pg" \
  --pilot-report "$sim_out/S0c/pilot.json" --output "$sim_out/preregistration.json"
```

**Paid S1 and S2.** S1 saves each paused source checkpoint. S2 starts the three targets on independent copies in a seeded submission order, checks K4 at the fifth complete block, and measures retention after all target blocks resolve. It shares the Full SIM round-zero measurement with HT and measures Cold Start at its own baseline. S2 grades the final evolve harness offline to measure the overfitting gap.

```sh
"$sim_python" examples/self-improvement-memory/run.py --stage S1 --live --blocks 1-10 \
  --proxy-config "$sim_proxy_config" --pg-bin "$sim_pg" --output "$sim_out" \
  --freeze "$sim_out/preregistration.json"
"$sim_python" examples/self-improvement-memory/run.py --stage S2 --live --blocks 1-10 \
  --proxy-config "$sim_proxy_config" --pg-bin "$sim_pg" --output "$sim_out" \
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
