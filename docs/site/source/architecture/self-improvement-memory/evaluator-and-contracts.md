# Self-improvement memory: evaluator and contracts

This file is the app-facing contract after the change. It covers enrollment, the evolve and held-out splits, how corrections become evolve cases, the evaluator work protocol, every loop route and wire type, the TypeScript and Python SDKs, delivery, the console loop page, the `contracts/learning.md` rewrite and the tests. Names come from the [README](README.md#names). The round state machine is in the [README](README.md#round-state-machine) and [loop.md](loop.md).

| Topic | Owner |
| --- | --- |
| `learning_evolve_cases`, `learning_evaluations`, `src/learning.rs`, `src/learning/evaluations.rs`, `src/learning/evolve.rs`, every loop route, wire DTO, OpenAPI entry, SDK type and client method, `serveLearningLoop`, `createLearningOutcomeReporter`, `addEvolveCases`, the `acclimate-learning` bin, the console loop page, the `contracts/learning.md` rewrite | This file |
| `learning_loops`, `learning_rounds`, `tick`, `start_round`, `adopt`, `sweep`, when evaluations are queued | [loop.md](loop.md) |
| `feedback`, `history`, the screen and select calls, `learning_candidates` rows | [optimizer.md](optimizer.md) |
| The memory tables and the `GET /memory` document | [memory.md](memory.md) |
| Deleting the connection learning routes, tables, SDK driver and console pages | [removal.md](removal.md) |

## Decisions

1. **One app principal per loop.** It submits evolve cases and outcomes and runs the evaluator. It must hold `evaluate` on the workspace. It may be a machine-token principal (`machine:…`) or a static grant principal, and `learning_loops.app_principal` has no prefix check ([loop.md](loop.md)). Today's separate outcome and evaluator principals and their trust-domain rule (`src/connected_learning.rs:224-226`, `:402-419`) go (D7).
2. **The service holds the evolve split. The evaluator holds the held-out split.** Evolve cases (`input`, `expected`) are stored in `learning_evolve_cases` and sent to the evaluator with each evolve evaluation. Held-out cases never leave the evaluator. The service stores only the commitment `heldOut = {digest, cases}` and per-rollout `score` and `passed`.
3. **Corrections are evolve cases.** `POST /outcomes` with an `expected` result adds the evolve case `outcome:<outcomeId>` under a new evolve revision. There is no lesson, feedback, correction, recheck or admission. An outcome never starts a round (D4).
4. **Reports go one case at a time.** `POST /evaluations/{evaluationId}/report` accepts one or more whole cases. The evaluation is `scored` when every expected case has arrived. Each body stays under the existing 2 MiB request limit (`src/lib.rs:250`), the runner's progress is visible, and a restarted runner skips the cases already stored.
5. **Held-out reports are refused if they carry anything but scores.** A held-out rollout with a `trace` or `error` key gets `400 invalid_content`. The SDK never builds one.
6. **Ownership fails closed.** `authorize_evaluation` returns `404` for an evaluation ID that is not in this loop and `403` for any caller other than the loop's app principal. Today's `authorize_evaluator` returns success for an unknown ID (`src/connected_learning.rs:1119-1121`).
7. **Changes that would move work mid-round wait for the round.** A `PUT` that changes `channel`, `appPrincipalId` or `heldOut` returns `409 learning_conflict` while a round is active. A `setting` change is accepted at any time, because `start_round` pins `setting`. So "a change applies from the next round" holds for every field. `start_round` also pins `learning_rounds.channel` and `learning_rounds.held_out` ([loop.md](loop.md)). They are the record that memory provenance, the held-out evaluation, `start`, `GET /work` and the report checks read.
8. **Delivery is unchanged.** Jobs resolve the loop's channel as they resolve any channel. An adopt is an ordinary release on that channel. The native plugins need no change.
9. **No new error codes.** Loop routes use `invalid_content`, `not_found`, `denied`, `unauthenticated` and `learning_conflict`, which the SDK already lists (`packages/sdk/src/client.ts:101`).

## Enrollment

`PUT /v1/workspaces/{workspaceId}/bundles/{bundleId}/learning`

```json
{
  "channel": "stable",
  "appPrincipalId": "machine:support-app",
  "setting": {"domain": "support", "benchmark": "support-tickets-v3", "policyModel": "gpt-6-luna"},
  "heldOut": {"digest": "sha256:9f2c…", "cases": 30}
}
```

| Rule | Detail |
| --- | --- |
| Caller | A workspace administrator: a signed-in admin, or a machine principal with `promote`, as `learning_admin` does today (`src/connected_learning.rs:204-212`). The app principal may enroll itself when it holds `promote` (amendment 2026-11-20, [decisions.md](decisions.md)); `GET /v1/workspaces/{workspaceId}/principal` lets a client find its own principal ID. Enrolling authorizes releases on `channel`, so `enrolled_by` records the caller of every accepted `PUT`. |
| Body | Closed (`deny_unknown_fields`). Old fields such as `permittedPaths`, `automaticRollout`, `audits` or `outcomePrincipal` get `400 invalid_content`. |
| `channel` | Passes `valid_channel` (`src/channels.rs:3-8`) and already has a release on this bundle. A channel with no head gets `400` "Release a version on the learning channel first". |
| `appPrincipalId` | At most 1,024 bytes. Holds `evaluate` (directly or through `write`, `src/auth.rs:9-15`) on this workspace through a static grant (checked as `src/connected_learning.rs:402-410` does) or an active `machine_tokens` row with that `principal_id`. Otherwise `400`. |
| `setting` | Three nonempty strings of at most 256 bytes with no control characters, checked like `validate_proposer_model` (`src/lib.rs:284-293`). |
| `heldOut` | `digest` matches `^sha256:[0-9a-f]{64}$`. `cases` is an integer from 1 to 10,000. |
| First `PUT` | Inserts the `learning_loops` row with `status = 'running'`, `evolve_revision = 0`, `memory_revision = 0`, `next_round = 1`, `failed_rounds = 0`. No round starts until the evolve split has a live case (see "The evolve split"). |
| Later `PUT` | `stopped` becomes `running`. `running` and `paused` keep their status. A change to `channel`, `appPrincipalId` or `heldOut` while a round is in an active state returns `409 learning_conflict` "Pause the loop and let the round end first". An identical body returns the current loop. |
| Retry | Optional `Idempotency-Key`, through `DurableCommand::optional` as enrollment does today (`src/connected_learning.rs:435-442`). |

Response: the `LearningLoop` document (see "Wire types").

`POST /pause`, `POST /resume`, `POST /stop` take no body, need the same administrator, and accept an optional `Idempotency-Key`.

| Route | From | Result |
| --- | --- | --- |
| `/pause` | `running` | `paused`, `pause_reason = 'operator'`. The active round runs to its end. |
| `/pause` | `paused` | No change |
| `/resume` | `paused` | `running`. Clears `pause_reason` and `failed_rounds`. |
| `/resume` | `running` | No change |
| `/stop` | `running`, `paused` | `stopped`. Calls `worker::stop_round` in the same transaction ([loop.md](loop.md)), which cancels the round's queued and running evaluations. |
| `/stop` | `stopped` | No change |
| `/pause`, `/resume` | `stopped` | `409 learning_conflict`. Use `PUT` to restart. |

## The evolve split

### Table

Migration `0019_learning_loop.sql`, after `learning_loops`:

```sql
CREATE TABLE learning_evolve_cases (
    project_id text NOT NULL,
    bundle_id uuid NOT NULL,
    case_id text NOT NULL,
    input jsonb NOT NULL,
    expected jsonb NOT NULL,
    source text NOT NULL CHECK (source IN ('setup', 'outcome')),
    outcome_id uuid,
    version_id uuid,
    added_revision bigint NOT NULL CHECK (added_revision > 0),
    retired_revision bigint,
    PRIMARY KEY (project_id, bundle_id, case_id),
    FOREIGN KEY (project_id, bundle_id) REFERENCES learning_loops(project_id, bundle_id),
    FOREIGN KEY (project_id, bundle_id, version_id) REFERENCES versions(project_id, bundle_id, id),
    UNIQUE (project_id, bundle_id, outcome_id),
    CHECK ((source = 'outcome') = (outcome_id IS NOT NULL)),
    CHECK ((source = 'outcome') = (version_id IS NOT NULL)),
    CHECK (source = 'setup' OR case_id = 'outcome:' || outcome_id::text),
    CHECK (source = 'outcome' OR case_id NOT LIKE 'outcome:%'),
    CHECK (retired_revision IS NULL OR retired_revision > added_revision),
    CHECK (case_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);
CREATE INDEX learning_evolve_cases_live
    ON learning_evolve_cases (project_id, bundle_id, added_revision)
    WHERE retired_revision IS NULL;
```

The versions foreign key uses the existing `UNIQUE (project_id, bundle_id, id)` on `versions` (`migrations/0001_init.sql:149`).

### Rules

- A case is **live at revision r** when `added_revision <= r` and `retired_revision` is NULL or greater than r. `cases_at(r)` returns those rows ordered by `case_id`. Rows are never updated except to set `retired_revision`, and never deleted, so every past revision can be rebuilt.
- A case ID is immutable. Re-adding a live case with identical `input` and `expected` (compared as canonical JSONB) is a no-op. Any other add of an existing ID, live or retired, is `409 learning_conflict`. To change a case, retire it and add it under a new ID. This keeps memory's `predicted`, `fixed` and `missed` IDs meaningful forever.
- `input` and `expected` are any JSON value of at most 64 KiB each, as encoded. The app's evaluator defines their meaning.
- Every request that changes the split takes the `learning_loops` row lock (`SELECT … FOR UPDATE`), increments `evolve_revision` by exactly 1, and stamps every added and retired row with the new value. A request that changes nothing leaves the revision as it is.
- A round uses one revision throughout: `start_round` pins `learning_rounds.evolve_revision`, and every evolve evaluation in the round copies it. Cases added during a round count from the next round.
- `tick` starts no round while `cases_at(evolve_revision)` is empty ([loop.md](loop.md) applies this check). The loop stays `running` and waits.
- The split has no size limit in the MVP. See open question 2.

### `POST /evolve-cases`

Caller: the app principal (`evaluate`, equal to `learning_loops.app_principal`). Accepted in every loop status, because the split outlives a stop.

```json
{
  "cases": [{"caseId": "refund-07", "input": {"ticket": "…"}, "expected": {"action": "refund"}}],
  "retire": ["refund-02"]
}
```

| Check | Result |
| --- | --- |
| Both lists empty or absent | `400` |
| More than 100 cases or 100 retirements, or a duplicate ID in one body | `400` |
| An added ID starting `outcome:` | `400`. Outcome cases come only from `POST /outcomes`. |
| Retiring an unknown ID | `400` |
| Retiring an already retired ID | No-op |
| Retiring an `outcome:` case | Allowed |

Response `LearningEvolveCasesReceipt`: `{"evolveRevision": 8, "added": 1, "retired": 1, "liveCases": 31}`. Optional `Idempotency-Key` through `DurableCommand::optional`.

`src/learning/evolve.rs`: `add_cases(tx, loop_row, cases) -> ApiResult<usize>`, `retire_cases(tx, loop_row, ids) -> ApiResult<usize>`, `submit_outcome` (the handler below) and `cases_at(tx, project, bundle, revision) -> ApiResult<Vec<EvolveCase>>`.

### `POST /outcomes`: corrections become evolve cases

Caller: the app principal.

```json
{
  "outcomeId": "0f7c1e1a-5b7e-4d0e-9a51-6f0f6a0f2c11",
  "versionId": "6f1c…",
  "digest": "sha256:…",
  "input": {"ticket": "…"},
  "expected": {"action": "escalate"}
}
```

- `outcomeId` is a UUID that the app persists with its job. `versionId` and `digest` name the version the job ran. They must be a version of this bundle with that digest (`SELECT EXISTS(SELECT 1 FROM versions WHERE (project_id,bundle_id,id,digest)=($1,$2,$3,$4))`), else `400`. Today's tighter check that the version was served on the connection (`src/connected_learning.rs:884-892`) goes with connections owning learning. The version is provenance only.
- `input` and `expected` follow the evolve case limits. `expected` is required. An app that has no expected result for a job does not report it: the optimizer learns only from cases it can be scored on.
- The handler adds `outcome:<outcomeId>` (lowercase UUID) with `source = 'outcome'` under a new evolve revision, in the same transaction as the receipt.
- Retries use the durable receipt keyed by `outcomeId`, as today (`src/connected_learning.rs:855-870`). The same body returns the original response. A different body under the same ID is `409 learning_conflict`. The scope string is `learning/{bundle_id}/outcome`. `DurableCommand::new` already builds `learning/{id}/{operation}` from a UUID (`src/commands.rs:532-550`). Rename its `integration` parameter to `scope_id`.
- Response `LearningOutcomeReceipt`: `{"outcomeId": "…", "caseId": "outcome:0f7c…", "evolveRevision": 9}`.

Removed with this route's old shape: `status`, `lesson`, `feedback`, `startedReceiptId`, `deliveryRevision`, `requireIncidentReplay`, the field-audit control and the correction queue (`src/connected_learning.rs:163-178`, `:908-996`).

## The held-out split

- The evaluator keeps its held-out cases in its own store (for the SDK runner, the app module's `heldOut` array). Nothing in the service can read them.
- `heldOut.digest` commits to the cases. The SDK computes it with `heldOutDigest(cases)`: `"sha256:" + hex(sha256(canonical([{caseId, input: hex(sha256(canonical(input))), expected: hex(sha256(canonical(expected)))}] sorted by caseId)))`, with `canonical` the existing canonical JSON encoder (`packages/sdk/src/evaluation/manifest.ts:80`). This is the same construction as today's `installed-v1` dataset digest (`packages/sdk/src/learning/connected-fixtures.ts:12-20`), without repetitions. [removal.md](removal.md) must keep the encoder or move it under `packages/sdk/src/learning/`.
- An administrator enrolls with the `{digest, cases}` that `acclimate-learning held-out --app ./app.mjs` prints.
- Before serving a `held_out` evaluation, the runner checks that its local digest and case count equal the work item's `heldOut`, which is the round's pinned `learning_rounds.held_out`. On a mismatch it reports the evaluation as failed with the code `learning.held_out_mismatch`, so the round completes with `held_out_error` set and a stale evaluator cannot score the wrong split.
- The service stores the held-out report (case IDs, scores, passes) for integrity checks and returns only the evaluation's `score`, case count, status and error. No route returns held-out case IDs or per-case results, and no optimizer input reads them. `held_out_score` is the only held-out value outside the evaluation row, and only `learning_rounds` and the console read it.

## Evaluations

### Table

Migration `0019_learning_loop.sql`, after `learning_rounds`:

```sql
CREATE TABLE learning_evaluations (
    id uuid PRIMARY KEY,
    round_id uuid NOT NULL REFERENCES learning_rounds(id),
    role text NOT NULL CHECK (role IN ('incumbent', 'candidate', 'retained')),
    sample smallint CHECK (sample BETWEEN 1 AND 5),
    split text NOT NULL CHECK (split IN ('evolve', 'held_out')),
    version_id uuid NOT NULL REFERENCES versions(id),
    digest text NOT NULL,
    evolve_revision bigint,
    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'scored', 'failed', 'cancelled')),
    attempt_id text CHECK (octet_length(attempt_id) BETWEEN 1 AND 128),
    report jsonb NOT NULL DEFAULT '{"cases": []}',
    score double precision CHECK (score >= 0 AND score <= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    deadline_at timestamptz NOT NULL,
    error text CHECK (octet_length(error) <= 4096),
    UNIQUE NULLS NOT DISTINCT (round_id, role, sample),
    CHECK ((role = 'candidate') = (sample IS NOT NULL)),
    CHECK ((role = 'retained') = (split = 'held_out')),
    CHECK ((split = 'evolve') = (evolve_revision IS NOT NULL)),
    CHECK ((status = 'scored') = (score IS NOT NULL)),
    CHECK (status NOT IN ('running', 'scored') OR (attempt_id IS NOT NULL AND started_at IS NOT NULL))
);
-- W3 in loop.md: at most one open evaluation per round.
CREATE UNIQUE INDEX learning_evaluations_one_open ON learning_evaluations (round_id)
    WHERE status IN ('queued', 'running');
```

`attempt_id` makes `start` idempotent across runner restarts, and `created_at` orders the work feed. The README lists both columns. `UNIQUE NULLS NOT DISTINCT` needs PostgreSQL 15 or later. Every compose file pins `postgres:16-alpine` (`compose.yaml:4`).

### Lifecycle

- [loop.md](loop.md) creates rows: one `incumbent` evolve evaluation in `scoring_incumbent`, one `candidate` evolve evaluation per survivor in `evaluating` (one at a time), one `retained` held-out evaluation in `scoring_held_out`. Each new row gets `deadline_at = now() + ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS` (default 604,800, `apps/docs/content/docs/reference/configuration.mdx:70`).
- `start` sets `running`, `attempt_id`, `started_at` and `deadline_at = now() + ACCLIMATE_LEARNING_EVALUATION_SECONDS` (default 86,400, `configuration.mdx:71`). Both settings keep today's parsing (`src/connected_learning_worker.rs:1016`, `:1431`) and move to `src/learning/evaluations.rs`.
- `expire(tx)` (called by `sweep`) moves `queued` and `running` rows past `deadline_at` to `failed` with error "Evaluation queue deadline passed" or "Evaluation run deadline passed".
- `stop_round` moves `queued` and `running` rows to `cancelled`.
- `report` writes only the evaluation row. `advance_round` reads it and moves the round and candidate ([loop.md](loop.md)).

### Scores

- An evaluation's `score` is the equal-case mean: the mean over its cases of the mean of each case's 5 rollout scores. `incumbent_score`, `evolve_score` and `held_out_score` copy it.
- `case_passes(rollouts) -> bool` is `rollouts.iter().filter(|r| r.passed).count() >= CASE_PASS_ROLLOUTS`. [memory.md](memory.md) uses it for `fixed` and `missed`.
- Every rollout counts. There is no missing-trial imputation, retry accounting or paired statistic (D7). A rollout whose execution failed is reported as `score: 0, passed: false` with an `error` (evolve only).

## Evaluator work protocol

The app principal runs one loop: poll `GET /work`, `start` each item, run it, `report` it case by case. The SDK's `serveLearningLoop` does exactly this. Any language can do it from this section.

### `GET /work`

```json
{
  "bundleId": "6f1c…",
  "status": "running",
  "items": [
    {"evaluationId": "a1…", "roundId": "r1…", "roundNumber": 12, "role": "candidate", "sample": 3,
     "split": "evolve", "versionId": "v9…", "digest": "sha256:…", "evolveRevision": 9, "heldOut": null,
     "status": "queued", "deadlineAt": "2026-11-27T10:00:00Z"}
  ]
}
```

```sql
SELECT e.id, e.round_id, r.number, e.role, e.sample, e.split, e.version_id, e.digest,
       e.evolve_revision, CASE WHEN e.split = 'held_out' THEN r.held_out END AS held_out,
       e.status, e.deadline_at
FROM learning_evaluations e
JOIN learning_rounds r ON r.id = e.round_id
WHERE (r.project_id, r.bundle_id) = ($1, $2) AND e.status IN ('queued', 'running')
ORDER BY e.created_at, e.id
LIMIT 100
```

The feed lists `queued` and `running` items. `running` items are listed so a restarted runner can resume its own attempt. A held-out item carries the round's pinned `heldOut` (`learning_rounds.held_out`), and an evolve item has `heldOut: null`. A `paused` loop still lists the active round's work. A `stopped` loop lists nothing, and the runner keeps polling, because a `PUT` can restart it.

### `POST /evaluations/{evaluationId}/start`

Body `{"attemptId": "…"}` (1 to 128 bytes), with a required `Idempotency-Key`, through `crate::commands::begin_mutation` as the evaluation transitions do today (`src/evaluations.rs:484-490`).

| Current status | Same `attemptId` | Other `attemptId` |
| --- | --- | --- |
| `queued` | Becomes `running` | Becomes `running` |
| `running` | Returns the assignment again | `409 learning_conflict` |
| `scored` | Returns the assignment, so the runner sees it is done | `409` |
| `failed`, `cancelled` | `409` | `409` |

This mirrors today's attempt rule (`src/evaluations.rs:528-544`). The response, `LearningEvaluationAssignment`:

```json
{
  "evaluation": {"id": "a1…", "role": "candidate", "sample": 3, "split": "evolve", "status": "running", "…": "…"},
  "cases": [{"caseId": "refund-07", "input": {"ticket": "…"}, "expected": {"action": "refund"}}],
  "heldOut": null,
  "reportedCaseIds": ["refund-02"]
}
```

For an evolve evaluation, `cases` is `cases_at(evaluation.evolve_revision)` and `heldOut` is null. For a held-out evaluation, `cases` is null and `heldOut` is the round's pinned `{digest, cases}` (`learning_rounds.held_out`). `reportedCaseIds` lists cases already stored.

### `POST /evaluations/{evaluationId}/report`

Body: `{"attemptId": "…", "cases": [{"caseId": "…", "rollouts": [{"score": 1, "passed": true, "trace": "…", "error": null}, …]}]}` or `{"attemptId": "…", "error": "learning.held_out_mismatch"}`. A required `Idempotency-Key` (the SDK sends `<attemptId>:<first caseId>` or `<attemptId>:error`).

| Check | Result |
| --- | --- |
| Status is not `running`, or `attemptId` differs | `409 learning_conflict` |
| Evolve: a `caseId` not in `cases_at(evolve_revision)` | `400` |
| Held-out: the stored and new cases together exceed the round's `held_out.cases`, or a duplicate case ID in one body | `400` |
| Not exactly `ROLLOUTS_PER_CASE` rollouts | `400` |
| `score` not a finite number in [0, 1], or `passed` not a boolean | `400` |
| Evolve: `trace` or `error` neither a string nor null | `400`. There is no length check beyond the 2 MiB request limit (D5). |
| Held-out: any rollout key other than `score` and `passed` | `400` "Held-out reports carry only score and passed" |
| A case already stored with identical rollouts | No-op |
| A case already stored with different rollouts | `409` |
| `{attemptId, error}` | Status `failed`, `error` stored (at most 1 KiB). |

After storing, if every expected case is present (all of `cases_at(evolve_revision)`, or the round's `held_out.cases` held-out cases), the same transaction sets `status = 'scored'` and `score`. The cases append to `report.cases`, kept in `caseId` order. The response is the evaluation with `reportedCases` and `cases` counts.

Rust types in `src/learning/evaluations.rs` use `#[serde(deny_unknown_fields)]`: `EvolveRollout {score, passed, trace: Option<String>, error: Option<String>}` and `HeldOutRollout {score, passed}`, parsed by split. So the held-out refusal is the parser's, not a filter that a later change could skip.

### Ownership

`authorize_evaluation(tx, project, bundle, evaluation_id, principal) -> ApiResult<EvaluationRow>`:

```sql
SELECT e.*, l.app_principal, r.held_out
FROM learning_evaluations e
JOIN learning_rounds r ON r.id = e.round_id
JOIN learning_loops l ON (l.project_id, l.bundle_id) = (r.project_id, r.bundle_id)
WHERE e.id = $3 AND (r.project_id, r.bundle_id) = ($1, $2)
FOR UPDATE OF e
```

No row: `404 not_found`. `app_principal <> principal`: `403 denied`. A signed-in user is always `403`, because a console session is never a machine principal. `work`, `start` and `report` call `crate::auth::actor(…, "evaluate")` and `authorize_transaction` first, so a revoked machine token cannot finish a mutation (`src/auth.rs:437-455`).

## Routes

All under `/v1/workspaces/{workspaceId}/bundles/{bundleId}/learning`. `src/learning.rs` `routes()` registers them and `src/lib.rs` merges it in place of `connected_learning::routes()` and `connected_learning_worker::routes()` (`src/lib.rs:198-199`).

| Route | Handler | Caller | Success | Errors |
| --- | --- | --- | --- | --- |
| `PUT` | `learning::enroll` | Administrator | `200 LearningLoop` | `400`, `403`, `404` bundle, `409` |
| `GET` | `learning::inspect` | Reader | `200 LearningLoop` | `403`, `404` not enrolled |
| `POST /pause`, `/resume`, `/stop` | `learning::pause`, `resume`, `stop` | Administrator | `200 LearningLoop` | `403`, `404`, `409` |
| `GET /rounds?before=&limit=` | `learning::list_rounds` | Reader | `200 {items: LearningRoundSummary[], next}` | `400` cursor, `403`, `404` |
| `GET /rounds/{roundId}?evaluation=` | `learning::get_round` | Reader | `200 LearningRound` | `403`, `404` |
| `GET /memory?revision=` | `learning::memory` | Reader other than the app principal | `200 LearningMemory` ([memory.md](memory.md)) | `400` revision, `403`, `404` |
| `POST /evolve-cases` | `evolve::submit_cases` | App principal | `200 LearningEvolveCasesReceipt` | `400`, `403`, `404`, `409` |
| `POST /outcomes` | `evolve::submit_outcome` | App principal | `200 LearningOutcomeReceipt` | `400`, `403`, `404`, `409` |
| `GET /work` | `evaluations::work` | App principal | `200 LearningWork` | `403`, `404` |
| `POST /evaluations/{evaluationId}/start` | `evaluations::start` | App principal | `200 LearningEvaluationAssignment` | `400`, `403`, `404`, `409` |
| `POST /evaluations/{evaluationId}/report` | `evaluations::report` | App principal | `200 LearningEvaluation` | `400`, `403`, `404`, `409` |

- "Reader" is `crate::auth::read_transaction` (`src/auth.rs:501-510`). There is no reviewer gate: readers see rationale, changes, diagnoses and the selection reason. The rationale gate existed for human review, which is removed (D7).
- The app principal gets `403` on `GET /memory`. Memory is optimizer-only and never delivered to jobs (D6), and the app principal is the credential an app's jobs run beside. It can still read rounds.
- `GET /rounds` pages by round number, newest first, default 20 and at most 100, using `crate::pagination::page` (`src/pagination.rs:35`).
- `GET /rounds/{roundId}` returns each evolve evaluation's per-case summary (`caseId`, `passedRollouts`, `meanScore`). `?evaluation=<id>` adds that one evolve evaluation's full `report`, traces and errors included. A held-out evaluation ID there is `400`. Full reports are opt-in because one round can hold six evaluations with traces.
- The mutation routes join the audited route list in `crate::commands` so `mutation_audit` records them, as other workspace mutations are.

## Wire types

`LearningLoop`:

```json
{
  "workspaceId": "acme", "bundleId": "6f1c…",
  "status": "running", "pauseReason": null,
  "channel": "stable", "appPrincipalId": "machine:support-app",
  "setting": {"domain": "support", "benchmark": "support-tickets-v3", "policyModel": "gpt-6-luna"},
  "heldOut": {"digest": "sha256:9f2c…", "cases": 30},
  "evolveRevision": 9, "liveCases": 31, "memoryRevision": 4,
  "nextRound": 13, "failedRounds": 0, "enrolledBy": "user:…",
  "createdAt": "…", "updatedAt": "…",
  "activeRound": {"id": "…", "number": 12, "state": "evaluating", "…": "…"},
  "rounds": []
}
```

`rounds` holds the 10 most recent `LearningRoundSummary` entries.

`LearningRoundSummary`: `id`, `number`, `state`, `decision`, `reason`, `parentVersionId`, `adoptedSample`, `adoptedVersionId`, `incumbentScore`, `heldOutScore`, `heldOutError`, `createdAt`, `endedAt`.

`LearningRound` adds `channel`, `channelRevision` (decimal string), `evolveRevision`, `memoryRevision`, `memoryDigest`, `historyDigest`, `setting`, `heldOut` (the pinned `{digest, cases}`), `optimizerModel`, `selection` (README shape or null), `candidates` and `evaluations`.

`LearningCandidate`: `sample`, `status`, `dropReason`, `rationale`, `changes`, `diagnosis`, `scan`, `screen`, `versionId`, `evaluationId`, `evolveScore`. Shapes as in the README. `candidates` is `[]` until phase 4.

`LearningEvaluation`: `id`, `roundId`, `role`, `sample`, `split` (`evolve` or `heldOut`), `versionId`, `digest`, `evolveRevision`, `status`, `score`, `cases`, `reportedCases`, `createdAt`, `startedAt`, `deadlineAt`, `error`, and for an evolve evaluation `caseSummaries` and, when requested, `report`.

`LearningEvaluationReport`: `{cases: [{caseId, rollouts: [LearningRollout]}]}`. `LearningRollout`: `{score, passed, trace?, error?}`.

Wire values match the database values except `held_out`, which is `heldOut` (README). Rust serializes with `#[serde(rename_all = "camelCase")]` and an explicit `#[serde(rename = "heldOut")]` on the split enum variant.

## OpenAPI (`contracts/openapi.json`)

- Paths: the 11 rows of the route table, each with request and response schemas and the listed status codes. [removal.md](removal.md) deletes the connection learning paths (`contracts/openapi.json:14`, `:2702-2970`, `:3651-3742`) and the evaluation-request paths (`:1610-2092`, `:3743`). `/connection-observations` (`:2971-2990`) stays.
- Schemas: `LearningSetting`, `LearningHeldOut`, `LearningLoopRequest`, `LearningLoop`, `LearningRoundSummary`, `LearningRound`, `LearningCandidate`, `LearningDiagnosis`, `LearningSelection`, `LearningEvaluation`, `LearningRollout`, `LearningHeldOutRollout`, `LearningEvaluationReport`, `LearningEvaluationReportRequest`, `LearningEvaluationStart`, `LearningEvaluationAssignment`, `LearningEvolveCase`, `LearningEvolveCasesRequest`, `LearningEvolveCasesReceipt`, `LearningOutcomeRequest`, `LearningOutcomeReceipt`, `LearningWork`, `LearningWorkItem`, `LearningMemory`. Today's `LearningWork` (`contracts/openapi.json:6034`) and the other `Learning*` schemas are replaced.
- Every request schema is closed (`additionalProperties: false`). `LearningHeldOutRollout` is closed too, so the OpenAPI contract states the held-out refusal.
- All enums (`state`, `decision`, `reason`, `status`, `dropReason`, `role`, `split`) are closed and match the README tables.

## TypeScript SDK

### Types and client (`packages/sdk/src/types.ts`, `packages/sdk/src/client.ts`)

Replace the learning types (`types.ts:393-732`) with one interface per OpenAPI schema, same names and fields. Replace the connection learning methods (`client.ts:452-626`) with:

| Method | Route |
| --- | --- |
| `enrollLearningLoop(workspaceId, bundleId, body, key?)` | `PUT` |
| `getLearningLoop(workspaceId, bundleId)` | `GET` |
| `pauseLearningLoop`, `resumeLearningLoop`, `stopLearningLoop(workspaceId, bundleId, key?)` | `POST /pause`, `/resume`, `/stop` |
| `listLearningRounds(workspaceId, bundleId, {before?, limit?})` | `GET /rounds` |
| `getLearningRound(workspaceId, bundleId, roundId, {evaluation?})` | `GET /rounds/{roundId}` |
| `getLearningMemory(workspaceId, bundleId, {revision?})` | `GET /memory` |
| `addLearningEvolveCases(workspaceId, bundleId, body, key?)` | `POST /evolve-cases` |
| `reportLearningOutcome(workspaceId, bundleId, body, key = body.outcomeId)` | `POST /outcomes` |
| `getLearningWork(workspaceId, bundleId)` | `GET /work` |
| `startLearningEvaluation(workspaceId, bundleId, evaluationId, body, key = body.attemptId)` | `POST …/start` |
| `reportLearningEvaluation(workspaceId, bundleId, evaluationId, body, key)` | `POST …/report` |

`reportLearningOutcome` and `getLearningWork` keep their names with new signatures. The paths use a private `loopPath(workspaceId, bundleId)` in place of `learningPath` (`client.ts:452-454`).

### `@acclimate/sdk/learning`

`packages/sdk/src/learning/index.ts` exports `serveLearningLoop`, `createLearningOutcomeReporter`, `addEvolveCases`, `heldOutDigest` and the `LearningLoopApp` and `LearningLoopOptions` types. `connected.ts`, `connected-replay.ts` and `connected-fixtures.ts` are deleted ([removal.md](removal.md)). New files: `packages/sdk/src/learning/loop.ts` (runner), `packages/sdk/src/learning/outcomes.ts` (reporter and `addEvolveCases`), `packages/sdk/src/learning/held-out.ts` (`heldOutDigest`).

The app module the runner loads:

```ts
import type { LearningLoopApp } from '@acclimate/sdk/learning';

export default {
  execution: 'live',                       // or 'model-free'
  async execute({ version, caseId, rollout, input, signal, instructions, instructionFiles, skillFiles, memoryFiles }) {
    const run = await runAgent(version, input, signal);
    return { output: run.answer, trace: run.transcript };   // trace is optional
  },
  async grade({ output, expected, caseId, rollout, signal }) {
    const score = compare(output, expected);
    return { score, passed: score === 1 };
  },
  heldOut: loadPrivateHeldOutCases(),      // [{ caseId, input, expected }]
} satisfies LearningLoopApp<Input, Expected, Output>;
```

`execute` receives the same version helpers as today's `ExecuteInput` (`packages/sdk/src/evaluation/types.ts:95-112`), with `rollout` (0 to 4) in place of `repetition` and no `context`. `grade` returns `passed` itself: the app decides what success means, and `CASE_PASS_ROLLOUTS` turns rollouts into a case result.

`serveLearningLoop(options: LearningLoopOptions): Promise<void>`:

| Option | Meaning |
| --- | --- |
| `configPath` | The existing evaluator config (`serviceUrl`, `workspaceId`, `evaluatorPrincipalId`, `evaluatorToken`, `journalRoot`), read with `readEvaluatorConfig` (`packages/sdk/src/evaluation/config.ts:163`). `evaluatorPrincipalId` must be the loop's app principal. |
| `bundleId` | The enrolled bundle |
| `app` | A `LearningLoopApp`, validated on load (`learning.apps_invalid_export` on failure, reusing `packages/sdk/src/evaluation/errors.ts:38`) |
| `allowLive` | Required to run an app whose `execution` is `live`, as today |
| `caseConcurrency` | Cases of one evaluation run at once. Default 1. It changes wall clock only: items are still served one at a time, each case still runs all 5 rollouts, and every report is a whole case. |
| `pollIntervalMs`, `signal`, `onDiagnostic` | As `serveConnectedLearning` (`packages/sdk/src/learning/connected.ts:278-314`) |

Behaviour:

1. Compute `heldOutDigest(app.heldOut)` once.
2. Poll `getLearningWork`. Serve items in order, one at a time, as today's loop does (`connected.ts:698-707`).
3. For each item, load or create its `attemptId` in `journalRoot/learning/<bundleId>/<evaluationId>.json`, then `start`. A restart reuses the saved attempt.
4. Resolve and verify the version with `resolveAndCache` (`packages/sdk/src/cache.ts:121`). A version or digest mismatch reports `evidence.identity_mismatch` and serves nothing.
5. Held-out: if the local digest or case count differs from the work item's `heldOut` (the round's pinned commitment), report `{attemptId, error: "learning.held_out_mismatch"}` and stop serving that item.
6. For each case not in `reportedCaseIds`, run 5 rollouts, with up to `caseConcurrency` cases in flight. A rollout whose `execute` throws `InfrastructureError` (`packages/sdk/src/compare.ts:43-49`) is retried once. A rollout that still fails, or whose `grade` throws, becomes `{score: 0, passed: false, trace: null, error: <safe diagnostic code and message, redacted with redactDiagnosticText>}` (`packages/sdk/src/evaluation/runner.ts:52`). Held-out rollouts keep only `score` and `passed`.
7. By default the runner captures at most 16 KiB of trace, cutting a longer one to its first and last 8,000 bytes around the marker `\n[… N bytes omitted …]\n`, and at most 4 KiB of error text. This is the SDK runner's capture default, an evaluator choice, not a service limit. The service stores and forwards what it receives, bounded only by the 2 MiB request limit (open question 1).
8. Send one `report` per case, in completion order. Keep a monitor like `whileAssigned` (`connected.ts:413-450`): when the item leaves the work feed (cancelled, expired or stopped), abort the in-flight callbacks and stop.
9. Keep polling while the loop is `stopped`. Return only when `signal` aborts.

`createLearningOutcomeReporter({client, workspaceId, bundleId})` returns `(version: VerifiedVersion, {outcomeId, input, expected}) => Promise<LearningOutcomeReceipt>`. It takes `versionId` and `digest` from the verified version, checks that `outcomeId` is a UUID and that `version.version.bundleId` is `bundleId`, and calls `reportLearningOutcome`. It no longer needs a connection-resolved version (`connected.ts:50-62`), and the lesson and feedback summaries (`:89-140`) go.

`addEvolveCases(client, {workspaceId, bundleId}, {cases, retire}, key?)` checks the documented limits locally, then calls `addLearningEvolveCases`.

### `acclimate-learning` bin (`packages/sdk/src/learning/serve-cli.ts`)

```
acclimate-learning --config /private/evaluator.json --bundle UUID --app ./learning-app.mjs [--live]
acclimate-learning held-out --app ./learning-app.mjs
```

The first form runs `serveLearningLoop`. The second prints `{"digest": "sha256:…", "cases": 30}` for `PUT heldOut` and contacts no service. `--connection` and `--installation` go (`serve-cli.ts:10-11`, `:43-61`), and `--apps` becomes `--app`. The startup hints (`:12-19`) say "Default-export { execute, grade, heldOut }". The bin entry stays at `packages/sdk/package.json:72`, and the `./learning` export at `:62`.

New diagnostic code: `learning.held_out_mismatch` in `EVALUATION_ERROR_CODES` (`packages/sdk/src/evaluation/errors.ts:36-41`, `:168-173`), with the message "The installed held-out cases do not match the loop's held-out commitment." Regenerate the error-code page with `npx tsx scripts/error-codes.ts --write`. The recheck, field replay and incident replay callback codes are removed with their callbacks.

## Python SDK

- `python/acclimate/types.py`: replace the learning TypedDicts (`:536-787`) with one TypedDict per OpenAPI schema, same names and keys, and update `__all__` (`:811`). `NamespaceTest` (`python/tests/test_client_parity.py:240-255`) checks the list.
- `python/acclimate/client.py`: replace `_learning` and the connection methods (`:535-640`) with `enroll_learning_loop`, `get_learning_loop`, `pause_learning_loop`, `resume_learning_loop`, `stop_learning_loop`, `list_learning_rounds`, `get_learning_round`, `get_learning_memory`, `add_learning_evolve_cases`, `report_learning_outcome`, `get_learning_work`, `start_learning_evaluation` and `report_learning_evaluation`. Keys match the TypeScript defaults.
- `held_out_digest(cases)` in a new `python/acclimate/learning.py`, so a Python evaluator can enroll. It must produce the TypeScript digest for the shared fixture.
- No Python runner in the MVP. A Python app can serve the protocol with the client methods. `serve_learning_loop` is deferred.

## Native plugins and delivery

Unchanged. The Claude, Codex, Cursor and Pi plugins fetch, verify and prepare a resolved version and contain no learning code. A job uses the loop's version the usual way:

- Resolve the loop's `channel` (`GET …/channels/{channel}`, `src/channels.rs:24-56`) with any read credential, or
- Use a connection whose channel is the loop's channel. Today a connected-learning enrollment silently redirects a connection's reads to its private `learn-<id>` channel (`src/integrations.rs:367`). [removal.md](removal.md) removes that redirect, so a connection always resolves its own channel.

An adopt is a `promotions` row with reviewer `service:learning-loop` on that channel ([loop.md](loop.md)). Jobs pick it up at their next resolution, with the usual ETag and cache rules. Delivery receipts keep working and are not read by the loop.

The channel release route (`src/channels.rs:179-213`) stays as the delivery primitive (D8 default). A manual release on the learning channel becomes the next round's parent, and an adopt that finds the channel moved records `kept` / `channel-moved` (open question 3).

## Console

New bundle tab **Learning** at `/w/{workspaceId}/bundles/{bundleId}/learning`, bundle-scoped like today's Changes tab, which [removal.md](removal.md) removes in phase 1.

| File | Change |
| --- | --- |
| `apps/console/src/navigation.ts` | `BundleView` gains `'learning'` (`:4`). `bundleHref` builds `${base}/learning` (`:29-36`). `parseConsoleLocation` accepts `parts[4] === 'learning'` (`:50-51`). `bundleViewLabels` gains `learning: 'Learning'` (`:99-103`). |
| `apps/console/src/routes/w.$.tsx` | Render `<BundleLearning>` for the view (`:270-278`) and add its description to the view descriptions (`:254`). |
| `apps/console/src/server/learning-loop.ts` | Server functions `readLearningLoop`, `runLearningLoop` (`enroll`, `pause`, `resume`, `stop`), `readLearningRound` and `readLearningMemory`, following `integration-actions.ts:37-62`: `createServerFn`, `private, no-store`, and `consoleClient` (`apps/console/src/server/console-client.ts:5-16`). Enrollment validates the body with the same limits as the service and sends a fresh `Idempotency-Key`. |
| `apps/console/src/components/bundle-learning.tsx` | The page below |
| `apps/console/src/components/workspace-connections.tsx` | The connection detail drops `ConnectionLearning` (`:21`, `:173`, `:1138`, deleted by [removal.md](removal.md)). When the connection's channel is a loop's channel, show one line, "Receives versions adopted by the learning loop", linking to the Learning tab. |

The page, top to bottom:

1. **Status.** Loop status and pause reason, channel, app principal, setting, held-out case count, evolve revision and live case count, memory revision, failed rounds. Administrators get Pause, Resume and Stop buttons, and Stop asks for confirmation. A bundle with no loop shows the enrollment form to administrators: channel (a select of channels with a release), app principal (a select of active machine tokens holding `evaluate`, plus a text field), domain, benchmark, policy model, held-out digest and case count, with the `acclimate-learning held-out` command beside the held-out fields.
2. **Active round.** The six active states as an ordered list, with the current one marked in text, and that state's work: which evaluation is queued or running, and its `reportedCases` of `cases`.
3. **Curves.** Incumbent evolve score and held-out score per completed round, as an inline SVG line chart with a data table under it, so screen readers get the numbers. Each point is that round's value. There is no running maximum.
4. **Rounds.** A table: number, state, decision, reason, incumbent evolve score, adopted sample and version, held-out score or error, ended at. Paged with `before`.
5. **Round detail** (phase 4). One row per sample: status or drop reason, diagnosis (problem ID or "new: <root cause>", predicted case IDs), scan findings, screen verdict and reason, evolve score. Then the selection decision and reason, and a link to the adopted version's diff on the Releases tab. Evaluations list per-case passes, and a case's traces open on demand through `?evaluation=`.
6. **Memory** (phase 4). Problems with their attempts at the current revision, with a revision selector. Read-only.

There is no review, approve, rollout or rollback control. Review the hook dependency warnings in every touched file (AGENTS.md).

## `contracts/learning.md` rewrite outline

Replace the whole file (today 141 lines of connected learning). New sections:

1. **The learning loop.** One loop per workspace and bundle. Rounds run back to back while `running`. Each round scores the incumbent on the evolve split, generates five candidates, scans and screens them, scores the survivors, and adopts one or keeps. An adopt is a release on the learning channel. The retained version is scored on the held-out split for monitoring only. No statistical gate, audit, review or field check applies.
2. **Routes and authority.** The route table above, with the administrator, reader and app principal rules.
3. **Enrollment.** The `PUT` body, its checks, the mid-round `409` and the loop status table.
4. **The evolve split.** Cases, IDs, immutability, revisions, limits, `POST /evolve-cases`, and outcomes as `outcome:<outcomeId>` cases.
5. **The held-out split.** The evaluator's own store, `heldOut.digest` and its construction, scores only, never in optimizer input, never gating.
6. **Evaluator protocol.** Work, start, report, `ROLLOUTS_PER_CASE`, `CASE_PASS_ROLLOUTS`, the equal-case mean, per-case reports, the held-out refusal, deadlines and their settings, cancellation, and attempt reuse.
7. **Rounds.** The state table, decisions and reasons from the README.
8. **What the optimizer sees.** The whole bundle, evolve feedback with traces and errors, the full run history, the full improvement memory. Never held-out data. Inputs, expected answers and traces leave the service for the optimizer endpoint. Untrusted-data fencing applies. The scanner is a secrets and PII check, not an injection defence.
9. **Improvement memory.** `GET /memory`. Optimizer-only, never delivered to jobs, not readable by the app principal.
10. **Delivery.** Jobs resolve the learning channel. A manual release on it becomes the next parent and can make an adopt record `channel-moved`.
11. **Retries and errors.** Which routes take an `Idempotency-Key`, the outcome receipt, and the error codes.

Also change `contracts/README.md:9` to "The learning loop's routes, splits and evaluator protocol."

## Other docs

| File | Change |
| --- | --- |
| `docs/evaluator-operations.md` | Replace "Serve connected learning" (`:93`) and its subsections through "Replay the incident that prompted a change" (`:245`) with "Serve the learning loop": the app module, `acclimate-learning held-out`, enrollment, running the bin, restarts and the journal, serial serving, deadlines, and the trace capture limit. |
| `apps/docs/content/docs/guides/learning-loop.mdx` | New guide replacing `guides/connected-learning.mdx`: enroll, add setup cases, report outcomes, run the evaluator, watch the curves, pause and stop. |
| `apps/docs/content/docs/reference/http-api.mdx`, `typescript-sdk.mdx`, `python-sdk.mdx` | The loop routes, types and methods |
| `apps/docs/content/docs/reference/configuration.mdx` | Keep the two evaluation deadline rows (`:70-71`). The removed rows are [removal.md](removal.md)'s, and the model rows [optimizer.md](optimizer.md)'s. |

`contracts/learning.md` and `apps/docs/**` are outside the `docs/site` export. Edits to `docs/evaluator-operations.md` need `python3 scripts/build_docs.py` in the same commit.

## Files by phase

| Phase | Files |
| --- | --- |
| 3 | `migrations/0019_learning_loop.sql` (both tables here), `src/learning.rs`, `src/learning/evaluations.rs`, `src/learning/evolve.rs`, `src/lib.rs`, `src/commands.rs` (scope parameter, audited routes), `contracts/openapi.json`, `contracts/learning.md`, `contracts/README.md`, `packages/sdk/src/types.ts`, `client.ts`, `learning/index.ts`, `learning/loop.ts`, `learning/outcomes.ts`, `learning/held-out.ts`, `learning/serve-cli.ts`, `evaluation/errors.ts`, `python/acclimate/types.py`, `client.py`, `learning.py`, the console files above without round detail and memory, the docs above |
| 4 | `GET /memory`, `LearningCandidate` rows in `GET /rounds/{roundId}`, the console round detail and memory sections, `LearningMemory` in OpenAPI and both SDKs |

## Tests

Rust, new `tests/learning_loop.rs` (database tests like `tests/http_contract.rs`):

- Enrollment: an admin enrolls; an editor gets `403`; the app principal enrolling itself gets `403`; an app principal without `evaluate` gets `400`; a machine-token app principal is accepted and a revoked one refused; a channel with no release gets `400`; `permittedPaths` or `automaticRollout` in the body gets `400`; `PUT` on a stopped loop runs it; changing `channel`, `appPrincipalId` or `heldOut` during an active round gets `409`; changing `setting` during a round succeeds and the round keeps its pinned `setting`; an identical `PUT` changes nothing.
- Status: every row of the pause, resume and stop table, including `409` from `stopped`, and stop cancelling queued and running evaluations.
- Evolve split: one revision per changing request; identical re-add is a no-op; changed content, re-adding a retired ID and adding an `outcome:` ID are refused; `cases_at` rebuilds past revisions after retirements; the size limits; a reader or other machine gets `403`.
- Outcomes: creates `outcome:<id>` under a new revision; the same body replays the same response; a different body gets `409`; a wrong digest or another bundle's version gets `400`; a missing `expected` gets `400`; old fields (`lesson`, `feedback`, `status`) get `400`.
- Ownership: an unknown evaluation ID, and another bundle's evaluation ID, get `404` on start and report; another machine principal and a console user get `403`.
- Start and report: same-attempt start is idempotent; another attempt gets `409`; a report with 4 rollouts, a score of 1.5, a case outside the pinned revision, or a numeric `trace` gets `400`; a 100 KiB trace is accepted and stored as sent; a held-out rollout with `trace`, with `error`, or with an extra key gets `400`; too many held-out cases gets `400`; an identical re-report is a no-op and a different one `409`; the last case sets `scored` with the equal-case mean; `{attemptId, error}` sets `failed`; a report after stop gets `409`; both deadlines move rows to `failed`; a restarted attempt gets `reportedCaseIds`.
- Held-out isolation: no route returns a held-out case ID or per-case held-out result; `?evaluation=` with a held-out ID gets `400`; with [optimizer.md](optimizer.md), a sentinel held-out score and case ID never appear in any recorded optimizer input.
- Memory route: the app principal gets `403` although it holds `read`; a reader gets the document.
- Pins: a held-out item in `GET /work` and its `start` carry the round's `heldOut`, and `LearningRound` returns `channel` and `heldOut`.
- Route registry: every loop route is in OpenAPI and no `/connections/{connectionId}/learning` route answers (pattern of `tests/http_contract.rs:673`). `tests/production_schema.rs` lists both tables.

TypeScript, `packages/sdk/tests/learning/`:

- `loop.test.ts` against a fake service: items served one at a time in order; one report per case with 5 rollouts; `caseConcurrency: 4` runs four cases at once and still reports whole cases; traces captured and long traces cut with the marker by default; an `InfrastructureError` retried once; a grade failure becomes a failed rollout with a redacted error; a held-out report has no `trace` or `error` key; a held-out digest mismatch reports `learning.held_out_mismatch`; a cancelled item aborts its callbacks; a restart reuses the journaled attempt and skips reported cases; a `live` app without `allowLive` is refused.
- `outcomes.test.ts`: the reporter sends version, digest, input and expected; it refuses a non-UUID outcome ID and a version of another bundle; `addEvolveCases` enforces the limits.
- `held-out.test.ts`: `heldOutDigest` is independent of case order and matches the shared fixture `contracts/fixtures/learning-held-out-v1.json`.
- `serve-cli.test.ts`: usage, the `held-out` subcommand output, and the startup hints.
- `npm run pack:verify` (`scripts/packaging/verify.mjs`) and `scripts/sdk-boundaries.test.ts` for the changed `./learning` export.

Python, `python/tests/test_client_parity.py`:

- Rewrite the learning route test (`:128-192`) for the 13 new methods, paths and keys, and delete the review cases (`:169`, `:187-192`).
- Extend the OpenAPI parity test (`:263-273`) to `LearningLoopRequest`, `LearningLoop`, `LearningEvaluationReport`, `LearningWork` and `LearningOutcomeRequest`.
- `held_out_digest` matches `contracts/fixtures/learning-held-out-v1.json`.

Console, `apps/console/tests/`:

- `bundle-learning.test.ts`: renders each round state, a kept and an adopted round, a failed held-out evaluation, and a curve whose values go down (no running maximum); Pause, Resume and Stop appear only for administrators; no review or rollout control renders; the enrollment form refuses empty and oversized fields.
- `navigation.test.ts`: `/w/acme/bundles/b/learning` parses and round-trips through `bundleHref`.

Behaviour, new `features/learning_loop.feature` with `features/steps/learning_loop.py`, using a fake optimizer model: enroll, add setup cases, run `acclimate-learning` with a model-free app, see a round adopt and the connection resolve the new version; report an outcome and see `outcome:<id>` in the next round's evolve evaluation but not in the active one; stop mid-evaluation and see the runner abort.

## Open questions

Owned here. The README lists them as questions 4, 10 and 2.

1. **Trace privacy and size.** Evolve inputs, expected answers, traces and errors are stored in the service and sent to the optimizer endpoint. The scanner checks proposer output only. The service has no trace or error cap beyond the 2 MiB request limit (D5). The SDK runner captures 16 KiB of trace and 4 KiB of error by default and redacts the evaluator token. Should the service redact or scan traces too, should the runner's capture be configurable, and how long should reports be kept? Even 30 cases with full traces is about 2.4 MB of feedback per round, so the context limit may bind before any retention rule does.
2. **Evolve split growth.** Every outcome with an expected result adds a case, and every case runs 5 times in up to six evolve evaluations per round. Should near-duplicate outcomes merge, should old outcome cases retire automatically, or should the split have a live-case limit? Today nothing limits it, and a growing split grows round time and optimizer input.
3. **The channel pointer primitive.** The release route stays, so an operator can point the learning channel at an earlier version. Should the loop refuse manual releases on its channel, record them in run history, or treat them as today's design does (the next parent, and `channel-moved` for an adopt in flight)?
4. **App principal namespace.** Machine-token principals have the `machine:` prefix (`migrations/0015_evaluator_machine_tokens.sql:22`), but static grant principals may not contain `:` (`src/auth.rs:28-30`), and today's tests and acceptance fixtures use static evaluator principals. This design accepts both, so `learning_loops.app_principal` has no prefix check. Should static grants be refused, which would let the column check `LIKE 'machine:%'`?
