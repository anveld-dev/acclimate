# Learning loop

This file specifies the learning loop's scheduler: the round, loop and candidate state machines, the step-by-step run of one round, adopt as release, held-out monitoring, pause and stop, crash recovery, concurrency, the `learning_loops` and `learning_rounds` tables, and the tests. The names, the round state table and the status values are in the [README](README.md#names). This file uses them as written.

| Topic | Owner |
| --- | --- |
| Proposer, screen and select prompts and outputs, the one `learning_candidates` definition, `learning_optimizer_calls`, the call task `run_call`, the scanner, rendering and digests | [optimizer.md](optimizer.md) |
| `write_back`, `render_memory`, the memory tables and `GET /memory` | [memory.md](memory.md) |
| `learning_evolve_cases`, `learning_evaluations`, `evaluations::expire`, the work feed, reports, every route and wire type | [evaluator-and-contracts.md](evaluator-and-contracts.md) |
| What is deleted, and in which phase | [removal.md](removal.md) |

## Decisions

| # | Decision |
| --- | --- |
| W1 | One loop per workspace + bundle, keyed by `learning_loops (project_id, bundle_id)`. Its row is the **bundle row lock**. Every change to a loop's status, its active round, its evolve revision or its memory happens in a transaction that holds this row `FOR UPDATE`. |
| W2 | At most one active round per loop, enforced by a partial unique index. When the loop is `running` and no round is active, the next `tick` starts the next round. No trigger, admission or allowance exists (D3, D7). |
| W3 | **Serial inside a round.** A round has at most one non-terminal optimizer call and at most one non-terminal evaluation at any time. The 5 propose calls run one after another, and the survivors are evaluated one after another (D3). Loops run in parallel with each other. |
| W4 | **Model calls run outside every lock.** A call task claims its row, calls the model with no transaction open, then commits its result to its own row under a claim guard. Only `advance_round` turns call results and evaluation results into candidate and round state, under the bundle row lock. |
| W5 | **Durable selection.** The `select` call's output is committed before the adopt transaction runs. A crash between the two replays the stored output, so a retry never chooses again. |
| W6 | **Adopt is release.** One transaction under the bundle row lock writes `selection`, moves the learning channel to the adopted version with a `promotions` row whose reviewer is `service:learning-loop`, calls `memory::write_back`, and queues the held-out evaluation. Nothing sits between the selector and the release (D3). |
| W7 | **Held-out monitoring never gates.** Every round that reaches a decision queues one `retained` held-out evaluation of the learning channel head. Its score is stored on the round and shown to readers, never to the optimizer, and it never changes the decision or the channel. |
| W8 | **No auto-revert and no statistical check** of any kind (D3, D7). A failing round counts toward `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` and can pause the loop. It never reverts the channel. |
| W9 | The round pins what it reads: the parent version, the learning channel and its revision, the evolve revision, the memory revision, the setting, the held-out commitment and the optimizer model. A `setting` change through `PUT` is accepted at any time and applies from the next round. A change to `channel`, `appPrincipalId` or `heldOut` while a round is active is refused with `409 learning_conflict` ([evaluator-and-contracts.md](evaluator-and-contracts.md)). The round still pins `channel` and `held_out`, because `adopt`, `keep`, the held-out evaluation and memory provenance read the round's values, not the loop's. |

## Today's code this replaces

The new worker replaces connected learning's scheduler. [removal.md](removal.md) deletes the old code. This table records what each piece did, so the new code keeps what still applies.

| Today | Where | Paper-first |
| --- | --- | --- |
| Worker task: scans enrollments every 500 ms, ticks each one, keeps an in-memory `retry_after` back-off (2 s, 10 s) | `src/connected_learning_worker.rs:2068-2139`, scan query `src/connected_learning/worker_enrollments.sql:1-71` | `learning_worker` and `tick`. The 500 ms poll and the in-memory back-off stay. |
| Per-connection tick under the enrollment lock (`Connection::lock`), with a nested savepoint per round step | `src/connected_learning_worker.rs:1889-2027`, lock `:1893-1903` | `advance_round` under the `learning_loops` row lock. One step per transaction. |
| Round admission from queued corrections | `admit`, `src/connected_learning_worker.rs:296` | `start_round`. No corrections, allowance or calibration. |
| State dispatch and authority checks | `advance`, `src/connected_learning_worker.rs:1644-1660` | `advance_round` dispatch by `learning_rounds.state` |
| Close: fails the round's one proposal, interrupts its three requests, resets the chain, requeues corrections | `close`, `src/connected_learning_worker.rs:1354-1428` | `stop_round` and `fail_round`, which cancel every child of the round. No chain, no requeue. |
| Round failure window: back-off `30·2^n` s and close once the first error is older than `ACCLIMATE_LEARNING_FAILURE_WINDOW_SECONDS` | `src/connected_learning_worker.rs:1948-1968` | Removed. A tick error is retried with the in-memory back-off. Round failures are explicit reasons counted in `failed_rounds`. |
| Evaluation deadlines before and after start | `src/connected_learning_worker.rs:1009-1031`, `deadline_seconds` `:1430-1441` | `learning_evaluations.deadline_at`, enforced by `evaluations::expire` in `sweep`. Same settings and defaults. |
| One-permit proposal worker and its claim | `src/improvement.rs:430-476`, semaphore `:510-516`, claim `:531` | One task per optimizer call, at most one per round by construction (W3) |
| Result commit guarded by `status='running' AND attempts=$n` | `src/improvement.rs:735-766` | The same guard on `learning_optimizer_calls` |
| Requeue of every `running` proposal, at start-up and at the top of each worker loop | `src/main.rs:175-179`, `src/improvement.rs:435-437` | `sweep`: requeues `running` calls that no live task holds |
| Learning release with ancestry evidence, advisory lock, then the channel row | `promote_in_tx`, `src/channels.rs:220-394`; lock `:236-240`; `FOR UPDATE` `:242`; revision check `:251-257`; writes `:358-360` | `adopt` calls `promote_in_tx` after its own revision check, once [removal.md](removal.md) has removed the comparison and policy branches |
| Fixed 60 s model client timeout | `src/lib.rs:317-320` | `ACCLIMATE_MODEL_TIMEOUT_SECONDS`, default 600 ([optimizer.md](optimizer.md)) |
| Round table and states | `migrations/0001_init.sql:553`, states `migrations/0006_development_incumbent.sql:3` | `learning_rounds` and the README states |
| One service process owns the queues | `QUEUE_LOCK`, `src/main.rs:9`, `:150-161` | Kept. The loop relies on it: one worker process, so in-memory bookkeeping of live call tasks is authoritative. |

