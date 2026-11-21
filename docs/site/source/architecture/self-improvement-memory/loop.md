# Learning loop

One loop runs per workspace and bundle. An enrolled loop advances while running and has at most one active round. A release follows adoption in the same transaction. The [state machine](README.md#round-state-machine) enumerates the transitions, and the [names table](README.md#tables) lists the columns. The previous admission, calibration, comparison and parent-cache paths were removed in phases 1 and 2. [Removal inventory](removal.md)

## Storage and pins

- `0019_learning_loop.sql` creates `learning_loops`, `learning_evolve_cases`, `learning_rounds` and `learning_evaluations`. The loop row is the serialization lock for state changes and evolve case mutations. Partial unique indexes enforce one active round per loop and one open evaluation per round.
- `0020_learning_optimizer.sql` creates the candidate, optimizer-call and memory tables. A partial unique index enforces one open optimizer call per round. An adopted sample references its candidate.
- `0021_optimizer_effort.sql` adds `learning_rounds.optimizer_reasoning_effort` and the evolve listing index `learning_evolve_cases_page`.
- `start_round` pins the channel head and revision, evolve and memory revisions, setting, held-out commitment, and configured optimizer model and effort. Even two rounds that start from the same version each evaluate their incumbent afresh. The former parent evaluation cache has no reader in the new loop.
- The first `optimizer::enqueue` stores the digests of the rendered history and memory and creates candidate sample 1. Subsequent samples are inserted one at a time. Every enqueue computes an input digest. A claim renders the input again and verifies the three digests before sending it.

## The worker

`learning_worker` counts toward process drain using `runtime.worker_started()`. It owns a Tokio `JoinSet` and a map from task ID to round ID. The service leader lock limits dispatch to one process. Tasks for different rounds can run concurrently, and a round with a live task cannot dispatch a second one. The worker wakes every 500 ms or on drain. [Worker](../../../src/learning/worker.rs#L15), [service startup](../../../src/main.rs#L169)

### `tick`

`tick` walks loops in `updated_at, project_id, bundle_id` order. It visits running loops and loops with an active round, including paused ones. `advance_round` claims a runtime permit, locks the loop row and commits one step. With no active round, `advance_locked` calls `start_round` only if the loop is running and its live evolve case count is positive. An error advancing one loop is logged and gives that loop a 10-second retry delay. [Tick and advance](../../../src/learning/worker.rs#L55)

### `sweep`

At startup and then every five seconds, `sweep` expires queued and running evaluations and recovers orphaned running optimizer calls. It skips calls whose round still has a live task. A call with fewer than three claims returns to `queued`. The third orphaned claim becomes `failed` / `provider-failed` with `error = 'attempt limit reached'`. Evaluation attempts remain running across service restart until the runner resumes them or their deadlines pass. Queue and run defaults are seven days and one day, respectively. [Sweep](../../../src/learning/worker.rs#L78), [queue](../../../src/learning/worker.rs#L249), [start](../../../src/learning/evaluations.rs#L277)

## `advance_round`

`advance_locked` handles incumbent and retained scoring. `worker::advance::step` dispatches the four optimizer states. A failed incumbent ends the round. A scored incumbent starts proposing. Five samples run in order and use identical base input. A clean sample with the parent digest is dropped as `no-change`. The screen covers generated samples. The worker creates each survivor's version and queues its evaluation together in sample order. After the last survivor, only successfully evaluated samples reach select. [Round dispatch](../../../src/learning/worker.rs#L149), [optimizer stages](../../../src/learning/worker/advance.rs#L11)

`run_call` claims and commits its own row. Model I/O happens after the input transaction is closed. The commit compares both status and claim number. Only a later worker transaction uses the durable result to advance the round. If the process dies before a call commits, an orphan recovery can send it again. After commit the worker consumes the saved output. [Optimizer call](../../../src/learning/optimizer.rs#L615)

### `adopt` and `keep`

`adopt` holds the loop row lock, then acquires the promotion advisory lock and channel row lock. It checks the pinned channel revision and calls `channels::promote_in_tx` with reviewer `service:learning-loop` and `unevaluatedReason` equal to `Adopted in learning round <number>, sample <sample>`. This transaction also records the selection and adopted IDs, appends memory and queues held-out scoring. A revision mismatch records `kept` / `channel-moved`, preserves the attempted selection and scores the channel's current head. `keep` reads the head with `FOR SHARE` and saves the optional selector record. Manual release takes the promotion locks without taking the loop lock. [Adoption and keep](../../../src/learning/worker/advance.rs#L292), [channel release](../../../src/channels.rs#L163)

Retained evaluation uses the pinned commitment and the version queued by adopt or keep. A scored or failed retained evaluation completes the round, records `held_out_score` or `held_out_error`, and resets the failed-round counter. The held-out result is for monitoring. [Completion](../../../src/learning/worker.rs#L192)

## Pause, stop and failure

A caller with `promote` can change status. Signed-in callers need the administrator role. Pause lets the current round finish, and resume clears the pause reason and failure count. Stop cancels open evaluations and marks open calls `failed` / `cancelled`. An evaluating candidate becomes `evaluation_failed`. A round stopped after adoption keeps the decision, release and memory append. Enrolling a stopped loop restarts it with its existing counters, memory and history. [Status routes](../../../src/learning.rs#L362), [cancellation](../../../src/learning/worker.rs#L307)

`fail_round` cancels any unfinished children and increments the failure count. `ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS` defaults to 3, and reaching the threshold pauses a running loop. `optimizer-context-too-large` pauses immediately and takes precedence over an operator pause. [Failure](../../../src/learning/worker.rs#L270)

## Tests

The PostgreSQL tests use a running worker and HTTP routes with scripted model responses. They cover authorization, round pins, deadlines, pause and stop, lost claims, late replies, restart through optimizer states, channel movement after selection and adopt-only release and memory. The SDK end-to-end script serves evaluations against a running service. [Learning tests](../../../tests/learning_loop.rs), [optimizer integration tests](../../../tests/learning_loop/optimizer.rs), [SDK end-to-end](../../../scripts/learning-loop-e2e.ts)
