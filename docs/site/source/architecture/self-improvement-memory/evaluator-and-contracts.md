# Self-improvement memory evaluator and contracts

An enrolled bundle has an app principal, an evolve split stored by the service and a held-out split stored by the evaluator. Evolve feedback drives the optimizer. Held-out scores monitor the retained version. The [README](README.md#routes) lists the routes and [OpenAPI](../../../contracts/openapi.json) defines the wire types.

## Enrollment

`PUT /v1/workspaces/{workspaceId}/bundles/{bundleId}/learning` accepts `{channel, appPrincipalId, setting, heldOut}`. The channel must already have a release. The caller needs `promote` (administrator for a signed-in user). The app principal can enroll itself, and must be a static grant or active machine token with `evaluate`. The setting is `{domain, benchmark, policyModel}`, with nonblank strings up to 256 bytes and no controls. The held-out commitment is `{digest, cases}` with a `sha256:<64 lowercase hex>` digest and a count from 1 to 10,000. Channel, principal and commitment changes require no active round. Setting changes apply on the next round. The service treats `policyModel` as a setting pin. The evaluator chooses which model to run. [Enrollment](../../../src/learning.rs#L220)

`GET /v1/workspaces/{workspaceId}/principal` returns `{principalId, kind, rights}` for the caller. `kind` is `user` or `machine`, including static grants under `machine`. The rights reflect workspace authorization. [Principal handler](../../../src/workspaces.rs#L34)

## The evolve split

`learning_evolve_cases` stores `case_id`, `input`, `expected`, `source`, optional outcome and version IDs, and the addition and retirement revisions. The service reads cases where `added_revision <= revision` and the retirement revision is absent or greater than that revision. The worker waits for live cases before starting a round. Once started, a round uses only its pinned revision. [Revision query](../../../src/learning/evolve.rs#L106)

- `GET /evolve-cases?after=&limit=` returns `{items, next, evolveRevision}` in bytewise case ID order (default 20, maximum 100). Items are `{caseId, input, expected, addedRevision}`. Signed-in workspace readers and the app principal with read access can list cases. The revision is current on each page. Clients that need a consistent listing check it across pages. [List](../../../src/learning/evolve.rs#L37)
- `POST /evolve-cases` accepts `{cases: [{caseId, input, expected}], retire: [caseId]}` and returns `{evolveRevision, added, retired, liveCases}`. Signed-in writers and the app principal with `evaluate` can mutate cases. The service accepts up to 100 IDs in each list. IDs are immutable, 1–128 ASCII letters, digits or `._:-`. `outcome:` is reserved for additions through the outcomes route. An identical live setup case or already retired case is a no-op. An effective batch bumps the revision once. [Mutation](../../../src/learning/evolve.rs#L168)
- `POST /outcomes` accepts `{outcomeId, versionId, digest, input, expected}` from the app principal with `evaluate`. The version and digest must match this bundle. The UUID outcome ID keys the durable receipt. The first submission inserts `outcome:<outcomeId>` with `source = outcome` and returns `{outcomeId, caseId, evolveRevision}`. Replaying the same request returns the stored receipt, and a differing request with that ID conflicts. [Outcome](../../../src/learning/evolve.rs#L255)

The encoded `input` and `expected` each have a 64 KiB limit. Evolve and held-out cases can share the same shape, but only evolve inputs and rollout evidence appear in optimizer feedback. The evaluator computes the held-out digest from the canonical dataset with cases sorted by ID. The service checks the commitment format and report count. The runner checks the local dataset against the commitment. [Digest](../../../packages/sdk/src/learning/held-out.ts), [validation](../../../src/learning/evolve.rs#L96)

## Evaluator work protocol

The enrolled app principal with `evaluate` can use these routes. `held_out` in SQL is `heldOut` on the wire.

| Route | Request and response |
| --- | --- |
| `GET /work` | Returns `{bundleId, status, items}` with queued and running work before its deadline. Each item has `evaluationId`, `roundId`, `roundNumber`, `role`, `sample`, `split`, `versionId`, `digest`, `evolveRevision`, `heldOut`, `status`, `deadlineAt`. |
| `POST /evaluations/{evaluationId}/start` | Takes `{attemptId}`. Returns `{evaluation, cases, heldOut, reportedCaseIds}`. The evolve assignment includes pinned cases. The held-out assignment includes the commitment and sets `cases` to null. |
| `POST /evaluations/{evaluationId}/report` | Takes `{attemptId, cases: [{caseId, rollouts}]}` or `{attemptId, error}`. The whole-evaluation error is nonempty, at most 1024 bytes and free of NULs. Returns the evaluation document. |

Start binds the attempt and sets the run deadline. The same attempt can resume and see current reported IDs. A different attempt conflicts. Reports accept whole cases, require exactly five rollouts per case, reject duplicate or unassigned evolve IDs, and reject rewrites of an already reported case. Evolve rollouts allow `{score, passed, trace?, error?}`. Held-out rollouts accept exactly `{score, passed}`. The held-out case IDs and rollouts are stored internally for resumable reporting, with no held-out inputs, expected answers or traces in the service. An evaluation score is the mean across cases of each case's five rollout scores in [0, 1]. For memory and selector comparisons, a case passes when at least three rollouts report `passed: true`. [Work](../../../src/learning/evaluations.rs#L162), [start](../../../src/learning/evaluations.rs#L277), [report](../../../src/learning/evaluations.rs#L335)

## Operator reads

`GET /learning` includes `liveCases`, `activeRound` and up to ten recent summaries in `rounds`. `GET /rounds?before=&limit=` returns `{items, next}` in descending round number, default 20 and maximum 100. `GET /rounds/{roundId}` includes pins, candidates, selection and evaluation summaries. The channel revision is a decimal string and the optimizer model and reasoning-effort pins are nullable. Evolve evaluations include `caseSummaries` with `{caseId, passedRollouts, meanScore}`. Append `?evaluation=<evaluationId>` to include that evolve evaluation's full report. A held-out evaluation exposes aggregate status, score and counts, and requesting its report fails. [Round responses](../../../src/learning.rs#L415), [evaluation summaries](../../../src/learning/evaluations.rs#L215)

`GET /memory?revision=` returns a versioned snapshot plus provenance records. A workspace reader can use it unless it is the enrolled app principal. The console presents loop status, round and candidate details, evolve reports and memory using these reads. [Memory](memory.md#10-operator-read-route), [console](../../../apps/console/src/components/bundle-learning.tsx), [console server](../../../apps/console/src/server/learning-loop.ts)

## TypeScript SDK

The TypeScript client methods take a workspace and bundle unless the route is workspace-level.

| Method | Route |
| --- | --- |
| `getPrincipal(workspaceId)` | Workspace `GET /principal` |
| `enrollLearningLoop` and `getLearningLoop` | Learning `PUT` and `GET` |
| `pauseLearningLoop`, `resumeLearningLoop`, `stopLearningLoop` | `POST /pause`, `/resume`, `/stop` |
| `listLearningRounds` and `getLearningRound` | `GET /rounds` and `GET /rounds/{roundId}` |
| `getLearningMemory` | `GET /memory` |
| `listLearningEvolveCases` and `addLearningEvolveCases` | `GET` and `POST /evolve-cases` |
| `reportLearningOutcome` | `POST /outcomes` |
| `getLearningWork`, `startLearningEvaluation`, `reportLearningEvaluation` | `GET /work` and evaluation `POST /start` and `/report` |

The outcome ID is the default idempotency key for outcomes. The attempt ID is the default for start. Report takes a caller-supplied key. [Client methods](../../../packages/sdk/src/client.ts#L429)

`@acclimate/sdk/learning` exports `serveLearningLoop`, `heldOutDigest`, `addEvolveCases`, `createLearningOutcomeReporter`, `defineLoop`, `exact`, `tests`, `openai` and `OpenAIHttpError`, with their public types. The lower-level runner serves one evaluation at a time with a default poll interval of 1000 ms and `caseConcurrency` of 1. Callbacks receive a pinned verified version, case, zero-based rollout and abort signal. Grading receives the expected value. The runner checks the assignment against the work item, verifies the exact version, and checks the local held-out commitment. [Exports](../../../packages/sdk/src/learning/index.ts), [runner](../../../packages/sdk/src/learning/loop.ts#L176)

The runner takes `configPath` or `config`, `bundleId` and an app. A live app requires `allowLive`. Runner options also include `pollIntervalMs`, `signal`, `onDiagnostic` and `shouldServeRound`. A version mismatch reports `evidence.identity_mismatch`. A held-out commitment mismatch reports `learning.held_out_mismatch`.

The runner journals the attempt and individual rollouts under `<journalRoot>/learning/<bundleId>/` with private locks. It resumes unreported cases using completed journal entries and marks interrupted rollouts as uncertain. It retries infrastructure execution failures once. Evaluation errors yield zero and fail the rollout. In evolve reports the runner redacts credential text and captures up to roughly 16 KiB of trace and 4 KiB of error. With concurrent cases, the runner still serializes whole-case reports. The monitor aborts work when it disappears from the feed or the loop stops. [Rollout capture](../../../packages/sdk/src/learning/loop.ts#L98), [journal and work monitor](../../../packages/sdk/src/learning/loop.ts#L213)

`createLearningOutcomeReporter({client, workspaceId, bundleId})` takes a verified version and `{outcomeId, input, expected}` and submits its pinned version ID and digest. `addEvolveCases` checks case IDs and value limits before calling the service. [Outcome helpers](../../../packages/sdk/src/learning/outcomes.ts)

The low-level `acclimate-learning --config <evaluator.json> --bundle <uuid> --app <module> [--live]` runs the evaluator. `acclimate-learning held-out --app <module>` prints its commitment. The app default-exports `{execution, execute, grade, heldOut}`. [Low-level CLI](../../../packages/sdk/src/learning/serve-cli.ts)

`acclimate learn [--config acclimate.loop.ts] [--evaluator-config evaluator.json] [--once]` loads one default-exported definition. Node 22.22+ loads erasable TypeScript natively. `defineLoop` takes the bundle, channel, cases, grader and either an agent or execute callback. Cases can be inline or loaded from JSON/JSONL. Missing IDs derive from canonical input, and hashing the IDs produces the deterministic split (default 0.5 held-out). `openai()` supplies an OpenAI-compatible task agent. [Definition](../../../packages/sdk/src/learning/define.ts#L29), [CLI](../../../packages/sdk/src/learning/learn-cli.ts#L17), [task adapter](../../../packages/sdk/src/learning/openai.ts#L55)

`openai({model, baseURL, apiKey, effort, parse, render})` sends the rendered bundle and case input to `/chat/completions`. `baseURL` falls back to `OPENAI_BASE_URL` and then `https://api.openai.com/v1`. `apiKey` falls back to `OPENAI_API_KEY`. `parse` and `render` override the response parser and bundle rendering. The adapter captures redacted completion traces. [Options and request](../../../packages/sdk/src/learning/openai.ts#L55)

The CLI discovers the app principal or uses `ACCLIMATE_APP_PRINCIPAL`, reconciles enrollment and synchronizes setup cases while preserving outcomes. At HEAD, TypeScript lists and mutates cases in batches of up to 100. Python can shrink oversized listing pages and batch writes by serialized size. Enrollment and case mutations are separate operations, so a running loop can start a round between writes and pin the evolve revision available at that point. Use `ACCLIMATE_URL`, `ACCLIMATE_WORKSPACE` and `ACCLIMATE_TOKEN` or an evaluator config. `ACCLIMATE_ENROLL_TOKEN` supplies a separate enrollment credential when needed. The CLI streams round progress. `--once` exits after the first completed round or reports a stopped or paused loop with no remaining work. Server lifecycle is managed by the learning routes. [Setup](../../../packages/sdk/src/learning/setup.ts), [progress](../../../packages/sdk/src/learning/progress.ts)

`createAcclimate().job(...)` in TypeScript and `Acclimate.job(...)` in Python pin a verified version at job creation. `job.expect` submits a correction using that version's ID and digest and the job's outcome ID. The next round can pick up the new evolve case. [TypeScript jobs](../../../packages/sdk/src/jobs.ts), [Python jobs](../../../python/acclimate/_jobs.py)

## Python SDK

`acclimate.learning` provides `define_loop`, `openai`, `exact`, `tests`, `held_out_digest` and `serve_learning_loop`, with typed learning client methods in `acclimate.client`. Python’s `openai()` takes `base_url` and `api_key` and uses the same environment variables. `python -m acclimate learn [--config acclimate_loop.py] [--once]` loads a module exporting `loop = define_loop(...)`, enrolls, syncs cases and serves work. The runner uses local journals, checks assignment identity and the held-out commitment, and sends only scores and passed flags for held-out rollouts. [Python public API](../../../python/acclimate/learning.py), [task adapter](../../../python/acclimate/_learning_openai.py#L151), [CLI](../../../python/acclimate/_learning_cli.py), [runner](../../../python/acclimate/_learning_runner.py)

## Tests

The PostgreSQL suite verifies enrollment, discovery, paging, case and outcome permissions, revisions, evaluation ownership, evidence shape, expiry and held-out isolation. The end-to-end scripts exercise the SDK runner and one-file CLI against the service. [Rust](../../../tests/learning_loop.rs), [runner](../../../scripts/learning-loop-e2e.ts), [CLI](../../../scripts/learn-cli-e2e.ts)