## Tables

### `learning_loops` (migration `0019_learning_loop.sql`)

```sql
CREATE TABLE learning_loops (
    project_id      text NOT NULL,
    bundle_id       uuid NOT NULL,
    status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','paused','stopped')),
    channel         text NOT NULL,                 -- the learning channel
    app_principal   text NOT NULL,                 -- a machine-token principal (machine:…) or a static grant principal
    setting         jsonb NOT NULL CHECK (jsonb_typeof(setting) = 'object'),   -- {domain, benchmark, policyModel}
    held_out        jsonb NOT NULL CHECK (jsonb_typeof(held_out) = 'object'),  -- {digest, cases}
    evolve_revision bigint  NOT NULL DEFAULT 0 CHECK (evolve_revision >= 0),
    memory_revision bigint  NOT NULL DEFAULT 0 CHECK (memory_revision >= 0),
    next_round      integer NOT NULL DEFAULT 1 CHECK (next_round >= 1),
    failed_rounds   integer NOT NULL DEFAULT 0 CHECK (failed_rounds >= 0),
    pause_reason    text CHECK (pause_reason IN ('operator','failed-rounds','optimizer-context-too-large')),
    enrolled_by     text NOT NULL,                 -- user:… who last enrolled; record only
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, bundle_id),
    FOREIGN KEY (project_id, bundle_id) REFERENCES bundles (project_id, id),
    FOREIGN KEY (project_id, bundle_id, channel) REFERENCES channels (project_id, bundle_id, name),
    CHECK ((status = 'paused') = (pause_reason IS NOT NULL))
);
```

`bundles` has `UNIQUE (project_id, id)` (`migrations/0001_init.sql:94`), and `channels` is keyed `(project_id, bundle_id, name)` (`:158-166`). The channel foreign key means a loop can only be enrolled on a channel that already has a head. That head is H0. The validation of `app_principal`, `setting` and `held_out` is in the `PUT` handler ([evaluator-and-contracts.md](evaluator-and-contracts.md)). `app_principal` has no prefix check: machine-token principals start with `machine:`, and static grant principals cannot contain `:` (`src/auth.rs:28-30`), and both may hold `evaluate`.

### `learning_rounds` (migration `0019_learning_loop.sql`)

```sql
CREATE TABLE learning_rounds (
    id                 uuid PRIMARY KEY,
    project_id         text NOT NULL,
    bundle_id          uuid NOT NULL,
    number             integer NOT NULL CHECK (number >= 1),
    state              text NOT NULL CHECK (state IN
                         ('scoring_incumbent','proposing','screening','evaluating','selecting',
                          'scoring_held_out','completed','failed','stopped')),
    decision           text CHECK (decision IN ('adopted','kept')),
    reason             text,
    parent_version_id  uuid NOT NULL,
    channel            text NOT NULL,     -- the learning channel, pinned at start_round
    channel_revision   bigint NOT NULL,
    evolve_revision    bigint NOT NULL,
    memory_revision    bigint NOT NULL,
    memory_digest      text,              -- set on entering proposing
    history_digest     text,              -- set on entering proposing
    setting            jsonb NOT NULL,
    held_out           jsonb NOT NULL,    -- the held-out commitment {digest, cases}, pinned at start_round
    optimizer_model    text,              -- ACCLIMATE_MODEL at start_round, NULL when none is configured
    adopted_sample     smallint CHECK (adopted_sample BETWEEN 1 AND 5),
    adopted_version_id uuid,
    selection          jsonb,             -- {decision, sample, versionId, digest, reason, model, inputDigest}
    incumbent_score    double precision,
    held_out_score     double precision,
    held_out_error     text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    ended_at           timestamptz,
    UNIQUE (project_id, bundle_id, number),
    UNIQUE (project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id) REFERENCES learning_loops (project_id, bundle_id),
    FOREIGN KEY (project_id, bundle_id, parent_version_id) REFERENCES versions (project_id, bundle_id, id),
    FOREIGN KEY (project_id, bundle_id, adopted_version_id) REFERENCES versions (project_id, bundle_id, id),
    CHECK ((state IN ('completed','failed','stopped')) = (ended_at IS NOT NULL)),
    CHECK (CASE
        WHEN state IN ('scoring_incumbent','proposing','screening','evaluating','selecting')
            THEN decision IS NULL AND reason IS NULL
        WHEN state IN ('scoring_held_out','completed') THEN decision IS NOT NULL
        WHEN state = 'failed' THEN decision IS NULL AND reason IN
            ('incumbent-evaluation-failed','optimizer-unavailable','optimizer-context-too-large','selector-unavailable')
        WHEN state = 'stopped' THEN decision IS NOT NULL OR reason = 'stopped'
    END),
    CHECK (decision IS DISTINCT FROM 'kept' OR reason IN
        ('selector-kept','no-candidates','no-survivors','no-evaluated-candidates','channel-moved')),
    CHECK (decision IS DISTINCT FROM 'adopted' OR (reason IS NULL AND selection IS NOT NULL)),
    CHECK ((decision IS NOT DISTINCT FROM 'adopted') = (adopted_sample IS NOT NULL)),
    CHECK ((adopted_sample IS NULL) = (adopted_version_id IS NULL)),
    CHECK (reason NOT IN ('selector-kept','channel-moved') OR selection IS NOT NULL),
    CHECK (state NOT IN ('proposing','screening','evaluating','selecting','scoring_held_out','completed')
           OR incumbent_score IS NOT NULL),
    CHECK (state <> 'completed' OR held_out_score IS NOT NULL OR held_out_error IS NOT NULL),
    CHECK (held_out_score IS NULL OR held_out_error IS NULL)
);

CREATE UNIQUE INDEX learning_rounds_one_active ON learning_rounds (project_id, bundle_id)
    WHERE state IN ('scoring_incumbent','proposing','screening','evaluating','selecting','scoring_held_out');
```

The `incumbent_score` check fails a round that reaches `proposing` without a scored incumbent. A round that failed in `scoring_incumbent` has none, and the check allows that.

