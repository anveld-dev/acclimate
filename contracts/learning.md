# Learning loop

Each workspace and bundle can enroll one learning loop. The service pins the channel head, task and memory revisions, models, provider endpoint and executor runtime at the start of each round.

A round scores its incumbent on evolve cases, proposes five samples, screens generated candidates, evaluates the survivors and selects a candidate or keeps the channel head. Once it records a decision, it scores the retained head on the held-out split. A terminal rollout failure in the incumbent's evaluation fails the round, and one in a candidate's evaluation skips that candidate. The service retains any release already made and records a held-out failure as an aggregate monitoring error.

## Routes and authority

All paths below are relative to `/v1/workspaces/{workspaceId}/bundles/{bundleId}/learning`. Successful requests return HTTP 200. The [OpenAPI contract](openapi.json) defines each document.

| Method and path | Caller | Response |
| --- | --- | --- |
| `PUT /` | Workspace administrator or machine principal with `promote` | `LearningLoop` |
| `GET /` | Reader | `LearningLoop`, active round summary and ten recent round summaries |
| `POST /start`, `/pause`, `/resume`, `/stop` | Workspace administrator or machine principal with `promote` | `LearningLoop` |
| `GET /rounds?before=&limit=` | Reader | `{items, next}`, ordered by round number descending |
| `GET /rounds/{roundId}?evaluation=` | Reader | `LearningRound`, with an optional full evolve report |
| `GET /memory?revision=` | Reader | `LearningMemory` |
| `POST /outcomes` | Write | Outcome receipt with task revision and either task ID or held-out count |
| `GET /tasks` | Read | Live task cards, next cursor and held-out count |
| `POST /tasks/confirm` | Write, signed-in person | `{revision, results: [{taskId, result}]}` |
| `POST /tasks/{id}/recheck` | Write | `{taskId, admission: "pending"}` |
| `POST /tasks/recheck` | Write | `{taskIds}`, the tasks queued again |
| `POST /tasks` | Write | New pending task, with held-out details restricted to console sessions |
| `PATCH /tasks/{id}`, `DELETE /tasks/{id}` | Write | Edit or retire a task revision |
| `POST /tasks/{id}/try` | Write | Queue one trial at the channel head and return its ID |
| `GET /trials/{id}` | Read | Try status, gateway log, output and verdict, and `error: {code}` when the trial failed. Held-out trials require a console session. |
| `GET /tasks/imports` | Read | `{items}`: the 50 most recent imports, newest first, each shaped like one import's status plus `createdAt` and `source`. Machine callers receive counts and an empty `setAside` |
| `GET /tasks/imports/{id}` | Read | Import status, counts (`rows`, `converted`, `pending`, `setAsideCount`), `message` on failure and `setAside: [{row, source, reason}]` for signed-in sessions. Machine callers receive an empty list |
| `POST /tasks/import` | Write | Import ID, row counts and, for console sessions, drafted cards |
| `GET /held-out-tasks/export` | Console session with read access | All live held-out cards |

New task revisions and unconverted import rows wait for an executor poll. Dispatch requires a channel head and distinct task and judge models allowed by the workspace provider. The service pins the version, models, endpoint and executor identity for each trial. Try pins the version and models when requested and the executor on dispatch.

The result transaction applies admission only to the checked live revision. A held-out task needs human evidence before its check runs. An admission check whose rollouts fail both lease attempts sets the task aside with `check-failed`. `POST /tasks/{id}/recheck` queues that check again on the same revision, and `POST /tasks/recheck` does it for every such task, or for the `taskIds` it is sent (1 to 100). A task in any other state returns 409 from the single route and is skipped by the batch route. Machine callers can recheck evolve tasks only. Editing the task also runs the check again, on a new revision. Conversion receives only the source rows still pending, so rows already imported as exact-match tasks or set aside as too large are left out. Each import has one conversion. If its rollout fails both lease attempts, the import fails with the message `Conversion failed` and is not retried. Uploading the same material again then creates a new import. While an earlier import of the same material has not failed, uploading it again returns that import.

## Enrollment and status

Send `{channel, taskModel, judgeModel, setting, maxRoundsPerDay?}`. The channel must already have a release. The service fills the setting's policy model from the task model. Changes apply to future rounds. Changing the channel during an active round returns 409.

