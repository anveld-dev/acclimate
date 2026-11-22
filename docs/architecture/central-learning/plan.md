# Central learning: build plan

> **Status: proposed, not built.** The [learning contract](../../../contracts/learning.md) describes what ships today.

This file orders the work and states what each phase must prove before the next starts. The design itself is in the [README](README.md), [experience](experience.md), [tasks and grading](tasks-and-grading.md), [executor](executor.md), [loop](loop.md) and [API and data](api-and-data.md). The deletions are listed in [removal](removal.md). The decisions behind the design are in the [README's decisions table](README.md#decisions).

Today's service has no executor, sandbox, gateway, rollback route or record of agent sessions, and held-out content is not stored in it.

## First release

The first release supports the `chat` harness only: the bundle is rendered as the system prompt, the task input is the user message, and no user code runs. Every rollout still runs in a fresh sandbox with no network, so the `codex` harness later reuses isolation that already ships. Phases 1 to 3 build beside the current evaluator path and leave it working. Phase 4 switches over and deletes it in one change.

### Phase 1: gateway and executor

- `acclimate-executor` as a new container in the Compose stack, with no database access and no optimizer credentials.
- The gateway: enforces the model list and token caps, forwards `/chat/completions` unchanged, blocks provider-hosted tools and server-side state, and writes the gateway log. It receives the provider key with each lease and keeps it in memory only.
- Rollout leases: one row per rollout, an internal listener for the executor, and its own revocable token.
- The sandbox: a fresh container per rollout with no network, from one pinned runner image. gVisor in production, plain Docker locally with a printed warning. The gateway is reachable inside it as a `localhost` URL forwarded to a Unix socket.
- The `chat` harness as a built-in runner inside the sandbox, and the `exact` grader in the executor process.
- Runtime identity recorded per round.

**Exit gate:** an internal test leases rollouts for a fixture bundle and tasks, kills the executor mid-rollout, and sees that one rollout requeue and score. An infrastructure failure is retried once and never becomes a score. The gateway log is the only source of rollout traces. **Sandbox gate:** a rollout inside the sandbox reaches the gateway and nothing else, a network request to any other address fails, the expected answer is absent from the sandbox, and a runtime that cannot give that isolation fails the rollout. The gate runs under gVisor on Linux and under plain Docker on Docker Desktop for macOS.

### Phase 2: tasks, graders and admission

- Migration `0022`, which is additive: `learning_tasks` and `learning_held_out_tasks`, the rollout and trial tables, the new columns, and a copy of existing evolve cases into tasks. The current path keeps working.
- The split assigned by group and permanent. A test proves no optimizer code path queries the held-out table.
- The `criteria` grader: a pinned judge model, different from the task model, run three times per rollout with a majority verdict.
- Material conversion as an executor job, using the judge model.
- The admission check and trials (Try). A trial uses the same executor and is never counted.
- `job.expect()` gains an optional `output`. Outcomes pass admission, keep their provenance, and are split by job.

**Exit gate:** a task whose reference fails, whose empty answer passes, or whose judge disagrees with itself is set aside with a reason. No held-out content, gateway log or per-task result appears in any optimizer prompt or in any response to a machine credential.

### Phase 3: console and controls

- Model provider setup per workspace, and the task and judge model per loop.
- The bundle Learning page: turn on, import (spreadsheet, CSV, JSONL, pasted conversations), task cards, review, Try, the split count and Start.
- The Start floor of 20 admitted evolve and 20 admitted held-out tasks.
- The rounds timeline with the diff and diagnosis per release, flagged tasks with inline edit, and usage (tokens and rounds per bundle).
- Scheduling: rounds triggered by evidence, one retry, idling, reuse of incumbent scores, and the per-day round cap.
- The held-out alert, one-click rollback, automatic revert, and the blocked-version list.

**Exit gate:** the behavior suite covers the eight steps in [experience](experience.md) through the console, and the same steps pass through the API alone.

### Phase 4: cutover and deletions

- Rounds evaluate through the executor.
- Migration `0023`, which is destructive: it drops the evolve-case table, the app principal, the held-out commitment and the `evaluate` right, and pauses existing loops until they have held-out tasks.
- Everything in [removal](removal.md) is deleted or moved in the same change. The W1 experiment is parked: excluded from typecheck, with `test:sim-experiment` dropped.
- Contracts, site docs and the changelog are updated.

**Exit gate:** the rewritten learning end-to-end test runs full rounds on the local stack through a real executor, with no process on the test machine other than the stack. `npm run lint`, `typecheck`, `test`, the Rust tests, `pack:verify` and the behavior suite pass.

## After the first release

In this order. Each gets its own design note before work starts.

1. **`codex` harness, environments, the grader sandbox and check scripts.** They reuse the rollout sandbox from the first release. [Executor](executor.md) describes them.
2. **Messages and Responses gateway routes.** Pass-through, with the same rules for hosted tools and server-side state. The `codex` harness needs Responses.
3. **Session capture.** Recording an agent's conversation needs a new SDK call, because the plugins are libraries the application calls and never see the conversation. Then "Turn a session into a task" in the console.
4. **Drafted tasks.** The service drafts tasks from the bundle. Drafts are evolve only and need a person to confirm them.
5. **MCP wrapper** over the same API.
6. **Port the W1 experiment.**

## The W1 experiment

`examples/self-improvement-memory/` holds the driver for a paper-sized test of the SIM paper's transfer claim. Its full plan is [`experiment.md`](../../../examples/self-improvement-memory/experiment.md), next to the driver. `freeze.py` reads that file by path (`SPEC`) and hashes it. The plan describes the experiment on today's app-side loop, so the port rewrites it before any paid run.

What the experiment is:

- **Workload.** W1, an LLM CLI support workload, with fixed evolve and held-out splits and 60 held-out cases.
- **Change tested.** A policy-model change from `gpt-6-luna` to `gpt-6.2-sol`.
- **Conditions.** Full SIM (the source bundle continues with its memory), Harness Transfer (the source harness on a new bundle, no memory) and Cold Start (a new bundle), run in blocks with a pre-registered random order.
- **Primary claim (T1).** After the model change, Full SIM beats Harness Transfer. The endpoint is the held-out score after target round 10, paired by block.
- **Secondary claims.** Harness Transfer beats Cold Start (T2), and Full SIM keeps its source-model performance within 3 points (T3).
- **Shape.** Ten rounds and five candidates per run, five rollouts per task, every rollout scored. The plan sets n = 10 blocks, with a power analysis and a measured noise estimate.
- **Statistics and stops.** Paired comparisons by block, descriptive mechanism metrics (predicted versus fixed tasks, memory reuse), integrity rules with SQL checks, and stop conditions. All were fixed before any run.
- **Status.** Tooling and model-free tests are complete. The paid pilot and the paper-sized runs have not started.

What the port must preserve:

- The product loop is the experiment loop. The driver sets up bundles and reads curves. It never proposes, selects, releases or writes memory.
- Frozen inputs with digests, the pre-registered run order, turn and token accounting, the deviations-from-the-paper list and a deviations log.
- The same task runtime on every rollout of a run. Runtime identity per round makes this checkable.
- Measurement of one bundle under another model's workload without those runs entering history or memory.
- The check that no experiment label reaches the delivered harness.
- Scheduling that does not distort a run: the experiment needs exactly ten rounds per run, so the daily cap and the idle rule must be set or bypassed in a way the plan records.

What changes: W1's grader needs Python packages and a check script, so the port waits for item 1 above. The driver stops running an evaluator and becomes an API client. Cross-model measurement may need a table of its own. Decide at port time whether ordinary loops on separate bundles are enough.

## Considered and not planned

| Item | Why |
| --- | --- |
| Encrypting held-out tasks so only the executor can read them | The paper requires that the optimizer never sees held-out data, not that the service cannot hold it. A separate table and a test give that. Sealing needs matching cryptography in three languages. |
| Contamination screening and exclusion sets | Not in the paper. It breaks per-evaluation task counting. |
| A separate measurements table | Only the experiment needs it. Revisit at the port. |
| Opaque case tokens | Hardening, not function. |
| mTLS and remote executors | The executor shares the Compose network. Revisit when someone runs it on another host. |
| Trimming optimizer history and memory | A context overflow pauses the loop with a reason. Revisit if it happens in practice. |
| A local preflight runner | It would be a second path with weaker isolation. Try runs on the real executor. |

## Risks

| Risk | What we do |
| --- | --- |
| CLIProxyAPI may not expose the Responses API. Not verified. | The first release needs only chat completions. Verify before starting the `codex` harness. |
| gVisor may not run on Docker Desktop for macOS. | The sandbox ships in phase 1, so this is tested there. Production uses gVisor on Linux. The local stack uses plain Docker and prints a warning that isolation is weaker. This is an operator setting, not a product mode. If gVisor proves unreliable in production, a microVM runtime is the fallback. |
| Judge noise drives auto-release. | A pinned judge, three judge runs per rollout, the admission check, the Start floor, and the held-out alert with automatic revert. Show judge agreement on tasks that have a reference answer. |
| A trial needs a running service. | Trials must return fast enough to be the only preflight. Measure trial latency in phase 2. |
| Small held-out sets make drops hard to see. | The Start floor. State the noise level next to the held-out chart. |
| The service stores provider keys for every workspace. | Keys are encrypted at rest, scoped and rotated per workspace, sent to the executor per lease, and never written to its disk. |
| A blocked version tells the optimizer a change was removed. | Accepted. The optimizer gets no score, task or count. |