**A stopped round can hold a decision.** A stop during `scoring_held_out` comes after the adopt or keep has committed, and an adopted version is already on the channel and in memory. The round keeps its `decision`, `reason`, `adopted_sample`, `adopted_version_id` and `selection`, and becomes `stopped` with no held-out score. Only a round stopped before its decision gets `reason = 'stopped'`.

Migration `0021_optimizer_effort.sql` adds `learning_rounds.optimizer_reasoning_effort`, a nullable text column that pins `ACCLIMATE_MODEL_REASONING_EFFORT` at round start. It also indexes evolve case IDs in paging order.

### Migration `0020_learning_optimizer.sql`: the parts this file owns

[optimizer.md](optimizer.md) holds the one `CREATE TABLE learning_candidates`. This file owns the candidate status machine, and the checks that enforce it are in that definition:

- `dropped` exactly when `drop_reason` is set.
- Every status other than `generating` and `dropped` has `rationale`, `changes`, `diagnosis` and `scan`, so predictions are on disk before any screen or evaluation exists.
- `screened_out` requires a `skip` verdict.
- `evaluating`, `evaluated` and `evaluation_failed` require an `evaluate` verdict, a `version_id` and an `evaluation_id`.
- `evaluated` exactly when `evolve_score` is set.

After the candidate table, `0020` adds:

```sql
ALTER TABLE learning_rounds
    ADD FOREIGN KEY (id, adopted_sample) REFERENCES learning_candidates (round_id, sample);
```

W3 is also enforced by two partial unique indexes, each defined in its owner's migration SQL: `learning_evaluations_one_open ON learning_evaluations (round_id) WHERE status IN ('queued','running')` in `0019` ([evaluator-and-contracts.md](evaluator-and-contracts.md)), and `learning_optimizer_calls_one_open ON learning_optimizer_calls (round_id) WHERE status IN ('queued','running')` in `0020` ([optimizer.md](optimizer.md)).

### Where round and candidate state lives

| Fact | Column |
| --- | --- |
| Which round is active | `learning_rounds.state` in an active state. At most one per loop (`learning_rounds_one_active`). |
| What the round started from | `parent_version_id`, `channel`, `channel_revision`, `evolve_revision`, `memory_revision`, `setting`, `held_out`, `optimizer_model`, `optimizer_reasoning_effort` |
| What the optimizer saw | `history_digest`, `memory_digest`, and each call's `input_digest` |
| Which sample is in progress | The candidate row with status `generating` or `evaluating`. At most one exists. |
| Each sample's diagnosis, scan, screen verdict and evolve score | `learning_candidates` |
| The selector's choice | The `select` call's `output`, then `learning_rounds.selection` |
| The release | `channels` and `promotions`, and `adopted_sample` and `adopted_version_id` |
| Monitoring | `incumbent_score`, `held_out_score`, `held_out_error` |
| Loop health | `learning_loops.status`, `pause_reason`, `failed_rounds` |

## The worker

`src/learning/worker.rs` holds the worker, and phase 3 spawns `learning_worker` from `src/main.rs` beside `invitation_worker`. Today the proposal worker calls `s.runtime.worker_started()` (`src/improvement.rs:432`), and the service waits on it before it opens its socket (`src/main.rs:185-189`). Phase 2 moves that call into `invitation_worker` ([removal.md](removal.md)). Phase 3 moves it from `invitation_worker` to `learning_worker`, so `wait_for_worker` waits on the learning worker. `RuntimeStatus.worker_live` is one flag (`src/runtime.rs:54-58`, `:98-102`), so exactly one worker holds the lifetime.

```rust
pub async fn learning_worker(s: AppState) {
    let _lifetime = s.runtime.worker_started();
    let mut calls = CallTasks::default();          // JoinSet + set of (round_id, kind, sample) held by live tasks
    let mut retry_after = HashMap::new();          // (project, bundle) -> Instant, as today
    let mut next_sweep = Instant::now();
    while !s.runtime.is_draining() {
        calls.reap();                              // drop finished tasks from the held set
        if Instant::now() >= next_sweep {
            next_sweep = Instant::now() + Duration::from_secs(5);
            log_err(sweep(&s, &calls).await);
        }
        log_err(tick(&s, &mut calls, &mut retry_after).await);
        select! { _ = sleep(Duration::from_millis(500)) => {}, _ = s.runtime.wait_for_drain() => return }
    }
}
```

Every database transaction the worker opens first takes `s.runtime.claim_permit()`, as today's tick does (`src/connected_learning_worker.rs:1890-1892`), so draining settles claims before ownership is released (`src/runtime.rs:81-90`).

### `tick`

1. List the loops with work: `status = 'running'`, or any status with an active round.

   ```sql
   SELECT l.project_id, l.bundle_id FROM learning_loops l
   WHERE l.status = 'running'
      OR EXISTS (SELECT 1 FROM learning_rounds r
                 WHERE (r.project_id, r.bundle_id) = (l.project_id, l.bundle_id)
                   AND r.state = ANY($1))          -- ACTIVE_ROUND_STATES
   ORDER BY l.updated_at, l.project_id, l.bundle_id;
   ```

2. For each loop not in `retry_after`, call `advance_round(s, project, bundle)`. An error rolls back that step, is logged, and sets `retry_after` to 10 s, as today (`src/connected_learning_worker.rs:2115-2127`). A tick error never changes round state. Errors that can be retried (a lost connection, a serialization failure) succeed later. Errors that cannot be retried (a bug) repeat in the log until an operator stops the loop.
3. Spawn call tasks. For each `learning_optimizer_calls` row with `status = 'queued'` whose key is not held, add the key to the held set and spawn `optimizer::run_call(s, key)`. Because of W3, at most one call per loop runs at a time, and loops run their calls in parallel.

### `sweep`

1. `evaluations::expire(&s.db)`: a `queued` evaluation past its queue deadline, or a `running` one past its run deadline, becomes `failed` with a deadline error ([evaluator-and-contracts.md](evaluator-and-contracts.md)). This replaces the inline `expired` checks at `src/connected_learning_worker.rs:1009-1031`.
2. Requeue orphaned calls: a `running` call whose key no live task holds becomes `queued` if `attempts < 3`, or `failed` with `error_code = 'provider-failed'` and `error = 'attempt limit reached'` if not. At start-up no task is alive, so this is today's start-up sweep (`src/main.rs:175-179`). While the service runs, it only catches a task that panicked. Today's per-iteration sweep of every `running` row (`src/improvement.rs:435-437`) was safe only because one proposal ran at a time. The held set makes it safe with one call per loop.

