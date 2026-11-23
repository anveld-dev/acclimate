# Learning loop

Each workspace and bundle can enroll one learning loop. A running loop with live evolve cases starts a new round as soon as the previous round ends. The service pins the channel, channel revision, parent version, setting, evolve revision and held-out commitment at the start of each round.

A round scores its incumbent on evolve cases, proposes five samples, screens generated candidates, evaluates the survivors and selects a candidate or keeps the channel head. Once it records a decision, it scores the retained head on the held-out split. A held-out failure completes the round and records the monitoring error.

## Routes and authority

All paths below are relative to `/v1/workspaces/{workspaceId}/bundles/{bundleId}/learning`. Successful requests return HTTP 200. The [OpenAPI contract](openapi.json) defines each document.

| Method and path | Caller | Response |
| --- | --- | --- |
| `PUT /` | Workspace administrator or machine principal with `promote` | `LearningLoop` |
| `GET /` | Reader | `LearningLoop`, active round summary and ten recent round summaries |
| `POST /pause`, `/resume`, `/stop` | Workspace administrator or machine principal with `promote` | `LearningLoop` |
| `GET /rounds?before=&limit=` | Reader | `{items, next}`, ordered by round number descending |
| `GET /rounds/{roundId}?evaluation=` | Reader | `LearningRound`, with an optional full evolve report |
| `GET /memory?revision=` | Reader, excluding the app principal | `LearningMemory` |
| `GET /evolve-cases?after=&limit=` | App principal or signed-in workspace member with `read` | `{items: [{caseId, input, expected, addedRevision}], next, evolveRevision}` |
| `POST /evolve-cases` | App principal or signed-in workspace member with `write` | `{evolveRevision, added, retired, liveCases}` |
| `POST /outcomes` | App principal | Outcome receipt with evolve revision and either case ID or held-out count |
| `GET /tasks` | Read | Live task cards, next cursor and held-out count |
| `POST /tasks` | Write | New pending task, with held-out details restricted to console sessions |
| `PATCH /tasks/{id}`, `DELETE /tasks/{id}` | Write | Edit or retire a task revision |
| `POST /tasks/import` | Write | Import ID, row counts and, for console sessions, drafted cards |
| `GET /held-out-tasks/export` | Console session with read access | All live held-out cards |
| `GET /work` | App principal | `{bundleId, status, items}` |
| `POST /evaluations/{evaluationId}/start` | App principal | `{evaluation, cases, heldOut, reportedCaseIds}` |
| `POST /evaluations/{evaluationId}/report` | App principal | `LearningEvaluation` |

Workspace administrators and machine principals with `promote` administer a loop. Its app principal must be a static grant or active workspace machine token with `evaluate` authority. A signed-in console user cannot act as the evaluator.

## Enrollment and status

Send `{channel, appPrincipalId, setting, heldOut}`. The channel must already have a release. The setting is `{domain, benchmark, policyModel}`, with each string nonempty, free of control characters and at most 256 UTF-8 bytes. The principal ID is at most 1,024 bytes. The held-out commitment is `{digest, cases}`, with a lowercase SHA-256 digest prefixed with `sha256:` and an integer count from 1 to 10,000.

Enrollment needs `promote`: a workspace administrator, or a machine principal with `promote`. The app principal may enroll itself, so one machine token with `promote` and `evaluate` can enroll, serve evaluations and report outcomes. `GET /v1/workspaces/{workspaceId}/principal` returns the caller's `{principalId, kind, rights}` in the workspace (`kind` is `machine` or `user`; a member's `promote` means the admin role), so a client holding an opaque token can enroll as itself. Improvement memory stays unreadable to the app principal.

A new loop is `running` with evolve and memory revisions at zero. While a round is active, changing the channel, app principal or held-out commitment returns `409 learning_conflict`. A setting change takes effect in the next round. An identical enrollment is a no-op except when restarting a stopped loop.

| Current status | Pause | Resume | Stop |
| --- | --- | --- | --- |
| `running` | Let the active round finish, then wait | No change | End the active round and cancel its open work |
| `paused` | No change | Run and clear the pause reason and failed-round count | End the active round and cancel its open work |
| `stopped` | `409` | `409` | No change |

