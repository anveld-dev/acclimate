# Central learning: build plan

**Status: built.** Follow-up work is listed in the [release plan](plan.md#after-the-first-release).

## Accepted risks

| Risk | Exposure |
| --- | --- |
| A machine writer can import a known input and inspect the evolve listing to confirm held-out membership. | The public group hash already lets a writer predict its own new groups. The inference exposes no held-out reference, criteria, ID, log or result. |
| Text in an agent's output can address the judge. | The judge receives the output as data under a separate instruction, the candidate screen skips edits that address the grader, and three votes are taken. In [calibration](tasks-and-grading.md#where-the-judge-comes-from) no such text changed a verdict. A model judge can still be misled. |
| The optimizer can infer that an adoption was reverted. | A later round's history can show a candidate dropped as `blocked-version`. The optimizer gets no held-out score, task or count. |

## First release

1. In workspace settings, configure an OpenAI-compatible model provider, its key and allowed models. Wait for the executor to verify that each model answers and reports token usage.
2. Open the released bundle’s **Learning** tab. Choose its channel, task model and a different judge model.
3. Import CSV, JSONL, a spreadsheet or pasted examples. Each task pairs an input with an expected answer or grading criteria. Review the task cards and confirm held-out material. Use **Try** to inspect an executor run before starting a round.
4. Start learning once at least 20 evolve tasks and 20 held-out tasks pass admission. The same floor applies on resume.

The executor runs each rollout in a fresh sandbox. The service scores candidates on evolve tasks and automatically releases the selected version to the channel. Held-out scores monitor regressions. Inspect the round, usage and release history in the console or roll back an adopted round.

## Checked on a real provider

On 23 November 2026 the loop ran on the local Compose stack against Codex models through CLIProxyAPI 8.1.1: `gpt-6-luna` for tasks, `gpt-6.2-sol` for the judge and `gpt-6.2-astra` at high effort for the optimizer. The workload was 56 support-desk tasks. Half were JSON extraction graded by exact match, and half were replies judged on four criteria each.

| Step | Result |
| --- | --- |
| Provider verification | Both models answered and reported token usage. |
| Import | 28 rows with an expected answer became `exact` tasks. 28 rows with their own criteria were converted by the judge model, none set aside. |
| Admission | All 56 tasks were admitted, 31 evolve and 25 held-out. The judge's three votes agreed on every check. |
| Round 1 | 1,180 rollouts, none failed and none retried. The starting bundle scored 0 of 155 on evolve. All five candidates scored 70 of 155, and the selector adopted the shortest and released it. |
| Regression check | The adopted version scored 0.56 on held-out and its parent 0.00, measured in the same round. No alert was raised. |
| Round 2 | The incumbent's evolve score was reused. All five candidates scored 155 of 155, and the selector adopted the one that changed only the greeting rule, citing the round 1 entry in improvement memory. Held-out rose to 1.00. |
| Usage | 2,194 rollouts in the two rounds: about 0.9 million task tokens, 1.4 million judge tokens and 1.6 million optimizer tokens. No rollout failed or was retried. |

What the run changed:

- **Conversion.** The first import failed. The model returned the row's own criteria and also drafted more, which the executor rejected, and one rejected row failed the whole import. Existing criteria now win, and a row that cannot be mapped is set aside as `not-converted`.
- **Provider errors.** The provider answers an overloaded model with HTTP 502 and a Retry-After of about five minutes, and CLIProxyAPI then refuses that model with HTTP 503 for as long. The gateway now asks again every 30 seconds for up to seven minutes, and the [operator guide](../../../deploy/README.md) says how to turn the proxy's cooldown off.
- **Feedback for exact-match tasks.** A first run on a build that withheld the expected answer adopted nothing: every candidate scored 0, because the optimizer was told that an extraction failed and not what it should have been. With the expected answer in the feedback, every candidate fixed all 14 extraction tasks.

- **Partial credit for judged tasks.** In round 1 every candidate met three of the four criteria on the judged replies and failed the fourth. A judged rollout then scored 1 or 0, so all 85 scored 0 and the score showed no progress. The loop was not stuck: the selector read the judge's reasons and round 2 fixed the fourth. A judged rollout now scores the share of its criteria met, as the paper and RRSI score Harvey LAB, while a pass still needs every criterion. The run above predates this change.

A third run used the new scoring, on a fresh bundle with the same 56 tasks:

| | Evolve score | Held-out score |
| --- | --- | --- |
| Starting bundle | 0.157 | 0.141 |
| After round 1 (adopted) | 1.000 | 1.000 |

The starting bundle's judged replies met one or two of their four criteria, which the old scoring showed as 0. The five candidates scored 1.000, 0.997, 0.982, 0.990 and 0.979, and the selector adopted the first, citing the ticket number the others dropped in at least one reply. Under the old scoring the first round fixed only the extraction tasks. The round ran 1,180 rollouts. None failed, and five were retried after the provider reported itself overloaded.

What it left open:

- **Held-out regression.** No adoption regressed, so the revert was not exercised with real models. The behavior scenarios cover it with a scripted provider, including the alert email through Mailpit.

## After the first release

In this order. Each gets its own design note before work starts.

1. **`codex` harness, environments, the grader sandbox and check scripts.** They reuse the rollout sandbox from the first release. [Executor](executor.md) describes them.
2. **Messages and Responses gateway routes.** Pass-through, with the same rules for hosted tools and server-side state. The `codex` harness needs Responses.
3. **Session capture.** Recording an agent's conversation needs a new SDK call, because the plugins are libraries the application calls and never see the conversation. Then "Turn a session into a task" in the console.
4. **Drafted tasks.** The service drafts tasks from the bundle. Drafts are evolve only and need a person to confirm them.
5. **MCP wrapper** over the same API.
6. **Port the W1 experiment.**

## The W1 experiment

`examples/self-improvement-memory/` holds the driver for a paper-sized test of the SIM paper's transfer claim. Its full plan is [`experiment.md`](../../../examples/self-improvement-memory/experiment.md), next to the driver. `freeze.py` reads that file by path (`SPEC`) and hashes it. The plan describes the experiment on the removed app-side loop, so the port rewrites it before any paid run.

What the experiment is:

- **Workload.** W1, an LLM CLI support workload, with fixed evolve and held-out splits and 60 held-out cases.
- **Change tested.** A policy-model change from `gpt-6-luna` to `gpt-6.2-sol`.
- **Conditions.** Full SIM (the source bundle continues with its memory), Harness Transfer (the source harness on a new bundle, no memory) and Cold Start (a new bundle), run in blocks with a pre-registered random order.
- **Primary claim (T1).** After the model change, Full SIM beats Harness Transfer. The endpoint is the held-out score after target round 10, paired by block.
- **Secondary claims.** Harness Transfer beats Cold Start (T2), and Full SIM keeps its source-model performance within 3 points (T3).
- **Shape.** Ten rounds and five candidates per run, five rollouts per task, every rollout scored. The plan sets n = 10 blocks, with a power analysis and a measured noise estimate.
- **Statistics and stops.** Paired comparisons by block, descriptive mechanism metrics (predicted versus fixed tasks, memory reuse), integrity rules with SQL checks, and stop conditions. All were fixed before any run.
- **Status.** Tooling and model-free tests were completed on the app-side loop and do not run on this build. The paid pilot and the paper-sized runs have not started.

What the port must preserve:

- The product loop is the experiment loop. The driver sets up bundles and reads curves. It never proposes, selects, releases or writes memory.
- Frozen inputs with digests, the pre-registered run order, turn and token accounting, the deviations-from-the-paper list and a deviations log.
- The same task runtime on every rollout of a run. Runtime identity per round makes this checkable.
- Measurement of one bundle under another model's workload without those runs entering history or memory.
- The check that no experiment label reaches the delivered harness.
- Scheduling that does not distort a run: the experiment needs exactly ten rounds per run, so the daily cap and the idle rule must be set or bypassed in a way the plan records.

What changes: W1's grader needs Python packages and a check script, so the port waits for item 1 above. The driver stops running an evaluator and becomes an API client. Cross-model measurement may need a table of its own. Decide at port time whether ordinary loops on separate bundles are enough.