Use Start after both splits meet the admission floor. Pause lets an active round finish. Stop cancels outstanding rollouts and optimizer calls. Start can restart a stopped loop.

## Service-owned tasks

Create a task with `{input, grader}`. The grader is `{type: "exact", expected}` or `{type: "criteria", criteria, reference?}`. The service assigns the ID, source and group and hashes the group with SHA-256. Groups whose digest starts with a zero high bit are held-out. Edits take `input`, `grader` or `confirm: true`, retain the original group and split, and start a pending revision. A signed-in person can confirm held-out criteria. `POST /tasks/confirm` with `{taskIds}` (1 to 100) confirms several in one change. Each ID gets a result: `confirmed`, `already-confirmed`, `not-held-out` or `not-found`. Only confirmed tasks get the new `revision`, which is null when none needed confirming. Machine callers get 403. Historical revisions survive retirement.

List with `split`, `source`, `admission`, `flagged`, `confirmed`, `after` and `limit`. `confirmed=false` lists tasks no person has confirmed yet. The default page has 20 cards and the maximum is 100. Machine credentials can read evolve cards and aggregate held-out counts. Only console sessions can read or change individual held-out tasks.

Import the raw file body with an optional `filename` query parameter. Supported media types are `text/csv`, `application/x-ndjson`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and `text/plain`. An import accepts at most 10,000 material rows. Re-uploading identical bytes in the same bundle returns the original import ID and current counts. Pasted text and `text/plain` uploads split into rows on lines that hold only three or more dashes. Each piece is its own row and its own group, and text with no separator is one row. A row or outcome may set `grading` to `exact` or `criteria`, and any other value returns 400. Without it, an expected answer that is not a string, or is a string of at most 80 characters with no line break, is graded `exact`. A longer or multi-line answer is graded by criteria. A row with both `input` and `expected` fields that is graded `exact` becomes a pending exact task without a model call. Graded by criteria, it goes through conversion: the judge model drafts criteria from the expected answer, which becomes the reference. A held-out task with drafted criteria waits for a person to confirm it. Remaining material retains its source and row number for conversion. Criteria already in a row are used as they are, and the judge model drafts criteria only for a row with an answer and none of its own. A row is set aside as `too-large` above 64 KiB, `no-reference` with no usable answer or criteria, `not-converted` when the model gives no valid mapping in three attempts, or `duplicate` when its input equals the input of a live task in either split or of an earlier row in the same import. Spreadsheet row numbers start at one and advance by 1,048,576 for each subsequent worksheet. Imports group matching source conversations together. Inputs that match after case and whitespace normalization share a group. An import that would join two previously assigned groups returns a conflict. CSV fields are strings and JSONL fields retain their JSON types.

## Outcomes and scoring

Post `{outcomeId, versionId, digest, input, expected, output?, grading?}` with write authority. The version and digest must match the bundle, and a supplied output must differ from the expected value. The service assigns the split using the outcome ID as the group. `grading` follows the import rule above. An outcome graded by criteria becomes a task only when its one-row conversion finishes, so its receipt's `taskRevision` is the current revision and the task appears later. Its input and expected answer together must fit in 64 KiB. If the conversion sets the row aside, no task is created. Such conversions are not listed under `GET /tasks/imports`.

An executor leases five rollouts for each admitted task at the pinned revision. The evaluation score is the mean of the per-task means. An exact-match rollout scores 1 or 0. A judged rollout is judged three times. It passes when at least two judgments pass every criterion, and it scores the share of its criteria met, averaged over the judgments. Three passing rollouts count as a task pass. Infrastructure failures retry once, after which the evaluation fails. Only evolve feedback reaches the optimizer.

## Round history and delivery

Rounds with evaluated candidates move through `scoring_incumbent`, `proposing`, `screening`, `evaluating`, `selecting` and `scoring_held_out` to `completed`. A round with zero candidates or survivors skips the remaining optimizer stages and scores the retained head. Incumbent failure ends the round as `failed` with `incumbent-evaluation-failed`, or with `provider-unavailable` when every failed rollout of that evaluation failed with `gateway-upstream`. `provider-unavailable` does not count toward the `failed-rounds` pause. Round summaries and detail carry `failureCause: {code, message} | null`, the first failed rollout of the evaluation that ended the round, or of a failed held-out check. A held-out cause has `message: null`. A stopped round keeps any decision already recorded. Use `before` with the `next` round number returned by the list endpoint. The default page size is 20 and the maximum is 100. Request `?evaluation=<id>` to see one evolve evaluation's full report. A held-out evaluation ID in that parameter returns HTTP 400.

