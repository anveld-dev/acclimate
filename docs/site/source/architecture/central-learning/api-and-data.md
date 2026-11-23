# API and data

> **Status: proposed, not built.** The [learning contract](../../../contracts/learning.md) describes what ships today. This design replaces it at cutover.

This file lists the proposed routes, rights and schema changes for central learning. It is the reference for names: the other files in this folder use the route, table, column and enum names given here.

## Routes

All bundle routes sit under `/v1/workspaces/{ws}/bundles/{b}/learning`.

| Route | Purpose | Right |
| --- | --- | --- |
| `PUT` (root) | Turn learning on or change its settings: channel, `domain` and `benchmark`, task model, judge model, `maxRoundsPerDay` | promote |
| `GET` (root) | Loop status, `waiting` reason, pause reason, split counts, active round, alert state | read |
| `POST /start` | Start learning. Refused with `tasks-required` below the Start floor. | promote |
| `POST /pause`, `/resume`, `/stop` | Unchanged | promote |
| `GET /tasks` | List tasks, paged. Filters: `split`, `source`, `admission`, `flagged` | read |
| `POST /tasks` | Create one task | write |
| `PATCH /tasks/{id}` | Edit a task. Bumps the task revision and re-runs admission. | write |
| `DELETE /tasks/{id}` | Retire a task. Rows are kept. | write |
| `POST /tasks/import` | Streamed upload of a spreadsheet, CSV, JSONL or pasted text. Returns an import with counts, and the drafted task cards for a console session. | write |
| `GET /tasks/imports/{id}` | Import status and counts of converted, pending and set-aside source rows | read |
| `POST /tasks/{id}/try` | Run one task on the executor against the channel head. Returns a trial ID. | write |
| `GET /trials/{id}` | A trial's status, gateway log, output and verdict | read |
| `GET /held-out-tasks/export` | Download the held-out tasks | console session only |
| `GET /rounds`, `GET /rounds/{id}` | Round timeline, and one round with its candidates, diffs, diagnoses and evolve results | read |
| `POST /rollback` | Move the channel back to the version a named round replaced | promote |
| `GET /usage` | Rounds, rollouts and tokens per day | read |
| `POST /outcomes` | A production outcome from `job.expect()` | write |
| `GET /memory` | Improvement memory at a revision | read |

One workspace route is added: `GET` and `PUT /v1/workspaces/{ws}/model-provider`. It holds the base URL, the key and the allowed models. `PUT` needs a signed-in administrator. The key is write-only: `GET` returns whether one is set and never its value.

As today, a signed-in caller needs the administrator role wherever a machine token needs `promote`.

**Removed routes**

| Route | Replaced by |
| --- | --- |
| `GET /work` | The internal executor listener |
| `POST /evaluations/{id}/start`, `/report` | Rollout leases and results |
| `GET` and `POST /evolve-cases` | `/tasks` |
| `GET /v1/workspaces/{ws}/principal` | Nothing. It exists so the learn CLI can find its own principal. |

**Request limits.** The service applies a 2 MiB body limit to every route today (`DefaultBodyLimit` in `src/lib.rs`). `/tasks/import` is mounted outside that limit, reads the body as a stream, and has its own cap (64 MiB, with the same limit set in the proxy). Every other route keeps 2 MiB.

**Changing settings mid-round.** Today a change to the channel, app principal or held-out commitment is refused with 409 while a round is active. A setting change is accepted. After cutover only a channel change is refused. Task edits and imports are never refused: a round pins its task revision at start, so edits apply to the next round.

### Internal executor listener

The executor has no database access and reaches the service on a separate listener bound to the Compose network. It is not routed through the public proxy. [Executor](executor.md)

| Route | Purpose |
| --- | --- |
| `POST /internal/executor/leases` | Lease the next queued rollout, trial rollout or conversion job. Returns the bundle payload, the task input, the harness, the limits, the provider endpoint and key, and a per-lease token. |
| `POST /internal/executor/leases/{id}/heartbeat` | Extend the lease. A lease that stops heartbeating is requeued. |
| `POST /internal/executor/leases/{id}/output` | Report the agent's output and gateway log. Moves the rollout to `grading` and returns the grader material: the expected answer or criteria, and the judge model. |
| `POST /internal/executor/leases/{id}/result` | Report the verdict and token counts, or an infrastructure error |

