# Central learning

**Status: built.** Follow-up work is listed in the [release plan](plan.md#after-the-first-release).

The service plans rounds and the executor runs and grades each rollout. Set up learning in the console or through the workspace API.

The loop itself still follows the SIM paper ([arXiv 2611.18856](https://arxiv.org/abs/2611.18856)). Each round, the optimizer proposes five candidates, each with a diagnosis and predicted tasks. Survivors are scored on the evolve split, one is adopted or the incumbent is kept, and an adopted candidate is released at once to the learning channel. The held-out split is scored for monitoring and never reaches the optimizer.

## Components

- **Tasks live in the service.** A task is an input plus an expected answer or plain-language criteria. Tasks come from evaluation material imported via the console or API, or written in the console. The service assigns the split and keeps custody of held-out tasks.
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
  delivery            ◀──────────── │        provider key (encrypted)
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

## Glossary

| Term | Meaning |
| --- | --- |
| SIM | Self-improvement memory, the method in the paper this loop follows. |
| Incumbent | The bundle version currently released to the learning channel. |
| Candidate | A proposed change to the incumbent, with a diagnosis and predicted tasks. |
| Scanner | The service check that drops unsafe or malformed candidates before scoring. |
| Setting | The `{domain, benchmark, policyModel}` label on a loop. Memory is matched by it. The service sets `policyModel` to the loop's task model. |
| Task | An input plus how to judge the result.  |
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
