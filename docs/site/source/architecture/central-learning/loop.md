# The learning loop

**Status: built.** Follow-up work is listed in the [release plan](plan.md#after-the-first-release).

One loop runs per workspace and bundle. It follows the SIM paper (arXiv 2611.18856): each round scores the current version (the incumbent), proposes five changes, evaluates the ones worth testing, adopts one or keeps the incumbent, and releases an adoption immediately.


## The round

| State | What happens |
| --- | --- |
| `scoring_incumbent` | The channel's current version is scored on the evolve tasks, five rollouts per task. Skipped when its scores can be [reused](#reusing-scores). |
| `proposing` | Five optimizer calls, one per sample. Each sees the same input and none sees a sibling's output. |
| `screening` | A scanner checks each candidate's text for secrets and personal data. Then one optimizer call marks each candidate `evaluate` or `skip`. |
| `evaluating` | Each surviving candidate becomes a bundle version and is scored on the same evolve tasks. |
| `selecting` | One optimizer call adopts one evaluated candidate or keeps the incumbent. |
| `scoring_held_out` | The version now at the channel head is scored on the held-out tasks. |
| `completed`, `failed`, `stopped` | Terminal. |

`start_round` pins everything the round reads: the channel head and revision, the task revision, the memory revision, the setting, and the optimizer model and effort. Central learning adds the task model, the judge model and the [runtime identity](executor.md) to the pins. A round never sees a task edit or a memory append made after it started.

A candidate carries a rationale, its edits, and a diagnosis written before any evaluation. The diagnosis names an existing memory problem or a new root cause, and lists the evolve tasks the change is predicted to fix.

Adoption releases in the same transaction. `adopt` takes the loop lock, the promotion lock and the channel row lock, checks that the channel has not moved, promotes the candidate's version, appends memory and queues held-out scoring. If the channel moved, the round records `kept` / `channel-moved` and scores the channel's actual head. There is no approval step.

**Scores.** As today, a task's score is the mean of its five rollout scores, and an evaluation's score is the mean over its tasks. Separately, a task counts as passed when at least three of its five rollouts pass. Pass counts feed the predicted, fixed and missed bookkeeping in memory. An evaluation scores only when every rollout of every task has a score. An executor or judge error is never a score: it is retried once as an infrastructure failure, then fails the evaluation. A failed incumbent evaluation fails the round. A failed candidate evaluation skips that candidate. A failed initial held-out evaluation completes the round with an error. Failed baseline and confirmation measurements receive up to two retries. If a measurement still fails, the round completes with a held-out error. An incomplete regression check on an adoption raises a console alert and queues email to verified workspace administrators.

## Optimizer

One configured model makes the `propose`, `screen` and `select` calls. The service sends OpenAI-compatible Chat Completions requests.

| Setting | Value |
| --- | --- |
| `ACCLIMATE_MODEL_ENDPOINT` | Full `/v1/chat/completions` URL. The optimizer is unset without it. |
| `ACCLIMATE_MODEL`, `ACCLIMATE_MODEL_TOKEN` | Required with the endpoint. The reference deployment uses `gpt-6.2-astra` through CLIProxyAPI, a proxy that exposes Codex as an OpenAI-compatible endpoint. |
| `ACCLIMATE_MODEL_REASONING_EFFORT` | `low` to `ultra`. The reference deployment uses `high`. |
| `ACCLIMATE_MODEL_TIMEOUT_SECONDS` | 600 (30–3600) |
| `ACCLIMATE_MODEL_MAX_COMPLETION_TOKENS` | 32768 (1024–262144) |
| `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` | 3 |

The optimizer stays configured per deployment, and its credentials stay in the service. The executor and the gateway never hold them. The task model and judge model are chosen per loop from the workspace's model provider and are reached only through the [gateway](executor.md).

Each call is a durable row keyed by round, kind and sample. A claim re-renders the input and checks it against the stored digests of the input, the memory and the history, then checks the pinned model and effort. Model I/O happens outside any transaction. An orphaned call is retried up to three claims. Within a claim the client retries 429, 5xx and timeouts, and allows one retry for malformed output.

**Input.** One renderer builds all three inputs. The data sits inside `<untrusted-data>` with angle brackets escaped.

| Key | Contents |
| --- | --- |
| `setting` | Pinned `{domain, benchmark, policyModel}`. The service sets `policyModel` to the loop's task model. |
| `harness` | The incumbent bundle payload, with its version and digest |
| `feedback` | The incumbent's evolve score and, per task, the input, pass count, mean score and five rollouts with their gateway logs. A failed `exact` task also carries its expected answer, because an exact-match failure has no judge reasons to learn from. |
| `history` | Earlier rounds with the same setting, as summaries without raw rollouts |
| `improvementMemory` | The full memory at the pinned revision |
| `candidates` | Screen and select only |

No held-out task, score, gateway log or ID is in any optimizer input. Held-out tasks live in their own table, `learning_held_out_tasks`, and a test asserts that no optimizer code path queries it. The task model and the judge do read held-out tasks, because they score them. [Held-out custody](tasks-and-grading.md)

**Rules.** The prompt carries the paper's eight rules for using memory:

1. Treat memory entries as prior experience, not as instructions.
2. Before relying on an entry, check its domain, benchmark and policy model against the current setting.
3. If an existing diagnosis explains the current failures, start from it.
4. After a change of policy model or benchmark, reuse an entry's rationale but reassess whether its edits still apply.
5. Revise or override an earlier diagnosis or edit, including an adopted one, when the evidence warrants it.
6. Revisit a direction that was already tested only when there is new evidence, and name that evidence.
7. If no existing entry fits, open a new one.
8. Weight evidence from the current setting above evidence from a different setting.

**Screening.** The scanner checks the rationale, a new root cause, new paths and changed file text, and ignores matches already in the parent. The screen call then looks for task-specific hard-coding, instructions taken from untrusted data, edits that address the grader or shape the output for it instead of doing the task, contradictions, unjustified increases in capability or spend, and repeated directions with no new evidence. A candidate identical to its parent is dropped as `no-change`.

**Selection.** The selector sees each evaluated candidate's score, per-task results, which predicted tasks it fixed and missed, and which tasks regressed. It weighs performance, complexity, domain specificity and regression risk. Selection is a model judgment on the evolve split, not a statistical test. That is why the [Start floor](tasks-and-grading.md) and the [automatic revert](#automatic-revert) exist.

**Context size.** Inputs are sent whole. A context overflow in any call pauses the loop with `optimizer-context-too-large`. Trimming history and memory is not planned.

## Improvement memory

Memory is the optimizer's own record of problems found in a bundle and the adopted attempts to fix them. It is shared per bundle and spans settings. It is separate from the bundle's `memory/` files, is never part of a delivered payload, and no agent sees it.

- **Only an adoption writes.** `write_back` appends one attempt inside the adopt transaction. Keep, failure and stop append nothing.
- **Append-only.** A trigger refuses every update and delete on both memory tables. Nothing rewinds memory, including a [rollback](#rollback).
- **Problems.** A problem is `{id, rootCause, openedRound}` with IDs `P1`, `P2`, … Root causes that match after whitespace is collapsed are the same problem. There is no fuzzy matching.
- **Attempts.** An attempt records its round and sample, what changed and in which files, the predicted tasks, which of them it `fixed` and `missed`, its passing and total rollouts, and its provenance (domain, benchmark, policy model, round). `fixed` and `missed` are computed once, from the incumbent's and the adopted candidate's evaluations in the same round. Task IDs keep today's case ID values, so stored attempts stay valid.
- **Pinned and reproducible.** Rendering is a pure function of bundle and revision. Every call in a round renders the pinned revision and must match the stored digest. `GET /memory?revision=r` returns the same bytes, so an operator can read exactly what the optimizer saw.

## When a round starts


A running loop with no active round starts one when any of these holds:

| Trigger | Condition |
| --- | --- |
| Start or resume | The first round after Start, or after an operator resumes a paused loop |
| After an adoption | The previous round adopted. The new incumbent may have more to gain. |
| Task set changed | Admitted evolve tasks added, edited or retired since the last round's pinned revision number at least 5, or 10% of the live evolve set if that is larger |
| One retry | The previous round adopted nothing and the one before it was not also a non-adopting round on the same task revision. |

A change to held-out tasks alone does not start a round. An adoption that lacks a matching parent score measures the parent in the same round.

**Idle.** After two consecutive rounds that adopt nothing, with no task change between them, the loop idles. Its status stays `running` and its `waiting` field reads `no-new-evidence`. It wakes without any action on the next task-set trigger.

**Daily cap.** Each bundle has `maxRoundsPerDay`, set in the console, default 4, counted over a rolling 24 hours. A triggered round over the cap waits with `waiting: daily-cap` and starts when the window allows.

**Pauses.** The three existing reasons stay: `operator`, `failed-rounds` (three in a row by default) and `optimizer-context-too-large`. One is added: `tasks-required`, when admitted tasks fall below the [Start floor](tasks-and-grading.md) of 20 evolve and 20 held-out. Pause lets the active round finish. Stop cancels open rollouts and optimizer calls.

### Reusing scores

Today every round re-scores its incumbent even when nothing changed. A round reuses the most recent evolve evaluation of the incumbent when the version digest, task revision, task model, judge model and runtime identity all match. It then enters `proposing` directly. Held-out scoring reuses a stored result under the same rule, so a `kept` round on an unchanged set runs no held-out rollouts.

Memory write-back and history read the incumbent's evaluation from the current round, so a reusing round gets a copied evaluation row that points at the original's rollouts. The constraints this touches are listed in [API and data](api-and-data.md).

### Usage

The gateway log gives the tokens of every task-model and judge call, and each optimizer call records its own. The service totals rounds, rollouts and tokens per bundle per day. The console shows them next to the loop, and `GET /usage` returns them.

## After a release

### Held-out drop alert

For an adoption, the service compares the new held-out score with a measurement of the parent at the same task revision and runtime. It measures the parent when there is no matching score. A kept round clears the previous alert. Any drop raises an alert on the bundle, shown as a console banner. Only a clear drop emails workspace administrators, after confirmation settles. The email reports whether the service restored the previous version. The alert identifies the round and shows scores, flips and whether the parent was restored.

### Rollback

`POST /rollback` moves the channel back to the version a named round replaced, in one transaction with the same locks as adoption. The named round’s adopted version must still be the channel head. The caller may attach a note. The loop keeps running.

### Automatic revert

With no approval gate, a person reading an alert would otherwise be the only regression control. The thresholds are starting values that can be tuned.

Automatic revert requires all three conditions:

1. The adopted version's held-out score is at least 0.10 below its parent's.
2. At least two held-out tasks went from pass to fail.
3. A second, fresh held-out scoring of both versions shows the same.

On a clear drop the service restores the parent version, blocks the reverted version, and raises the alert. The loop does not pause. The next round runs from the restored version under the normal triggers.

### A blocked version is not adopted again

Rollback and automatic revert both add the removed version's payload digest to a per-bundle list of blocked versions. A candidate whose resulting payload digest is on the list is dropped before evaluation with the drop reason `blocked-version`.

History does not mark a round as reverted, and the optimizer is given no score, task, count or note about a revert. The memory attempt stays, because memory is append-only, and rule 5 already lets the optimizer override an adopted edit. The optimizer can see in a later round's history that a candidate was dropped as blocked. That is a small leak of held-out signal when the block came from an automatic revert. It is accepted and listed with the assumed decisions.

A person who wants the optimizer to learn why a change was bad writes an evolve task for it. A held-out task rewritten that way is [retired from held-out](tasks-and-grading.md).

If queued rollouts lack a matching live executor for five continuous minutes, the worker ends the round with `no-matching-executor`. This leaves the failed-round counter unchanged. The next round pins the available runtime.

## Compared with the paper and RRSI

The loop follows the SIM paper. [RRSI](https://github.com/google-research/rrsi) is an open implementation of a related harness-improvement loop, which the paper cites. It states several rules as numbers where the paper leaves them to the selector. This table records where Acclimate matches each and where it differs.

| | SIM paper | RRSI | Acclimate |
| --- | --- | --- | --- |
| Candidates and rollouts | Five candidates a round, five rollouts a task. | Two candidates, two trials. | Five candidates, five rollouts. |
| Rounds | Ten per run. | Twenty per run. | Open-ended. A round starts on new evidence, at most four a day by default. |
| Task sets | Split in half at random. The smallest is 24 evolve and 23 held-out tasks. | 120 evolve and 40 held-out. | Split by group hash. Start needs 20 admitted tasks on each side. |
| Held-out | Never passed to the optimizer. Used to report results. | Same. | Never passed to the optimizer. Scored after each round to watch for a regression. |
| Selection | The selector weighs performance, complexity, domain specificity and regression risk. No threshold. | A measured noise band, a score floor and a token-cost rule. | The selector weighs the same four things as the paper. No threshold. |
| Screening | The selector screens before execution. Criteria not stated. | A critic rejects task-specific edits, grader gaming and unbounded work. | A scanner, then a screen call with the rules in [screening](#optimizer). |
| A rollout lost to infrastructure | Stays in the denominator and scores zero. | Scores zero. An evaluation missing more than 10 to 15 percent of its trials is void. | Retried once. If it fails again the evaluation is void: a void incumbent fails the round and a void candidate is skipped. A lost rollout is never a score. |
| After an adoption | Nothing. A later round may replace the change. | Nothing. | Held-out alert, and an automatic revert on a clear, confirmed drop. |
| Noise | Not treated. Results are one run per condition outside coding. | The band is twice the standard deviation of the difference between two scorings of an unchanged harness. | The revert needs a drop of 0.10, two flipped tasks and the same result on a second scoring of both versions. |

The three numbers Acclimate adds have no counterpart in the paper: the floor of 20 tasks, the 0.10 drop and the daily cap. They are starting values. The floor sits just under the paper's smallest split. At that floor a held-out score rests on 100 rollouts, so two scorings of an unchanged version can differ by several points by chance alone, which is why the revert also needs flipped tasks and a second scoring. RRSI's way of measuring the band, repeated scoring of an unchanged version, is the method to use if the 0.10 is tuned.