Grader material is sent only after the agent's output is in, so it cannot reach the agent step. The provider key is stored encrypted by the service and sent with each lease. The executor keeps it in memory only.

The executor authenticates with its own revocable token, stored hashed, which is not a workspace machine token. Each lease and each result writes a journal entry. Remote executors and mTLS are not planned ([plan](plan.md)).

#### Wire shapes

Bodies are JSON with camelCase fields. The lease route takes the executor token as a bearer token. The other three take the per-lease token.

**Lease.** The request is `{executor: {build, harnesses, sandboxRuntime, runnerImage}, waitSeconds?}`. The service answers 204 when nothing is queued, or 200 with:

```json
{
  "leaseId": "uuid",
  "leaseToken": "opaque",
  "expiresAt": "2026-11-22T10:00:00Z",
  "heartbeatSeconds": 15,
  "kind": "rollout",
  "rolloutId": "uuid",
  "harness": "chat",
  "bundle": {},
  "input": "string, {messages} or other JSON",
  "taskModel": "gpt-6.2-sol",
  "limits": {"maxTokens": 200000, "timeoutSeconds": 600},
  "provider": {"baseUrl": "https://proxy.internal:8317/v1", "apiKey": "…"}
}
```

`bundle` is the bundle payload document that delivery serves today. `kind` is `rollout` for round and trial rollouts. `conversion` is added with material conversion.

**Heartbeat.** The request is `{}` and the response is `{expiresAt}`. A lease the service has already expired answers 409, and the executor stops the rollout.

**Output.** The request is `{output, stop, gatewayLog}`. `output` is the reply text or null. `stop` is `completed`, `token-limit` or `time-limit`. The response is `{grader, judgeModel, judgeRuns}`, where `grader` is the task's grader object.

**Result.** The request is one of:

```json
{"verdict": {"passed": true, "score": 1, "reasons": []},
 "judgeLog": [],
 "tokens": {"task": {"input": 0, "output": 0}, "judge": {"input": 0, "output": 0}}}
```

```json
{"error": {"code": "gateway-upstream", "message": "…"}}
```

Error codes are `gateway-upstream`, `sandbox-start` and `executor`. An error result is accepted from `running` or `grading`. A rollout that stopped on a limit still posts its output and then a failing verdict.

**Judge votes.** A `criteria` verdict also carries `votes`, the pass or fail of each judge run in order, and `reasons` holds the judge's written reason per criterion from the majority run. `passed` is the majority of `votes`.

**Grade leases.** The admission check grades a given output with no agent run. The lease has `kind: "grade"`, no `bundle`, `input` or `harness`, and adds `output` (the reference answer or an empty string), `grader`, `judgeModel` and `judgeRuns`. The executor starts no sandbox, skips the output call and posts a result.

**Conversion leases.** The lease has `kind: "conversion"`, with `judgeModel`, `provider`, `limits` and `material: {format, rows}`, where `format` is `rows` or `conversations` and each row keeps its `row` number and `source`. The executor starts no sandbox, calls the judge model through the gateway and posts:

```json
{"cards": [{"row": 1, "group": "refunds-oct.xlsx#1", "input": "…",
            "grader": {"type": "exact", "expected": "…"}, "criteriaDrafted": false}],
 "setAside": [{"row": 7, "reason": "no-reference"}],
 "judgeLog": [],
 "tokens": {"judge": {"input": 0, "output": 0}}}
```

Every card names a source row, and the service rejects a card whose `row` was not in the material.

**Gateway log.** `gatewayLog` and `judgeLog` are lists of `{at, route, model, status, request, response, usage}`, one entry per upstream call, with bodies as sent and received. The provider key is never in an entry.

## Rights

Machine rights become `read`, `write` and `promote`. `evaluate` is removed.