Jobs resolve the channel as usual. A manual release becomes the next round's parent. The held-out measurement uses the channel head at decision time.

## Optimizer and improvement memory

Set `ACCLIMATE_MODEL_REASONING_EFFORT` to `low`, `medium`, `high`, `xhigh`, `max` or `ultra` to send `reasoning_effort` to the configured chat completions endpoint. When unset, the service omits the request field. The round pins its optimizer model and effort and exposes them as `optimizerModel` and `optimizerReasoningEffort` in round detail.

The service submits five proposals sequentially. Each proposal diagnoses an existing problem or a new root cause and predicts which pinned evolve cases it will fix. The service validates the edits and scans new text for secrets and personal information. Round detail shows each sample's status, diagnosis, changes, scan and screen findings when available, and its evolve evaluation and score. Scanner rejections report the rule, field and safe path, with sensitive text omitted.

The optimizer screens proposals before any candidate version is created. The service creates and evaluates one survivor at a time, then asks the optimizer to weigh performance, complexity, domain specificity and regression risk. The persisted selection records the model, request digest, reason and chosen sample and version when applicable. Adoption releases the selected version and appends one memory attempt in the decision transaction. If the channel revision moved, the round records `kept` with `channel-moved` and retains the original selection for inspection.

Each optimizer request includes the whole harness, current evolve feedback with gateway logs and judge reasons (the service removes system messages from the report because the harness is supplied once), all earlier rounds in the current setting, and the round's pinned improvement memory. This material may leave the service for the configured optimizer endpoint. The service fences it as untrusted data and excludes held-out tasks, reports, scores and errors. An optimizer context error pauses the loop with `optimizer-context-too-large`.

`GET /memory` returns the current revision, the rendered revision, the digest of the canonical `improvementMemory` document and operator records for the attempts at that revision. An invalid revision returns 400 and an unknown revision returns 404. The exact snapshot the optimizer receives is in `improvementMemory`. Operator records also include pinned revision and optimizer model. Memory is append-only and per bundle. Only adopted candidates add attempts. Adoption groups identical whitespace-normalized root causes under the same problem ID. Jobs receive the bundle payload through the usual delivery routes.

See the [memory fixture](fixtures/learning-memory-v1.json) for a sample response. `LearningCandidate` and `LearningSelection` in [openapi.json](openapi.json) define the round detail shapes.

## Retries and errors

Enrollment, status changes take an optional `Idempotency-Key`. Outcomes use the body UUID as a durable receipt key and replay the same result for the same request. Reusing an outcome ID with a different body conflicts.

Errors include `400 invalid_content`, `401 unauthenticated`, `403 denied`, `404 not_found` and `409 learning_conflict`. Unknown evaluations, including an evaluation from another bundle, fail closed with 404. Request bodies above 2 MiB return 413.

## Service-side controls

A signed-in workspace administrator configures the workspace model provider with `PUT /v1/workspaces/{workspaceId}/model-provider` and a JSON body containing `baseUrl`, `allowedModels` and `apiKey`. Readers can GET the same route to see the endpoint, allowed models and `hasKey`. The key is write-only. PUT queues verification and returns pending. Both provider responses include `verification: {status, checkedAt, models: [{model, ok, usage, message}]}`. Status is `pending`, `verified` or `failed`. The timestamp is null while pending. Start and executor work require a verified provider.

Loop enrollment accepts distinct `taskModel` and `judgeModel` from the allowed list, and a positive `maxRoundsPerDay` (default 4). The service fills `setting.policyModel` from the task model. Central enrollments begin paused. Start with `POST /start` after both splits have at least 20 admitted tasks. `POST /start` and `POST /resume` return 409 with code `tasks-required` below that floor, and 409 with code `optimizer-required` when the service has no optimizer model (`ACCLIMATE_MODEL_ENDPOINT` unset). A running loop started this way pauses with `tasks-required` if either count falls below 20. An active round can finish.