Use `PUT` to start a stopped loop again. Its split and round numbering continue. An operator pause records `operator`. A running loop pauses with `failed-rounds` after consecutive failed rounds reach `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` (default 3). A completed round clears the count.

## Service-owned tasks

Create a task with `{input, grader}`. The grader is `{type: "exact", expected}` or `{type: "criteria", criteria, reference?}`. The service assigns the ID, source and group and hashes the group with SHA-256. Groups whose digest starts with a zero high bit are held-out. Edits take `input`, `grader` or `confirm: true`, retain the original group and split, and start a pending revision. A signed-in person can confirm held-out criteria. Historical revisions survive retirement.

List with `split`, `source`, `admission`, `flagged`, `after` and `limit`. The default page has 20 cards and the maximum is 100. Machine credentials can read evolve cards and aggregate held-out counts. Only console sessions can read or change individual held-out tasks.

Import the raw file body with an optional `filename` query parameter. Supported media types are `text/csv`, `application/x-ndjson`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and `text/plain`. Rows with both input and expected fields become pending exact tasks. Remaining material retains its source and row number for conversion. Spreadsheet row numbers start at one and advance by 1,048,576 for each subsequent worksheet. Imports group matching source conversations together. Inputs that match after case and whitespace normalization share a group. An import that would join two previously assigned groups returns a conflict. CSV fields are strings and JSONL fields retain their JSON types.

## Evolve cases and outcomes

Send `{cases: [{caseId, input, expected}], retire: [caseId]}` with at least one entry, no duplicate IDs and at most 100 entries per list. Setup case IDs match `^[A-Za-z0-9._:-]{1,128}$` and reserve the `outcome:` prefix. Input and expected are required JSON values of at most 64 KiB each as encoded. A case ID is immutable. Identically re-adding a live case or re-retiring a retired case is a no-op. Retiring an unknown ID is invalid. A changing request advances the revision exactly once. A round uses its pinned revision throughout.

An outcome sends `{outcomeId, versionId, digest, input, expected, output?}`. The pinned version and digest must belong to the bundle. An explicitly supplied output must differ from the expected JSON value. The job's outcome UUID is the group. Evolve outcomes also enter the current evaluator as `outcome:<outcomeId>`. Held-out outcomes stay in service custody and return a count. Repeated reports replay their original receipts.

List live evolve cases in ascending ASCII case ID order. Use `next` as the exclusive `after` cursor for the next page. Omit `after` or leave it empty for the first page. The page size defaults to 20 and accepts 1–100. The final page returns `next: null`. The response reports the evolve revision used for that page. Restart listing if the revision changes while collecting a snapshot. The listing excludes retired and held-out cases and returns 404 if no loop is enrolled.

## Held-out split

The evaluator keeps the held-out examples in its own store. To compute its commitment, hash the canonical JSON of each case's input and expected values to lowercase SHA-256 hex. Sort the resulting `{caseId, input, expected}` records by case ID, encode the array with the same canonical JSON encoder, hash it with SHA-256 and add the `sha256:` prefix. The [shared digest fixture](fixtures/learning-held-out-v1.json) contains examples.

The evaluator verifies the digest and count against the round's commitment before scoring. If they differ, report the error `learning.held_out_mismatch`. Held-out rollouts accept only `score` and `passed`. Reader routes return aggregate evaluation scores and progress but omit held-out case IDs and per-case results. Only the authenticated evaluator receives its previously reported IDs when resuming an assignment.

## Evaluator protocol

1. Poll work for queued or running evaluations, including while the loop is paused. A stopped loop's work feed is empty.
2. Persist an attempt ID of 1 to 128 bytes and call start with `{attemptId}`. A restart uses the same attempt and skips `reportedCaseIds`. A different attempt cannot take over a running or scored evaluation. Evolve assignments carry pinned cases and held-out assignments carry the pinned commitment.
3. Report one or more complete cases as `{attemptId, cases: [{caseId, rollouts}]}`. Every case has five rollouts with numeric `score` from 0 to 1 and boolean `passed`. Evolve rollouts may carry string or null `trace` and `error` fields, bounded by the 2 MiB request limit. Three passing rollouts make a case pass. The evaluation score is the equal-case mean of rollout scores.
4. The final case marks the evaluation `scored`. Submit `{attemptId, error}` to mark it `failed`, with an error of up to 1 KiB. A running evaluation accepts an identical stored case again and rejects changes to a stored case.
5. Stop serving work when the item leaves the feed. Stop cancels open evaluations. Queue and run deadlines mark them failed after `ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS` (default 604,800) and `ACCLIMATE_LEARNING_EVALUATION_SECONDS` (default 86,400), respectively.