- **Today:** `RIGHTS` in `src/auth.rs` is `read`, `evaluate`, `write`, `promote`. `evaluate` implies `read`, and `write` implies `evaluate`. Newly minted machine tokens default to `evaluate`.
- **`/outcomes` needs `evaluate` today** and requires the caller to be the loop's app principal. It moves to `write`, and the app-principal check goes away with the column.
- **Existing tokens:** see [migration `0023`](#migration-0023_central_learning_cutoversql).
- **`write` already publishes versions.** If that is too broad for an app that only reports outcomes, a narrow `report` right is the fix.

**What each caller can read of held-out**

| Caller | Evolve tasks, rollouts, gateway logs | Held-out |
| --- | --- | --- |
| Machine token with any right | Full | Split counts, the per-round score and pass count. No task content, IDs, trial logs or per-task results. |
| Signed-in person in the console | Full | Full |
| Optimizer | Evolve only, through the renderer | Nothing |
| Task model and judge | The task being scored | The task being scored, statelessly, through the gateway |
| Conversion model | Uploaded rows before the split is assigned | The same rows |
| Executor | The single task it has leased | The single task it has leased |

The rule is applied by caller type, not by right. `GET /tasks`, `GET /trials/{id}`, `GET /rounds/{id}` and the import response serve held-out content only when the actor is a user session.

## Schema

The latest migration is `0021`. Central learning adds two. `0022` is additive and ships with the tasks phase, while the current evaluator path keeps working. `0023` is destructive and ships at cutover. [Plan](plan.md)

### Migration `0022_central_learning.sql`

**`learning_tasks`** holds evolve tasks. **`learning_held_out_tasks`** has the same shape and holds held-out tasks. The split is assigned by group when a task is created, so a task is written straight to its table and never moves. No optimizer code path queries `learning_held_out_tasks`, and a test enforces that.

| Column | Notes |
| --- | --- |
| `project_id`, `bundle_id`, `task_id` | Primary key. `task_id` keeps today's case ID format and values, so memory attempts that name cases stay valid. Outcome tasks keep `outcome:<id>`. |
| `group` | The source conversation, the import's row group, the job ID of an outcome, or a near-duplicate cluster. The split is a function of the group and never changes. |
| `input` | A string, a `{messages}` list, or other JSON |
| `grader` | `{type: "exact", expected}` or `{type: "criteria", criteria, reference?}` |
| `source` | `import`, `console` or `outcome` |
| `author`, `outcome_id`, `version_id`, `output` | Provenance. An outcome records the delivered version and, when sent, the agent's own output. |
| `confirmed_by` | The person who wrote or confirmed the reference or criteria. Required for a held-out task to be admitted. |
| `admission` | `pending`, `admitted` or `set-aside`, with `admission_reason` |
| `added_revision`, `retired_revision` | The same revision scheme as today's evolve cases. An edit retires the old row's content at one revision and adds the new content at the next, under the same `task_id`. |

**Input and expected values today are arbitrary JSON.** The `chat` harness sends a string input as the user message and a `{messages}` list as the conversation. Any other JSON is sent as its JSON text, which is what the `openai()` adapter does today. `exact` compares the output with `expected` by deep equality, as `exact()` does today. [Tasks and grading](tasks-and-grading.md)

**`learning_rollouts`** is one row per rollout and is the unit the executor leases.

| Column | Notes |
| --- | --- |
| `id`, `evaluation_id` or `trial_id` | Exactly one parent |
| `task_id`, `rollout` | `rollout` is 1–5. Unique per parent and task. |
| `status` | `queued`, `running`, `grading`, `scored`, `converted` (conversion batches), `failed`, `cancelled` |
| `lease_owner`, `lease_expires_at`, `attempts` | Lease state. `attempts` is at most 2. |
| `score`, `passed`, `gateway_log`, `output` | Set when scored |
| `error_code` | Set when failed. A failed row never has a score. |
| `tokens` | Task-model and judge tokens, from the gateway log |

Rollout rows are inserted in the same transaction that queues their evaluation. The service assembles an evaluation's result from them.

**`learning_trials`** is one row per Try run. Its rollouts carry `trial_id`. A trial has no round, never enters history or memory, and never reaches the optimizer.

**Other new tables**

- `workspace_model_providers`: one row per workspace with the base URL, the key encrypted at rest, and the allowed models.
- `learning_usage`: per bundle and day, counts of rounds, rollouts and tokens split by optimizer, task model and judge.
- `learning_blocked_versions`: per bundle, the payload digests removed by rollback or automatic revert, with who or what removed them and an optional note.
- `executor_credentials`: hashed executor tokens with created and revoked times.

**Added columns and widened checks**

| Table | Change |
| --- | --- |
| `learning_loops` | Add `task_model`, `judge_model`, `max_rounds_per_day` (default 4), `waiting`, `idle_rounds`, `alert`. Add `tasks-required` to the `pause_reason` check. |
| `learning_rounds` | Add `task_model`, `judge_model`, `runtime` (the [runtime identity](executor.md)), `trigger`, `incumbent_reused`. |
| `learning_candidates` | Add `blocked-version` to the `drop_reason` check, which allows four values today. |

**Copying existing cases.** Each live row of `learning_evolve_cases` is copied to `learning_tasks` with the same ID, `admission = 'pending'`, and source `import` for `setup` cases or `outcome` for outcome cases. Nothing is copied to held-out: today the service stores only a digest and a count.

### Migration `0023_central_learning_cutover.sql`

Runs in one transaction at cutover.

1. Stop every active round as `stopped`, and cancel its open evaluations and optimizer calls.
2. Pause every running loop with `tasks-required`. A person adds held-out material in the console and starts the loop again. History, memory and round numbers carry over.
3. Drop `learning_evolve_cases`. Rename `learning_loops.evolve_revision` to `task_revision`.
4. Drop `learning_loops.app_principal` and `learning_loops.held_out`, and the pinned `held_out` commitment on `learning_rounds`.
5. Remove `evaluate` from every machine token's rights: take it out of the array, remove duplicates, and add `read` only if the array would be empty. Replace `machine_tokens_rights_check` so it allows only `read`, `write` and `promote`. A token that reported outcomes needs `write` added by an administrator. Static grants in configuration that name `evaluate` are rejected at startup with a clear message.

**`learning_evaluations` changes**, also in `0023`:

- Drop `attempt_id` and the check that requires it for `running` and `scored`.
- Replace the one-open-evaluation-per-round index so candidates can run in parallel.
- Relax `UNIQUE NULLS NOT DISTINCT (round_id, role, sample)` so a round can hold a second held-out scoring for the [automatic revert](loop.md) check, and add columns for the re-score result next to the single `held_out_score` on the round.
- The checks `(role = 'retained') = (split = 'held_out')` and `(split = 'evolve') = (evolve_revision IS NOT NULL)` stay. The column keeps its `held_out` spelling.
- Allow a copied evaluation row for a [reused incumbent score](loop.md). `worker.rs` reads the incumbent and retained evaluations by round and role, and `memory.rs` and `history.rs` read the incumbent evaluation from the same round, so the copy keeps those call sites working.
- Replace the two deadlines with ones derived from rollout leases: the run deadline (`ACCLIMATE_LEARNING_EVALUATION_SECONDS`, default 86400) and the seven-day queue deadline that fills the `NOT NULL` `deadline_at`.

The memory and optimizer-call tables from `0020` are unchanged. Stored memory provenance keeps the old `heldOutDigest` on existing attempts, because memory is append-only. New attempts omit it.

## SDK

`job.expect(expected, { input, output })` gains an optional `output`, the agent's own answer. The outcome wire type gains `output` and the service uses the job ID as the task's group. Today's `Outcome` struct in `src/learning/evolve.rs` denies unknown fields, so this is a wire change. The service rejects an outcome whose `expected` equals its `output`. Outcomes post with `write`.

The typed clients gain the task, trial, start, rollback, usage and model-provider calls and lose the evaluator calls. [Removal](removal.md)