```sql
UPDATE learning_optimizer_calls
   SET status     = CASE WHEN attempts < 3 THEN 'queued' ELSE 'failed' END,
       error_code = CASE WHEN attempts < 3 THEN NULL ELSE 'provider-failed' END,
       error      = CASE WHEN attempts < 3 THEN NULL ELSE 'attempt limit reached' END
 WHERE status = 'running' AND NOT ((round_id, kind, sample) = ANY($1));   -- held keys
```

### The call contract this file relies on

[optimizer.md](optimizer.md) owns `optimizer::run_call(s, key)`, the call task, and `call_with_retry`, its format-retry helper. The loop needs only this:

- `advance_round` creates each call row, with its `input_digest`, under the bundle row lock.
- `run_call` claims with `UPDATE … SET status='running', attempts=attempts+1, claimed_at=now() WHERE … AND status='queued' AND attempts<3`.
- It renders its input from the round's pinned values and checks the digest against the row's `input_digest`. It checks that the configured model and reasoning effort equal the round’s optimizer pins, then calls the model with no transaction open. The one format retry happens inside the call. For `propose`, the output is validated, reconstructed and scanned inside the call, before anything is committed.
- It commits only its own row: `succeeded` with `output`, or `failed` with an `error_code` and a free-text `error`, guarded by `status='running' AND attempts=$n`. It takes no loop lock and does not recheck round state. A guard miss discards the result. This is how a stop or a sweep invalidates a late reply.
- The codes the loop reads are `provider-failed`, `format-rejected`, `optimizer-context-too-large` and `scanner-rejected` (`propose` only). Input drift, a model mismatch and the attempt limit are `provider-failed`. `cancelled` marks a call that `cancel_children` closed, and the loop never reads it.
- It never writes candidate or round rows.

## `advance_round`

`advance_round` opens one transaction, locks the loop row, takes at most one step, and commits.

```sql
SELECT * FROM learning_loops WHERE (project_id, bundle_id) = ($1, $2) FOR UPDATE;
SELECT * FROM learning_rounds
 WHERE (project_id, bundle_id) = ($1, $2) AND state = ANY($3);           -- 0 or 1 row
```

With no active round, it calls `start_round` if the loop is `running` and does nothing otherwise. With an active round, it dispatches on `state`. Each step below is guarded by the state it reads, so running it twice does nothing the second time.

### 1. `start_round` → `scoring_incumbent`

Preconditions: the loop is `running`, no round is active, and the evolve split at `evolve_revision` has at least one case (`evolve::cases_at`). While the split is empty the loop stays `running` and idle. The incumbent and every later evaluation are scored on the evolve split, so a round needs at least one case.

```sql
SELECT c.version_id, c.revision, v.digest
  FROM channels c JOIN versions v ON (v.project_id, v.bundle_id, v.id) = (c.project_id, c.bundle_id, c.version_id)
 WHERE (c.project_id, c.bundle_id, c.name) = ($1, $2, $channel) FOR SHARE;

INSERT INTO learning_rounds (id, project_id, bundle_id, number, state, parent_version_id, channel,
    channel_revision, evolve_revision, memory_revision, setting, held_out, optimizer_model, optimizer_reasoning_effort)
VALUES ($id, $1, $2, $next_round, 'scoring_incumbent', $head_version, $channel,
    $head_revision, $evolve_revision, $memory_revision, $setting, $held_out, $model, $reasoning_effort);

INSERT INTO learning_evaluations (id, round_id, role, sample, split, version_id, digest,
    evolve_revision, status, deadline_at)
VALUES ($eval, $id, 'incumbent', NULL, 'evolve', $head_version, $head_digest,
    $evolve_revision, 'queued', now() + make_interval(secs => $queue_seconds));

UPDATE learning_loops SET next_round = next_round + 1, updated_at = now()
 WHERE (project_id, bundle_id) = ($1, $2);
```

The parent is whatever the learning channel holds when the round starts, which is the paper's H_t. After an adopt it is the adopted version. After a keep it is unchanged. After a manual release it is the released version.

### 2. `scoring_incumbent` → `proposing`

Wait while the incumbent evaluation is `queued` or `running`.