## Round history and delivery

Rounds with evaluated candidates move through `scoring_incumbent`, `proposing`, `screening`, `evaluating`, `selecting` and `scoring_held_out` to `completed`. A round with zero candidates, survivors or scored candidates skips the remaining optimizer stages and scores the retained head. Incumbent failure ends the round as `failed` with `incumbent-evaluation-failed`. A stopped round keeps any decision already recorded. Use `before` with the `next` round number returned by the list endpoint. The default page size is 20 and the maximum is 100. Request `?evaluation=<id>` to see one evolve evaluation's full report. A held-out evaluation ID in that parameter returns HTTP 400.

Jobs resolve the channel as usual. A manual release becomes the next round's parent. The held-out measurement uses the channel head at decision time.

## Optimizer and improvement memory

Set `ACCLIMATE_MODEL_REASONING_EFFORT` to `low`, `medium`, `high`, `xhigh`, `max` or `ultra` to send `reasoning_effort` to the configured chat completions endpoint. When unset, the service omits the request field. The round pins its optimizer model and effort and exposes them as `optimizerModel` and `optimizerReasoningEffort` in round detail.

The service submits five proposals sequentially. Each proposal diagnoses an existing problem or a new root cause and predicts which pinned evolve cases it will fix. The service validates the edits and scans new text for secrets and personal information. Round detail shows each sample's status, diagnosis, changes, scan and screen findings when available, and its evolve evaluation and score. Scanner rejections report the rule, field and safe path, with sensitive text omitted.

The optimizer screens proposals before any candidate version is created. The service creates and evaluates one survivor at a time, then asks the optimizer to weigh performance, complexity, domain specificity and regression risk. The persisted selection records the model, request digest, reason and chosen sample and version when applicable. Adoption releases the selected version and appends one memory attempt in the decision transaction. If the channel revision moved, the round records `kept` with `channel-moved` and retains the original selection for inspection.

Each optimizer request includes the whole harness, current evolve feedback with full traces and errors, all earlier rounds in the current setting, and the round's pinned improvement memory. This material may leave the service for the configured optimizer endpoint. The service fences it as untrusted data and excludes held-out commitments, reports, scores and errors. An optimizer context error pauses the loop with `optimizer-context-too-large`.

`GET /memory` returns the current revision, the rendered revision, the digest of the canonical `improvementMemory` document and operator records for the attempts at that revision. An invalid revision returns 400 and an unknown revision returns 404. The exact snapshot the optimizer receives is in `improvementMemory`. Operator records also include pinned evolve revision, held-out digest and optimizer model. Memory is append-only and per bundle. Only adopted candidates add attempts. Adoption groups identical whitespace-normalized root causes under the same problem ID. Jobs receive the bundle payload through the usual delivery routes.

See the [memory fixture](fixtures/learning-memory-v1.json) for a sample response. `LearningCandidate` and `LearningSelection` in [openapi.json](openapi.json) define the round detail shapes.

## Retries and errors

Enrollment, status changes and evolve mutations take an optional `Idempotency-Key`. Outcomes use the body UUID as a durable receipt key and replay the same result for the same request. Reusing an outcome ID with a different body conflicts. Start and report require `Idempotency-Key`. Start always returns current assignment progress on a valid replay. Report keys replay the original acknowledged evaluation within the command retention window.

Errors include `400 invalid_content`, `401 unauthenticated`, `403 denied`, `404 not_found` and `409 learning_conflict`. Unknown evaluations, including an evaluation from another bundle, fail closed with 404. Request bodies above 2 MiB return 413.