The worker pins both models and the task revision. A round records its trigger as `start`, `resume`, `adoption`, `task-change` or `retry`. After two keeps the loop waits for new evidence. A change must affect at least five evolve tasks and at least ten percent of live evolve tasks. The rolling 24-hour cap leaves a triggered round waiting until capacity opens. After a `provider-unavailable` round the loop waits with `provider-unavailable` for ten minutes from that round's end. A person's Start or Resume runs a round at once. Loop GET returns `nextRoundAt` while waiting with `daily-cap` or `provider-unavailable`, and `evolveTasksNeeded` while waiting with `no-new-evidence`: how many more evolve tasks must be added or changed. It also returns `waiting`, `admittedEvolve`, `admittedHeldOut`, `optimizerConfigured` and the aggregate regression `alert`. The starting thresholds are shared by all bundles.

Round detail includes candidate changes, diagnosis and evolve evaluations. Matching incumbent measurements are copied into the next round and marked by `incumbentReused`. The daily `GET /usage` entries use UTC dates and report rounds, rollouts and provider-reported optimizer, task and judge token totals. The flagged task filter selects evolve tasks with judge-vote disagreement, rollout errors, or no passing candidate in two or more measured rounds since their last edit.

An incomplete regression check on an adoption sets the loop alert to `{kind: "regression-check-incomplete", roundId, versionId}` and queues an administrator email. A drop in the held-out score or pass rate raises an alert with `previousScore`, `score`, `previousPassRate`, `passRate`, `flippedTasks` and `reverted`. The pass rate is the share of held-out rollouts that pass. If an adoption's pass rate drops at least 0.10 with two or more pass-to-fail flips, the service measures the parent and adoption again and restores the parent if both thresholds hold again and the channel still points at that release. Operators can request a rollback with `POST /rollback` and `{roundId, note?}`. The removed digest is blocked for future candidates. Historical decisions and memory remain append-only.

Rollback requires the named adoption to be at the channel head. A stale request returns 409 with code `round-not-at-head`. Rollback accepts an optional `Idempotency-Key` and clears the alert. `GET /blocked-versions` returns an array of `{digest,removedBy,note,createdAt,roundId,roundNumber}`. The round is the latest one before the block that adopted a version with that digest, or null. `DELETE /blocked-versions/{digest}` requires promote, writes an audit entry and returns 204.

Round summaries and detail include `progress: {scored,total}` from rollout rows, `reverted`, `confirmedParentScore` and `confirmedAdoptionScore`. The confirmation scores are nullable. Alerts include `reverted` and clear after a later non-dropping round. The loop may wait for `no-executor` or `models-not-allowed`. A stranded round fails with `no-matching-executor` without advancing the failure counter. If it had already adopted, its release stays and the loop raises the `regression-check-incomplete` alert.

Provider PUT permits omission of `apiKey` when the stored URL matches. Changing the URL requires a key. Saving queues verification. The internal output route accepts `invalid-output` followed by a failing verdict with reasons and no votes.

## Codes a script reads

| Field | Values |
| --- | --- |
| Task `admission` | `pending`, `admitted`, `set-aside` |
| Task `admissionReason` | `reference-failed`, `empty-passed`, `judge-unstable`, `check-failed` |
| Task `flagReason` | `rollout-error`, `judge-disagreement`, `persistent-failure` |
| Import `setAside[].reason` | `no-reference`, `not-converted`, `too-large`, `duplicate` |
| Round `reason` with decision `kept` | `selector-kept`, `no-candidates`, `no-survivors`, `no-evaluated-candidates`, `channel-moved` |
| Round `reason` with state `failed` | `incumbent-evaluation-failed`, `provider-unavailable`, `optimizer-unavailable`, `optimizer-context-too-large`, `selector-unavailable`, `no-matching-executor` |
| Round `reason` with state `stopped` | `stopped`, unless a decision was already recorded |
| Round `heldOutError` | `rollout-failed`, `regression-check-incomplete`, `no-matching-executor` |
| Round `failureCause.code` and trial `error.code` | `gateway-upstream` (the model provider failed), `sandbox-start`, `executor`, `judge-budget`, `judge-invalid-reply`. A trial can also report `cancelled` |
| Loop `waiting` | `no-new-evidence`, `daily-cap`, `no-executor`, `models-not-allowed`, `provider-unavailable` |
| Loop `pauseReason` | `operator`, `failed-rounds`, `optimizer-context-too-large`, `tasks-required` |
| Task confirmation `result` | `confirmed`, `already-confirmed`, `not-held-out`, `not-found` |
