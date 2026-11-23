# Central learning: build plan

**Status: built.** Follow-up work is listed in the [release plan](plan.md#after-the-first-release).

## Accepted risks

| Risk | Exposure |
| --- | --- |
| A machine writer can import a known input and inspect the evolve listing to confirm held-out membership. | The public group hash already lets a writer predict its own new groups. The inference exposes no held-out reference, criteria, ID, log or result. |

## First release

1. In workspace settings, configure an OpenAI-compatible model provider, its key and allowed models. Wait for the executor to verify that each model answers and reports token usage.
2. Open the released bundle’s **Learning** tab. Choose its channel, task model and a different judge model.
3. Import CSV, JSONL, a spreadsheet or pasted examples. Each task pairs an input with an expected answer or grading criteria. Review the task cards and confirm held-out material. Use **Try** to inspect an executor run before starting a round.
4. Start learning once at least 20 evolve tasks and 20 held-out tasks pass admission. The same floor applies on resume.

The executor runs each rollout in a fresh sandbox. The service scores candidates on evolve tasks and automatically releases the selected version to the channel. Held-out scores monitor regressions. Inspect the round, usage and release history in the console or roll back an adopted round.

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
