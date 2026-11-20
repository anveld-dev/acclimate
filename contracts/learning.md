# Learning loop

Each workspace and bundle can enroll one learning loop. A running loop with live evolve cases starts a new round as soon as the previous round ends. The service pins the channel, channel revision, parent version, setting, evolve revision and held-out commitment at the start of each round.

In phase 3 the loop scores the incumbent, records `kept` with reason `no-candidates`, then scores the retained channel head on the held-out split. The held-out result is a monitoring point for that round. A held-out failure also completes the round and records the error.

## Routes and authority

All paths below are relative to `/v1/workspaces/{workspaceId}/bundles/{bundleId}/learning`. Successful requests return HTTP 200. The [OpenAPI contract](openapi.json) defines each document.

| Method and path | Caller | Response |
| --- | --- | --- |
| `PUT /` | Administrator | `LearningLoop` |
| `GET /` | Reader | `LearningLoop`, active round summary and ten recent round summaries |
| `POST /pause`, `/resume`, `/stop` | Administrator | `LearningLoop` |
| `GET /rounds?before=&limit=` | Reader | `{items, next}`, ordered by round number descending |
| `GET /rounds/{roundId}?evaluation=` | Reader | `LearningRound`, with an optional full evolve report |
| `POST /evolve-cases` | App principal | `{evolveRevision, added, retired, liveCases}` |
| `POST /outcomes` | App principal | `{outcomeId, caseId, evolveRevision}` |
| `GET /work` | App principal | `{bundleId, status, items}` |
| `POST /evaluations/{evaluationId}/start` | App principal | `{evaluation, cases, heldOut, reportedCaseIds}` |
| `POST /evaluations/{evaluationId}/report` | App principal | `LearningEvaluation` |

Workspace administrators and machine principals with `promote` administer a loop. Its app principal must be a static grant or active workspace machine token with `evaluate` authority and is excluded from administering its own loop. A signed-in console user cannot act as the evaluator.

## Enrollment and status

Send `{channel, appPrincipalId, setting, heldOut}`. The channel must already have a release. The setting is `{domain, benchmark, policyModel}`, with each string nonempty, free of control characters and at most 256 UTF-8 bytes. The principal ID is at most 1,024 bytes. The held-out commitment is `{digest, cases}`, with a lowercase SHA-256 digest prefixed with `sha256:` and an integer count from 1 to 10,000.

A new loop is `running` with evolve and memory revisions at zero. While a round is active, changing the channel, app principal or held-out commitment returns `409 learning_conflict`. A setting change takes effect in the next round. An identical enrollment is a no-op except when restarting a stopped loop.

| Current status | Pause | Resume | Stop |
| --- | --- | --- | --- |
| `running` | Let the active round finish, then wait | No change | End the active round and cancel its open work |
| `paused` | No change | Run and clear the pause reason and failed-round count | End the active round and cancel its open work |
| `stopped` | `409` | `409` | No change |

Use `PUT` to start a stopped loop again. Its split and round numbering continue. An operator pause records `operator`. A running loop pauses with `failed-rounds` after consecutive failed rounds reach `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` (default 3). A completed round clears the count.

## Evolve cases and outcomes

Send `{cases: [{caseId, input, expected}], retire: [caseId]}` with at least one entry, no duplicate IDs and at most 100 entries per list. Setup case IDs match `^[A-Za-z0-9._:-]{1,128}$` and reserve the `outcome:` prefix. Input and expected are required JSON values of at most 64 KiB each as encoded. A case ID is immutable. Identically re-adding a live case or re-retiring a retired case is a no-op. Retiring an unknown ID is invalid. A changing request advances the revision exactly once. A round uses its pinned revision throughout.

An outcome sends `{outcomeId, versionId, digest, input, expected}`. The version and digest must identify a version of this bundle. The outcome ID is a UUID and the resulting evolve case ID is `outcome:<outcomeId>` with a lowercase UUID. A correction becomes available in the next round and never triggers a round by itself.

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

Running rounds move through `scoring_incumbent` and `scoring_held_out` to `completed`. Incumbent failure ends the round as `failed` with `incumbent-evaluation-failed`. A stopped round keeps any decision already recorded. Use `before` with the `next` round number returned by the list endpoint. The default page size is 20 and the maximum is 100. Request `?evaluation=<id>` to see one evolve evaluation's full report. A held-out evaluation ID in that parameter returns HTTP 400.

Jobs resolve the channel as usual. A manual release becomes the next round's parent. The held-out measurement uses the channel head at decision time.

## Optimizer and improvement memory

Phase 4 adds proposing, screening, candidate evaluation, selection and improvement memory. A round will generate five candidates and adopt one evaluated survivor or keep the incumbent. An adopt releases that version on the learning channel in the decision transaction. A channel move during the round can produce `kept` / `channel-moved`.

The optimizer will receive the whole bundle, evolve feedback with traces and errors, full run history in the setting and improvement memory. Evolve material may leave the service for the optimizer endpoint and is fenced as untrusted data. The output scanner checks secrets and personal information. Held-out results and reports are excluded from optimizer inputs. Improvement memory will have a reader route at `GET /memory?revision=` that excludes the app principal, and it will remain outside delivered payloads.

## Retries and errors

Enrollment, status changes and evolve mutations take an optional `Idempotency-Key`. Outcomes use the body UUID as a durable receipt key and replay the same result for the same request. Reusing an outcome ID with a different body conflicts. Start and report require `Idempotency-Key`. Start always returns current assignment progress on a valid replay. Report keys replay the original acknowledged evaluation within the command retention window.

Errors include `400 invalid_content`, `401 unauthenticated`, `403 denied`, `404 not_found` and `409 learning_conflict`. Unknown evaluations, including an evaluation from another bundle, fail closed with 404. Request bodies above 2 MiB return 413.
