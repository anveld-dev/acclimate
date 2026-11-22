# Central learning

**Status: proposed design. Not built yet.** The shipped loop is described in the [learning contract](../../../contracts/learning.md).

Central learning moves every part of the learning loop into the Acclimate service. Today the service plans each round, but a process on the developer's machine (`npx acclimate learn`) runs every rollout, grades it and reports scores. In this design the service also runs and grades the rollouts. Nothing runs on the developer's machine: no long-running process, no CLI, no local model calls.

The loop itself still follows the SIM paper ([arXiv 2611.18856](https://arxiv.org/abs/2611.18856)). Each round, the optimizer proposes five candidates, each with a diagnosis and predicted tasks. Survivors are scored on the evolve split, one is adopted or the incumbent is kept, and an adopted candidate is released at once to the learning channel. The held-out split is scored for monitoring and never reaches the optimizer.

What changes is everything around the loop:

- **Tasks live in the service.** A task is an input plus an expected answer or plain-language criteria. Tasks come from material the user uploads in the console and from production outcomes reported with `job.expect()`. The service assigns the split and keeps custody of held-out tasks.
- **An executor runs rollouts.** A separate `acclimate-executor` container runs and grades each rollout. A gateway inside it is the only route to a model. Every rollout runs in a fresh sandbox with no network, from the first release. The first harness, `chat`, is a small built-in runner inside that sandbox. Grading happens outside it.
- **The console is the way in.** Setup is a short path in the console, and the API mirrors every step. There is no repository layout, no GitHub app and no MCP surface in the first release.
- **Rounds run when there is something to learn.** New evidence triggers a round. The loop idles when the task set is exhausted, and a per-bundle cap limits rounds per day.

## Where things run

```
Your side                          Acclimate service
---------                          -----------------
Browser (console) ───────────────▶ API ──▶ PostgreSQL
                                    │        tasks, split, held-out custody,
Your app                            │        rounds, rollout leases, memory,
  delivery (as today) ◀──────────── │        provider key (encrypted)
  job.expect() (optional) ────────▶ │
                                    ├─ worker: rounds, selection, release,
                                    │          alerts, rollback, revert
                                    ├─ optimizer ──▶ optimizer model
                                    │
                                    └─ internal listener (leases)
                                            ▼
                                   acclimate-executor   (no database access,
                                    │                    no optimizer keys)
                                    ├─ agent sandbox     fresh per rollout, no network
                                    │    └─ chat harness (built-in runner)
                                    ├─ exact grader / judge   outside the sandbox
                                    ├─ gateway ──▶ task model and judge model
                                    │              (key arrives with each lease,
                                    │               held in memory only)
                                    └─ later: grader sandbox for check scripts,
                                              codex harness and environments
```

## Decisions

**Binding** decisions come from the maintainer. **Agreed** decisions were proposed and accepted. Thresholds in them are starting values that can be tuned. This table is the only list. Other pages link here.

| # | Decision | Status |
| --- | --- | --- |
| 1 | Follow the SIM paper: five candidates per round, a diagnosis and predicted tasks per candidate, scanner and selector, adopt one or keep the incumbent, memory write-back of the adopted attempt only. | Binding |
| 2 | One path. No modes or flags. Complications wait until after the first release. | Binding |
| 3 | Auto-release only. No human approval gate. | Binding |
| 4 | Memory is shared per bundle. | Binding |
| 5 | Optimizer `gpt-6.2-astra` at high effort. Task models `gpt-6-luna` (source) and `gpt-6.2-sol` (target). OpenAI-compatible endpoints only, with Codex reached through CLIProxyAPI. | Binding |
| 6 | Learning is centralized. Nothing runs on the developer's machine. | Binding |
| 7 | No GitHub-app setup as the way in. | Binding |
| 8 | The old design is deleted where it was wrong. The experience may differ sharply from today's. | Binding |
| 9 | `job.expect()` stays as the production source of tasks. | Binding |
| 10 | The console path in [experience](experience.md), with the API mirroring every step. No CLI, repository layout or MCP surface in the first release. | Agreed |
| 11 | The `chat` harness ships first. The `codex` harness and environments follow. | Agreed |
| 12 | Held-out tasks are stored unencrypted in their own table, `learning_held_out_tasks`, which no optimizer code path queries. A test enforces it. | Agreed |
| 13 | Start requires 20 admitted evolve tasks and 20 admitted held-out tasks. | Agreed |
| 14 | A clear held-out drop reverts the release automatically, on top of the alert and manual rollback. Clear means the score fell by at least 0.10, two or more tasks flipped, and a re-score confirmed it. The loop continues after a revert. | Agreed |
| 15 | Rounds are triggered by evidence: Start, an adoption, a task change of 5 tasks or 10% of evolve (whichever is larger), or one retry after a round that adopted nothing. The loop idles after two consecutive rounds with no adoption and no task change, reuses the incumbent's scores when nothing changed, and is capped at four rounds per day per bundle. The console shows tokens and rounds used. | Agreed |
| 16 | Every rollout runs in a fresh sandbox with no network from the first release: gVisor in production, plain Docker locally with a printed warning. Grading with `exact` and the judge runs outside it, in the executor. The grader sandbox arrives with check scripts. | Agreed |
| 17 | A rolled-back or reverted version is blocked. The service drops any candidate that reproduces one, with the reason `blocked-version`. The optimizer can see that a candidate was dropped as blocked, and this small leak is accepted. | Agreed |
| 18 | The judge runs three times per rollout and the majority verdict counts. The admission check also uses three runs. | Agreed |
| 19 | `/outcomes` moves to the `write` right, and production outcomes can land in held-out. | Agreed |
| 20 | Material import is capped at 64 MiB. | Agreed |
| 21 | Each loop stores a `task_model` and a `judge_model`, chosen from the workspace provider's allowed models. They must differ. | Agreed |

## What changes from today

| Area | Today | Central learning |
| --- | --- | --- |
| Where rollouts run | The developer's machine, inside `npx acclimate learn` | The executor |
| How a loop is defined | `defineLoop` in `acclimate.loop.ts`, with `execute` and `grade` callbacks | Console setup. A built-in harness, with tasks graded by expected answer or criteria |
| Where tasks come from | A cases file synced by the CLI, plus `job.expect()` | Material uploaded in the console, plus `job.expect()` |
| Held-out | Cases stay in the app. The service holds a digest and a count | Tasks are stored in the service. The optimizer never reads them |
| Model keys | On the developer's machine | Stored by the service and used only by the gateway |
| Credentials | A machine token with the Evaluate right and an app principal | A `write` token for `job.expect()` only. The executor has its own credential |
| When rounds run | Back to back while the loop is running | On new evidence, with idling and a daily cap |
| Regression control | None beyond pause and stop | Held-out alert, rollback, automatic revert |

The round, the optimizer prompts, the scanner, shared memory and versioned delivery carry over.

## Glossary

| Term | Meaning |
| --- | --- |
| SIM | Self-improvement memory, the method in the paper this loop follows. |
| Incumbent | The bundle version currently released to the learning channel. |
| Candidate | A proposed change to the incumbent, with a diagnosis and predicted tasks. |
| Scanner | The service check that drops unsafe or malformed candidates before scoring. |
| Setting | The `{domain, benchmark, policyModel}` label on a loop. Memory is matched by it. The service sets `policyModel` to the loop's task model. |
| Task | An input plus how to judge the result. It replaces the evolve case. |
| Evolve, held-out | The two splits. The optimizer learns from evolve. Held-out is for monitoring. |
| Rollout | One agent run on one task. |
| Trial | A Try run or an admission check. It never counts toward learning. |
| Harness | The built-in way an agent is run: `chat` first, `codex` later. |
| Judge | The model that grades a rollout against plain-language criteria. |
| Gateway log | The gateway's record of every model request and response in a rollout. |
| Admission check | The test every task passes before it counts. |
| Session capture | Later work: recording a real agent session so it can become a task. |
| CLIProxyAPI | The OpenAI-compatible proxy used to reach Codex models. |
| W1 | The support workload used by the experiment in `examples/self-improvement-memory/`. |

## Contents

- [Experience](experience.md): the console path from setup to month two.
- [Tasks and grading](tasks-and-grading.md): the task model, the split, held-out custody, the admission check and the judge.
- [Executor](executor.md): rollout leases, the gateway, sandboxes, the gateway and the chat harness.
- [Loop](loop.md): the round, scheduling and cost controls, rollback and automatic revert.
- [API and data](api-and-data.md): routes, rights and the migrations.
- [Removal](removal.md): what is deleted from today's code and documentation.
- [Plan](plan.md): phases, the first-release cut, later work and risks.