- `failed`: `fail_round(…, 'incumbent-evaluation-failed')`.
- `scored`: set `incumbent_score` from the evaluation's `score`, then:
  1. Render `feedback` (`optimizer::render_feedback` over the incumbent's report), `history` (`history::render_history` over every round of this loop with `number` below this one and the same pinned `setting`) and `improvementMemory` (`memory::render_memory` at `memory_revision`). Store `history_digest` and `memory_digest`. Nothing is stored in the round row except digests. Every later call re-renders from the same pinned inputs and checks the digests.
  2. Insert candidate row sample 1 (`generating`) and its `propose` call (`queued`, `sample = 1`, `input_digest`). Set `state = 'proposing'`.

  The service learns that an input does not fit only from the provider, so an overflow shows up as sample 1's call failing with `optimizer-context-too-large` (step 3).

Phase 3 has no optimizer yet. In that phase the step goes straight to `keep(…, 'no-candidates')`, which gives the H0 baseline curves.

### 3. `proposing`: five samples, one at a time

The open sample is the `generating` candidate. Wait while its call is `queued` or `running`. When the call is terminal:

| Call outcome (`error_code`) | Candidate update |
| --- | --- |
| `failed`, `optimizer-context-too-large` | `fail_round(…, 'optimizer-context-too-large')`. The other samples would see the same input, so none is tried. |
| `failed`, `provider-failed` or `format-rejected` | `dropped` with that `drop_reason` |
| `failed`, `scanner-rejected` | Copy `scan` and `diagnosis` from the call's `output` ([optimizer.md](optimizer.md)). `dropped` / `scanner-rejected`, with `rationale` and `changes` left NULL. |
| `succeeded` | The output is already validated and scanned clean. Store `rationale`, `changes` and `diagnosis` from it, and `scan = {clean: true, findings: []}`. Rebuild the payload with `proposal_edits::reconstruct` on the parent payload and hash it with `crate::digest(encode_payload(…))` (`src/lib.rs:142`, `:160`). Equal to the parent digest: `dropped` / `no-change`. Otherwise `generated`. Identical samples are both kept. |

The diagnosis is written in this step, before any screen or evaluation exists. The check `status IN ('generating','dropped') OR diagnosis IS NOT NULL` enforces it.

Then:

- If the sample was below 5, insert the next candidate row and its `propose` call. Every sample gets the same input: siblings do not see each other (README question 9).
- If it was sample 5, exit `proposing`:

| Samples | Next |
| --- | --- |
| At least one `generated` | Insert the `screen` call (`sample = 0`) over every `generated` sample. `state = 'screening'`. |
| None `generated`, all 5 `provider-failed` | `fail_round(…, 'optimizer-unavailable')` |
| None `generated`, otherwise | `keep(…, 'no-candidates')` |

A missing `ACCLIMATE_MODEL` makes every call `provider-failed`, so the round fails with `optimizer-unavailable`. After `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` such rounds, the loop pauses.

### 4. `screening`

Wait while the `screen` call is open.

- `failed` with `optimizer-context-too-large`: `fail_round(…, 'optimizer-context-too-large')`.
- `failed` with any other code: `fail_round(…, 'selector-unavailable')`.
- `succeeded`: the stored output has exactly one entry per `generated` sample ([optimizer.md](optimizer.md) validates this). This step, not the call, stores each `{verdict, reason}` on its candidate's `screen`. A `skip` sample becomes `screened_out`. An `evaluate` sample stays `generated` until its turn. If every sample is `skip`, call `keep(…, 'no-survivors')`. Otherwise start the first survivor (step 5) and set `state = 'evaluating'`.

### 5. `evaluating`: survivors, one at a time

A **survivor** is a `generated` candidate whose `screen` verdict is `evaluate`. To start one, in sample order:

```sql
INSERT INTO versions (id, project_id, bundle_id, parent_version_id, digest, payload, created_by)
VALUES ($v, $1, $2, $parent_version_id, $digest, $payload, 'service:learning-loop');
INSERT INTO learning_evaluations (id, round_id, role, sample, split, version_id, digest,
    evolve_revision, status, deadline_at)
VALUES ($e, $round, 'candidate', $sample, 'evolve', $v, $digest, $round_evolve_revision, 'queued',
    now() + make_interval(secs => $queue_seconds));
UPDATE learning_candidates SET status = 'evaluating', version_id = $v, evaluation_id = $e
 WHERE (round_id, sample) = ($round, $sample) AND status = 'generated';
```

The payload is reconstructed again from the stored `changes`, and `compatibility::validate_in_tx` runs before the insert, as the proposal commit does today (`src/improvement.rs:753-760`). A version is created only for a survivor, and only when its evaluation is created. The queue deadline therefore counts from the moment the sample is offered, not from the end of screening.

When the `evaluating` candidate's evaluation is terminal:

- `scored`: the candidate becomes `evaluated`, with `evolve_score` from the evaluation's `score`.
- `failed` or `cancelled`: `evaluation_failed`.

Then start the next survivor. When none is left:

| Candidates | Next |
| --- | --- |
| At least one `evaluated` | Insert the `select` call (`sample = 0`) over the `evaluated` candidates. `state = 'selecting'`. |
| None `evaluated` | `keep(…, 'no-evaluated-candidates')` |

Every candidate evaluation uses the round's `evolve_revision`. Cases added during the round reach the next round, not this one.

### 6. `selecting`

Wait while the `select` call is open.

- `failed` with `optimizer-context-too-large`: `fail_round(…, 'optimizer-context-too-large')`.
- `failed` with any other code: `fail_round(…, 'selector-unavailable')`.
- `succeeded` with `{decision: "adopt", sample}`: `adopt`. The output names an `evaluated` sample ([optimizer.md](optimizer.md) validates this, with the one format retry).
- `succeeded` with `{decision: "keep"}`: `keep(…, 'selector-kept')`.

The call committed its output in its own transaction. This step reads that stored output and runs `adopt` or `keep` in a later transaction, so a rollback here never loses the selection (W5).

### 7. `adopt`

One transaction, inside `advance_round`, which already holds the bundle row lock:

```sql
-- 1. Same lock order as a manual release (src/channels.rs:236-242): advisory lock, then channel row.
SELECT pg_advisory_xact_lock(hashtextextended('promotion:' || $1 || ':' || $2 || ':' || $channel, 0));
SELECT revision, version_id FROM channels
 WHERE (project_id, bundle_id, name) = ($1, $2, $channel) FOR UPDATE;
-- 2. If revision <> learning_rounds.channel_revision: keep(…, 'channel-moved') with selection, and stop here.
-- 3. Release.
--    channels::promote_in_tx(tx, $1, $2, $channel, "service:learning-loop",
--        PromoteRequest { version_id: $adopted_version, expected_revision: $channel_revision,
--          unevaluated_reason: "Adopted in learning round <number>, sample <sample>" })
--    writes channels.revision = channel_revision + 1 and one promotions row with
--    reviewer = 'service:learning-loop' and previous_version_id = parent_version_id.
-- 4. Record the decision.
UPDATE learning_rounds
   SET decision = 'adopted', adopted_sample = $sample, adopted_version_id = $adopted_version,
       selection = $selection, state = 'scoring_held_out'
 WHERE id = $round AND state = 'selecting' AND selection IS NULL;
-- 5. memory::write_back(tx, round): appends one attempt, increments learning_loops.memory_revision.
-- 6. Queue the held-out evaluation of the new channel head against learning_rounds.held_out.
INSERT INTO learning_evaluations (id, round_id, role, sample, split, version_id, digest, status, deadline_at)
VALUES ($h, $round, 'retained', NULL, 'held_out', $adopted_version, $adopted_digest, 'queued',
        now() + make_interval(secs => $queue_seconds));
```

`selection` is `{decision: "adopt", sample, versionId, digest, reason, model, inputDigest}`. `inputDigest` is the `select` call's `input_digest`, `model` is `optimizer_model` and `reason` is the selector's. When set, `reasoningEffort` records the pinned effort.

`adopt` checks the revision itself before it calls `promote_in_tx`, so a moved channel is a normal outcome and not an error to map. The advisory lock is reentrant in the same session, so `promote_in_tx` taking it again is harmless. Any other `promote_in_tx` error (for example, a bundle target that changed during the round) rolls back the whole step as a tick error. Nothing is released and nothing is written to memory.

`promote_in_tx` takes no publication argument: [removal.md](removal.md) deletes `Publication` and the comparison and policy branches in phase 2. `promotions` keeps `unevaluated_reason` and loses only `comparison_id`, `policy_override` and `policy_approval_promotion_id`. The round is named in `unevaluated_reason`, so no new column is needed. The adopted version's evolve evaluation is on the candidate row, and the round is the evidence.

### 8. `keep`

`keep(tx, round, reason, selection)` sets `decision = 'kept'`, `reason`, `selection` (only for `selector-kept` and `channel-moved`), and `state = 'scoring_held_out'`. It reads the learning channel head `FOR SHARE` and queues the `retained` held-out evaluation of that version. That version is the parent, or for `channel-moved` the manually released one. Nothing is written to memory. For `channel-moved`, `selection` keeps the selector's `adopt` choice, so the record shows what would have been released.

### 9. `scoring_held_out` → `completed`

Wait while the `retained` evaluation is open.

- `scored`: `held_out_score` = its `score`.
- `failed`: `held_out_error` = its `error`.

Then set `state = 'completed'` and `ended_at = now()`, and set `failed_rounds = 0` on the loop. The next `tick` starts the next round if the loop is still `running`.

The held-out result never reaches `render_feedback`, `render_history` or `render_memory`. None of them reads `held_out_score`, `held_out_error` or a `held_out` evaluation. A test asserts this (test 19).

### `fail_round` and `stop_round`

```text
fail_round(tx, loop, round, reason):
    cancel_children(round, 'round failed')
    UPDATE learning_rounds SET state='failed', reason=$reason, ended_at=now() WHERE id=$round AND state=ANY(active)
    UPDATE learning_loops SET failed_rounds = failed_rounds + 1
    IF reason = 'optimizer-context-too-large':
        -- whatever the status: an operator pause is overwritten, so the cause shows
        UPDATE learning_loops SET status='paused', pause_reason='optimizer-context-too-large'
    ELSE IF loop.status = 'running' AND failed_rounds >= ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS:
        pause(loop, 'failed-rounds')

stop_round(tx, round):        -- called by POST /stop with the bundle row lock held
    cancel_children(round, 'stopped')
    UPDATE learning_rounds SET state='stopped', ended_at=now(),
           reason = CASE WHEN decision IS NULL THEN 'stopped' ELSE reason END
     WHERE id=$round AND state=ANY(active)

cancel_children(round, why):
    UPDATE learning_evaluations SET status='cancelled', error=$why
     WHERE round_id=$round AND status IN ('queued','running')
    UPDATE learning_optimizer_calls SET status='failed', error_code='cancelled', error=$why
     WHERE round_id=$round AND status IN ('queued','running')
    UPDATE learning_candidates SET status='evaluation_failed'
     WHERE round_id=$round AND status='evaluating'
```

A `generating` or `generated` candidate in a failed or stopped round keeps its status. The round's terminal state explains it. Stopped rounds do not count toward `failed_rounds`.

`ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` is a positive integer, default 3, read like `deadline_seconds` (`src/connected_learning_worker.rs:1434-1441`). The automatic pause is a deliberate addition to the paper's loop ([decisions.md](decisions.md#deliberate-deviations-from-the-paper)): every failed round spends a full incumbent evaluation, and a broken optimizer endpoint would otherwise fail rounds back to back without end.

## Loop status

`POST /pause`, `POST /resume`, `POST /stop` and `PUT` are in `src/learning.rs` ([evaluator-and-contracts.md](evaluator-and-contracts.md)). Each locks the loop row `FOR UPDATE` first, and they do the following:

| Route | From | Effect |
| --- | --- | --- |
| `PUT` | (none) | Insert the loop `running`. The next tick starts round 1. |
| `PUT` | `stopped` | `status = 'running'`, apply the body. `next_round`, `memory_revision` and the evolve split continue. |
| `PUT` | `running`, `paused` | Apply the body. Status is unchanged. While a round is active, a change to `channel`, `appPrincipalId` or `heldOut` is `409 learning_conflict` and changes nothing. A `setting` change is accepted, and the active round keeps its pinned `setting` (W9). |
| `POST /pause` | `running` | `status = 'paused'`, `pause_reason = 'operator'`. The active round runs to its end, and no round starts. |
| `POST /resume` | `paused` | `status = 'running'`, `pause_reason = NULL`, `failed_rounds = 0` |
| `POST /stop` | `running`, `paused` | `stop_round` on the active round, then `status = 'stopped'`, `pause_reason = NULL` |

An automatic pause (`failed-rounds`, `optimizer-context-too-large`) only happens in `fail_round`, after the round has ended. A paused loop with an active round therefore always has an operator pause. `optimizer-context-too-large` replaces an operator pause reason, so the cause is visible and `POST /resume` is a deliberate choice.

## Held-out monitoring per round

- Every round that records a decision (adopted or kept, any reason) queues exactly one `retained` evaluation on the `held_out` split, of the learning channel head at decision time. Failed rounds and rounds stopped before a decision have none.
- The evaluator scores it from its own store against the round's pinned `learning_rounds.held_out`. The report carries only `score` and `passed` per rollout ([evaluator-and-contracts.md](evaluator-and-contracts.md)).
- Its score goes to `held_out_score` and nowhere else. The console and `GET /rounds` show the curve as one point per round with no running maximum.
- A failed held-out evaluation still completes the round. Monitoring never gates (decisions.md, D3).

## Crash recovery and idempotency

Every step is one transaction. A crash before a commit leaves the previous state, and the step runs again. A crash after a commit leaves the new state, and the step's state guard makes a second run a no-op. Model calls and evaluator work are the only things that happen outside transactions.

| Commit point | Crash before commit | Crash after commit |
| --- | --- | --- |
| `start_round` (round, incumbent evaluation, `next_round`) | No round. The next tick starts it. | The round exists. `learning_rounds_one_active` blocks a second one. |
| Incumbent scored → `proposing` (score, digests, sample 1 call) | Still `scoring_incumbent` with a scored evaluation. The next tick repeats the step. | Sample 1 call is queued. |
| Call claim (`running`, `attempts + 1`) | Still `queued`. | `sweep` requeues it (`attempts < 3`), or fails it as `provider-failed`. |
| Call result (`succeeded` or `failed`, one row) | Claim stays `running`. `sweep` requeues it and the model is called again. Nothing depended on the lost reply. | The output is durable and never replaced. |
| Sample processed (candidate status, next call) | The call is terminal, and the candidate is still `generating`. The step repeats with the same output, which gives the same scan, digest and status. | Next sample's call is queued. |
| `screening` result applied (verdicts, first survivor's version and evaluation) | As before, from the stored screen output | First survivor is `evaluating`. |
| Evaluation report | [evaluator-and-contracts.md](evaluator-and-contracts.md): the report is idempotent per evaluation. | The evaluation is terminal. |
| Survivor processed (candidate status, next survivor or `select` call) | Repeats from the terminal evaluation | Next step queued |
| `select` result | Claim stays `running`. Sweep requeues and the model is called again. No decision depended on it. | **Durable selection.** Every later attempt at adopt or keep reads this output. |
| `adopt` or `keep` (selection, release, write-back, held-out evaluation) | Nothing is released or written. The next tick reads the same stored output and makes the same decision. The channel check runs again, so a manual release in between gives `channel-moved`. | `state` is `scoring_held_out`. The guard `state = 'selecting' AND selection IS NULL` blocks a second release. `learning_memory_attempts` is unique on `round_id`, which blocks a second write-back. |
| Held-out scored → `completed` | Repeats | Next tick starts the next round. |

Process restart: the single leader lock (`src/main.rs:150-161`) means no other process holds call tasks, so the start-up `sweep` requeues every `running` call. Evaluations in `running` stay `running`. Their evaluator may still report them, and otherwise the run deadline fails them.

A late reply or report never lands on a closed round. `cancel_children` moves every open call to `failed` and every open evaluation to `cancelled`. A call result needs `status = 'running'`, and a report needs a `running` evaluation, so either one is refused. The worker never reads a cancelled child as a result.

## Concurrency

**Inside a loop.** Every state change takes the loop row lock: `advance_round`, the routes, `POST /evolve-cases` and `POST /outcomes` (which bump `evolve_revision`). Call commits and evaluation reports do not take it. They update only their own row, under a status guard. A stop and a late result conflict only on that row, and whichever commits first wins.

**Between rounds.** There is one active round per loop (W2), and a round never overlaps the next. Held-out scoring of round t finishes before round t+1's incumbent is queued (open question 2).

**Between bundles.** Loops share no rows. One loop's transactions lock its own loop row and its own learning channel. Call tasks for different loops run at the same time, and each loop's evaluations are served to its own app principal. A slow model call or evaluator on one bundle never delays another. The worker's database steps are short and do not wait on models, so one worker task serves every loop.

**Lock order.** Every path takes locks in this order:

1. `learning_loops` row
2. promotion advisory lock (`promotion:{project}:{bundle}:{channel}`)
3. `channels` row
4. memory tables (inside `write_back`)

A manual release takes 2 and then 3 (`src/channels.rs:236-242`) and never takes 1, so it cannot deadlock with `adopt`. `start_round` and `keep` read the channel `FOR SHARE` after 1 and skip 2. A concurrent manual release makes them wait for its commit, then read the new head. That is correct: the new head becomes the parent, or the retained version.

**Manual releases on the learning channel.** The channel release route stays (D8 default). A manual release during a round turns that round's adopt into `kept` / `channel-moved`. The next round's parent is the manually released version (README question 2).

## Deadlines and errors

| What | Bound |
| --- | --- |
| Evaluation not started | `ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS` (default 7 days) from creation, then `failed` |
| Evaluation started | `ACCLIMATE_LEARNING_EVALUATION_SECONDS` (default 24 h) from start, then `failed` |
| Optimizer call | `ACCLIMATE_MODEL_TIMEOUT_SECONDS` per HTTP request, at most two requests per claim (the format retry), at most 3 claims |
| Round | No round deadline. It is bounded by the sum of its children. |
| Tick error | Retried after 10 s and logged. It never changes state. |

Failures are recorded where they happen: per candidate (`drop_reason`, `evaluation_failed`), per call (`error`), per evaluation (`error`), per round (`reason`, `held_out_error`) and per loop (`failed_rounds`, `pause_reason`).

## Files to touch

Against the tree after phase 2, where [removal.md](removal.md) has already deleted `connected_learning_worker`, `proposal_worker` and their spawns and re-exports.

| File | Change |
| --- | --- |
| `migrations/0019_learning_loop.sql` | `learning_loops`, `learning_rounds` and `learning_rounds_one_active`. The evaluation tables and `learning_evaluations_one_open` are [evaluator-and-contracts.md](evaluator-and-contracts.md)'s, in the same file. |
| `migrations/0020_learning_optimizer.sql` | The `adopted_sample` foreign key. The candidate table with its status checks and `learning_optimizer_calls_one_open` are [optimizer.md](optimizer.md)'s, and the memory tables [memory.md](memory.md)'s. |
| `src/learning/worker.rs` (new) | `learning_worker`, `tick`, `advance_round`, `start_round`, `adopt`, `keep`, `fail_round`, `stop_round`, `cancel_children`, `sweep`, `ACTIVE_ROUND_STATES`, `CallTasks` |
| `src/learning.rs` | `mod worker;`. Pause, resume, stop and `PUT` call `worker::stop_round` and take the loop row lock first. |
| `src/lib.rs` | `mod learning;` and `pub use learning::worker::learning_worker;` |
| `src/main.rs` | Spawn `learning_worker` beside `invitation_worker`. Move `runtime.worker_started()` from `invitation_worker` into `learning_worker`, so start-up waits on the learning worker. |
| `src/invitations.rs` | Drop the `worker_started()` call that phase 2 added |
| `src/channels.rs` | None. `adopt` calls `promote_in_tx` as phase 2 leaves it, with no publication argument. |
| `tests/learning_loop.rs` (new) | The tests below |

## Tests

`tests/learning_loop.rs` uses `#[sqlx::test]` and `#[ignore = "requires isolated PostgreSQL; run scripts/productization/rust_tests.py"]`, as `tests/production_schema.rs:5-6` does. It uses a scripted `OptimizerModel` fake that records every input it receives and returns queued outputs. The fake evaluator calls `evaluations::start` and `evaluations::report` directly. A helper steps the worker by calling `advance_round`, `sweep` and the call runner directly, so each test controls the order of events.

**Path through the state machine**

1. Enrolling starts round 1 at the next tick. The round pins equal the channel head, its revision, `evolve_revision`, `memory_revision`, `setting`, `held_out` and the model. No round starts while the evolve split is empty.
2. Back to back: when a round completes, the next tick starts round `n + 1`. A second active round violates `learning_rounds_one_active`.
3. Each exit from `proposing`: `no-candidates` (a mix of format, scanner and no-change drops), `optimizer-unavailable` (5 provider failures), and `optimizer-context-too-large` on sample 1, which runs no further sample and pauses the loop. Two samples with identical changes are both `generated`.
4. Serial work: while a round runs, at most one call and at most one evaluation are `queued` or `running`. Sample n + 1's call exists only after sample n is terminal. Survivor n + 1's version and evaluation exist only after survivor n is terminal.
5. Predictions before evaluation: every candidate with an evaluation has a non-null `diagnosis` that was written in an earlier transaction. A direct `UPDATE` that sets `evaluating` with a NULL diagnosis is refused by the check.
6. Barrier: no `screen` call exists while a sample is `generating`. No candidate version or evaluation exists before the screen output is applied.
7. Screen: all `skip` gives `kept` / `no-survivors`. A failed screen call gives `failed` / `selector-unavailable`, and one that overflows gives `failed` / `optimizer-context-too-large`. Skipped samples are `screened_out` and get no version. The screen call's commit changes no candidate row. `advance_round` writes the verdicts.
8. Evaluation: every survivor `evaluation_failed` gives `kept` / `no-evaluated-candidates`, then held-out scoring.

**Adopt, keep and release**

9. Adopt, in one commit: the channel revision is `channel_revision + 1` with the adopted version, and one `promotions` row has reviewer `service:learning-loop` and `previous_version_id` equal to the parent. There is one memory attempt and `memory_revision + 1`. `selection.inputDigest` equals the `select` call's `input_digest`. There is one `retained` held-out evaluation of the adopted version. The next round's parent is the adopted version.
10. Keep (`selector-kept`): the channel is unchanged, there is no promotion and no memory attempt, and the retained evaluation is of the parent.
11. `channel-moved`: a manual release lands between the `select` output and `adopt`. The result is `kept` / `channel-moved`, `selection.decision = 'adopt'`, no service promotion and no memory attempt. The retained evaluation is of the manual head, and the next round's parent is the manual head.
12. Lock order: a manual release and an `adopt` on the same channel, started in both orders on two connections, finish without deadlock.

**Crashes and durability**

13. A crash at every commit point in the recovery table: each step runs and then rolls back instead of committing, and the step runs again. A crash after commit is the step run twice. The final rows equal an uninterrupted run: one round, one release, one attempt, the same candidate statuses.
14. Durable selection: the fake selector returns `adopt 2` on its first call and `adopt 4` on any later call. A rollback of the adopt step after the `select` output committed still adopts sample 2, and the fake is called once.
15. Restart: a call left `running` with no live task is requeued by `sweep`. At `attempts = 3` it becomes `failed` with `error_code = 'provider-failed'` and `error = 'attempt limit reached'`, and the sample is `dropped`. A `running` call held by a live task is not requeued.
16. Late model reply: after a stop, `run_call`'s commit matches no row and the candidate is unchanged.

**Pause, stop and failure counting**

17. Stop in each of the six active states: the round is `stopped`, open evaluations are `cancelled`, open calls are `failed`, `evaluating` candidates are `evaluation_failed`, and the loop is `stopped`. A report for a cancelled evaluation is refused. Before a decision, no release or memory write happens. A stop in `scoring_held_out` after an adopt keeps the decision and the release. A later `PUT` resumes with `number` and `memory_revision` continuing.
18. Pause: the active round runs to `completed`, and no new round starts. Resume clears `pause_reason` and `failed_rounds`, and a round starts. Three consecutive failed rounds pause with `failed-rounds`. A completed round between failures resets the count. A stopped round does not count. An operator-paused loop whose active round fails with `optimizer-context-too-large` ends with `pause_reason = 'optimizer-context-too-large'`.

**Monitoring and isolation**

19. The held-out result never reaches the optimizer: after rounds with distinctive held-out scores and errors, no input the fake recorded contains them, and none contains a `held_out` evaluation.
20. Held-out never gates: a held-out score of 0 after an adopt leaves the channel, the decision and memory unchanged. A failed held-out evaluation completes the round with `held_out_error`.
21. Deadlines: an incumbent past its queue deadline fails the round with `incumbent-evaluation-failed`. A candidate past its run deadline is `evaluation_failed`, and the next survivor starts.
22. Pins: cases added in the middle of a round are absent from every evaluation of that round and present in the next one. A `PUT` that changes `setting` in the middle of a round succeeds, and the round keeps its pinned `setting`. A `PUT` that changes `channel`, `appPrincipalId` or `heldOut` in the middle of a round gets `409` and leaves the loop and the round unchanged.
23. Two loops on two bundles run rounds at the same time: a call blocked on one loop's fake does not delay the other loop's steps. Stopping one loop leaves the other running.

## Open questions

Shared questions are in the [README](README.md#open-questions). These are owned here:

1. **Auto-revert.** The loop never reverts an adopted release (D3). A held-out drop could revert the channel to the round's parent, or pause the loop, in the `scoring_held_out` → `completed` step. Today the held-out score is only stored and shown.
2. **Held-out scoring overlapping the next round.** Round t+1 could start its incumbent evaluation while round t's held-out evaluation runs. With one serial evaluator per app, this saves no time, and it would need the one-open-evaluation index per loop instead of per round. Keep strictly serial unless evaluators become parallel.
3. **Round-0 held-out score (closed).** The paper's curves start at H0, and the loop first scores the held-out split after round 1's decision. [experiment.md](experiment.md) deviation V4 has the driver score H0 and H_S outside the loop with the same evaluator function, so the loop needs no round-0 evaluation.
4. **App principal losing `evaluate`.** If the app principal's token is revoked, evaluations are never claimed and fail only at the 7-day queue deadline. That takes three rounds before the loop pauses. Should `start_round` check the principal's rights and pause the loop at once? That would need a new `pause_reason`.
5. **Re-scoring an unchanged incumbent.** Each round scores its parent on the evolve split again, even when the parent was evaluated as the adopted candidate of the previous round at the same `evolve_revision`. This follows the paper (F_t comes from evaluating H_t) and budget is not a constraint (D9). Reusing that evaluation would cut one evaluation per round. Keep re-scoring: [experiment.md](experiment.md) §8.3 measures the winner's curse as the adopted candidate's `evolve_score` minus the next round's `incumbent_score`, which needs this fresh measurement.
