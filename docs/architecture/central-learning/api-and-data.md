# API and data

**Status: built.** Follow-up work is listed in the [release plan](plan.md#after-the-first-release).

This file lists the routes, rights and schema for central learning. It is the reference for names: the other files in this folder use the route, table, column and enum names given here.

## Routes

All bundle routes sit under `/v1/workspaces/{ws}/bundles/{b}/learning`.

| Route | Purpose | Right |
| --- | --- | --- |
| `PUT` (root) | Turn learning on or change its settings: channel, `domain` and `benchmark`, task model, judge model, `maxRoundsPerDay` | promote |
| `GET` (root) | Loop status, `waiting` reason, pause reason, split counts, active round, alert state | read |
| `POST /start` | Start learning. Start and resume both require 20 admitted tasks per split. | promote |
| `POST /pause`, `/resume`, `/stop` | Unchanged | promote |
| `GET /tasks` | List tasks, paged. Filters: `split`, `source`, `admission`, `flagged` | read |
| `POST /tasks` | Create one task | write |
| `PATCH /tasks/{id}` | Edit a task. Bumps the task revision and re-runs admission. | write |
| `DELETE /tasks/{id}` | Retire a task. Rows are kept. | write |
| `POST /tasks/import` | Streamed upload of a spreadsheet, CSV, JSONL or pasted text. Returns an import with counts, and the drafted task cards for a console session. | write |
| `GET /tasks/imports/{id}` | Import status and counts (`rows`, `converted`, `pending`, `setAsideCount`), a nullable failure `message`, and `setAside: [{row, source, reason}]`. Machine tokens receive an empty list. | read |
| `POST /tasks/{id}/try` | Run one task on the executor against the channel head. Returns a trial ID. | write |
| `GET /trials/{id}` | A trial's status, gateway log, output and verdict | read |
| `GET /held-out-tasks/export` | Download the held-out tasks | console session only |
| `GET /rounds`, `GET /rounds/{id}` | Round timeline, and one round with its candidates, diffs, diagnoses and evolve results | read |
| `POST /rollback` | Move the channel back to the version a named round replaced | promote |
| `GET /usage` | Rounds, rollouts and tokens per day | read |
| `POST /outcomes` | A production outcome from `job.expect()` | write |
| `GET /memory` | Improvement memory at a revision | read |

One workspace route is added: `GET` and `PUT /v1/workspaces/{ws}/model-provider`. It holds the base URL, the key and the allowed models. `PUT` needs a signed-in administrator. Both methods return `verification: {status, checkedAt, models: [{model, ok, usage, message}]}`. Saving resets status to `pending`, checkedAt to null and models to an empty list. Start, resume and new executor work require status `verified`. The key is write-only: `GET` returns whether one is set and never its value.

As today, a signed-in caller needs the administrator role wherever a machine token needs `promote`.

**Request limits.** The service applies a 2 MiB body limit to every route today (`DefaultBodyLimit` in `src/lib.rs`). `/tasks/import` is mounted outside that limit, reads the body as a stream, and has its own cap (64 MiB, with the same limit set in the proxy). Other public routes keep 2 MiB. The internal listener accepts 32 MiB and has 64 independent concurrency permits.

A round pins its task revision at start. Edits apply to the next round.

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
  "limits": {"maxTokens": 200000, "judgeMaxTokens": 64000, "timeoutSeconds": 600},
  "provider": {"baseUrl": "https://proxy.internal:8317/v1", "apiKey": "…"}
}
```

`bundle` is the bundle payload document that delivery serves today. `kind` is `rollout` for round and trial rollouts. `conversion` is added with material conversion.

The judge has a separate 64,000-token allowance across its calls.

**Provider probe.** Saving a provider queues a lease with `{kind:"probe",leaseId,leaseToken,expiresAt,heartbeatSeconds,provider:{baseUrl,apiKey},models:[string]}`. The executor skips the sandbox and makes a minimal chat completion for every listed model. It posts `{models:[{model,ok,usage,message}]}` to the result route. The boolean `usage` records whether the response included a usage object. The message is a brief diagnostic string or null. Verification succeeds when every allowed model answered and reported usage. The executor must check the resolved address at connection time, pin that address, and disable redirects. HTTPS is required except for exact hosts in the comma-separated `ACCLIMATE_PROVIDER_HTTP_HOSTS` setting. Link-local and metadata addresses are always forbidden. Loopback requires an allowlisted host.

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

Error codes are `gateway-upstream`, `sandbox-start` and `executor`. An error result may include the same `tokens: {task, judge}` counts as a scored result when a failed attempt consumed tokens. An error result is accepted from `running` or `grading`. A rollout that stopped on a limit still posts its output and then a failing verdict.

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

A row can produce multiple cards. Rows whose compact JSON representation (including row number, source and material) exceeds 65,536 UTF-8 bytes are set aside with reason `too-large` before conversion. Every card names a source row, and the service rejects a card whose `row` was not in the material.

**Gateway log.** `gatewayLog` and `judgeLog` are lists of `{at, route, model, status, request, response, usage}`, one entry per upstream call, with bodies as sent and received. The provider key is never in an entry.

## Rights

Machine tokens may have `read`, `write` and `promote`. Submitting a production outcome requires `write`.

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

The task schema and cutover migration preserve version and memory history.

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
| `learning_loops` | Add `task_model`, `judge_model`, `max_rounds_per_day` (default 4), `waiting`, `started_at`, `resumed_at`, `alert`. Add `tasks-required` to the `pause_reason` check. |
| `learning_rounds` | Add `task_model`, `judge_model`, `runtime` (the [runtime identity](executor.md)), `trigger`, `incumbent_reused`. |
| `learning_candidates` | Add `blocked-version` to the `drop_reason` check, which allows four values today. |

### Cutover

Migration 0023 cancels active round work, pauses running loops and copies any remaining live cases into the task tables. The service preserves round history and memory. It removes the application principal, held-out commitment, evaluation attempt ID and evaluation deadline. Rollout leases govern retries. Multiple candidate evaluations may be open in a round.

The migration removes the Evaluate right from stored machine grants. A token with no other right receives read access. Set explicit write access on tokens that report outcomes and update static grants before restarting.

## SDK

Use the TypeScript or Python client for loop controls, tasks, trials, provider settings and usage. Production applications can report the expected answer and optional actual output for a pinned job with `job.expect()`.
