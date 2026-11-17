# Optional remote evaluator activity

The 2026-11-17 follow-up request authorizes this additive D2 §16 gap closure. The approved design in `docs/design/developer-experience-council/PLAN.md` remains frozen. This addendum addresses the platform persona's missing remote activity observation without assigning execution ownership to Acclimate.

## Public contract

`GET /v1/projects/{project}/bundles/{bundle}/evaluation-requests/{request}/progress` requires current project read authority. It returns one coherent snapshot:

```json
{
  "schemaVersion": 1,
  "requestId": "…",
  "status": "running",
  "attemptId": "app-owned-attempt",
  "activity": "fresh",
  "checkedAt": "2026-11-17T12:00:00Z",
  "staleAfterSeconds": 60,
  "observation": {
    "attemptId": "app-owned-attempt",
    "sequence": 4,
    "phase": "grading",
    "completed": 1,
    "total": 2,
    "case": {"caseId": "public-case-id", "repetition": 0},
    "receivedAt": "2026-11-17T11:59:55Z",
    "evaluatorPrincipal": "app-owned-principal"
  }
}
```

`POST` to the same path accepts only the observation's `attemptId`, `sequence`, `phase`, `completed`, `total`, and optional `case`; timestamps and principal always come from the service. The maximum encoded request is 2 KiB. Unknown fields are rejected, including unknown nested case fields. There are no raw outputs, paths, callback exception messages, arbitrary log messages, or provider errors in this contract.

The current project writer must be the lifecycle's evaluator principal, with exactly the running attempt. Authorization is checked in the same transaction that locks the lifecycle request, using the existing session and membership revocation rules. Static machine grant revocation follows the existing deployment configuration model. Observing activity does not grant write, propose, promote, or interruption authority.

`sequence` is an integer from 1 through 2^53−1. It must increase for a new observation. Exact same-sequence/body retries return the original observation without refreshing `receivedAt`. A different body at the same sequence or any older sequence returns 409. `completed` is a nondecreasing integer from zero to `total`; `total` must equal twice the request's fixed case/repetition inventory size, at most 2,000. Count each completed side as one unit according to the application's reporting convention. Counts are app assertions, never evidence of scored outcomes. Phase is `preparing`, `executing`, `grading`, or `submitting`; phase may alternate as the application processes cases. Optional case identity must exist in the request inventory. The application owns its sequence and count persistence; a restart cannot reset them.

The response's `activity` is `fresh` only when the durable lifecycle is running and the receipt is at most 60 seconds old at `checkedAt`. A retained older receipt, or any terminal lifecycle with a receipt, is `stale`. No retained receipt is `absent`. These are reported activity observations and unknown states. A fresh report is not proof that a provider remains active; stale or absent never means stopped, cancelled, abandoned, safe to replay, or available for takeover. Interruption records intent/state under the existing lifecycle contract; it does not prove external work stopped. A late progress write after interruption fails, including an exact retry.

## Retention and migration

Migration `0016_evaluation_progress.sql` adds one optional latest payload row per evaluation request and a small sequence/completed/fingerprint watermark to the retained lifecycle row. Observation payloads expire logically after 24 hours and are filtered from reads immediately. Each accepted or exact-replayed report removes at most 100 expired payload rows, using the `(expires_at, request_id)` index and `SKIP LOCKED`; idle expired rows can remain physically until subsequent reporting or explicit database maintenance. Storage is bounded to one payload per retained request. Deleting a lifecycle request cascades to its observation.

The permanent watermark survives payload expiry and physical removal, preventing old writes or count resets from becoming new activity. An identical latest-sequence retry after expiry returns `absent`, never a refreshed receipt. There is no observation event history, collection endpoint, cursor, or unbounded pagination. The SDK supplies a transport key for its existing retry machinery; the server's idempotency is attempt/sequence/body, and creates no command-result, operation-record, or mutation-audit row per observation. Existing lifecycle mutation retention is unchanged. Apply the normal migration path before deploying the API or console; older clients require no changes.

## App recipe

Reporting is opt-in and app-owned. `createEvaluationProgressReporter` (TypeScript) and `EvaluationProgressReporter` (Python) bind an existing authenticated client to a request and attempt. Calls explicitly report an observation and return `true`/`false`. Invalid reports, network failures, revocation, and response errors return `false` without exposing exception text or failing external work. Construction starts no network traffic, timer, background thread, provider work, or lifecycle transition. Use a client with an appropriate reporting timeout/retry budget when callback latency matters. A slow provider callback may produce a stale observation until the application reports again; this is honest uncertainty.

For an uninterrupted, sequential run, an application can keep counters in its own attempt state and report around its existing callback. Persist that state if the application supports resuming an attempt. Example TypeScript callback body:

```ts
// client is the app's existing authenticated AcclimateClient.
// attemptState belongs to the app and is keyed by requestId + attemptId.
const reporter = createEvaluationProgressReporter(client, {
  projectId, bundleId,
  requestId: input.context.requestId,
  attemptId: input.context.attemptId,
});
await reporter.report({
  sequence: ++attemptState.sequence, phase: 'executing',
  completed: attemptState.completed, total: expectedCases.length * 2,
  case: {caseId: input.caseId, repetition: input.repetition},
});
const result = await executeOwnedByApplication(input);
await reporter.report({
  sequence: ++attemptState.sequence, phase: 'grading',
  completed: ++attemptState.completed, total: expectedCases.length * 2,
  case: {caseId: input.caseId, repetition: input.repetition},
});
return result;
```

The Python equivalent inside `execute(input)` uses the same app-owned counters:

```python
reporter = EvaluationProgressReporter(client, project_id=project_id,
    bundle_id=bundle_id, request_id=input.context.request_id,
    attempt_id=input.context.attempt_id)
attempt_state.sequence += 1
reporter.report(sequence=attempt_state.sequence, phase="executing",
    completed=attempt_state.completed, total=len(expected_cases) * 2,
    case={"caseId": input.case_id, "repetition": input.repetition})
result = execute_owned_by_application(input)
attempt_state.sequence += 1
attempt_state.completed += 1
reporter.report(sequence=attempt_state.sequence, phase="grading",
    completed=attempt_state.completed, total=len(expected_cases) * 2,
    case={"caseId": input.case_id, "repetition": input.repetition})
return result
```

No reporter return value determines whether callbacks execute, retry, finish, interrupt, or take over. The runner's existing journal and execution uncertainty rules remain authoritative. Reporter failure can leave an older receipt visible; it cannot change lifecycle truth.

## Acceptance and limits

The real PostgreSQL 16 integration test `tests/evaluation_progress.rs` covers current read/write authority, foreign principals, wrong attempts/cases, bounded fields, same-sequence idempotency, concurrent out-of-order writes, monotone counts, stale/expired receipts, watermark persistence, bounded purge, machine and browser revocation, interruption, and absence of retained operation growth. TypeScript and Python tests show report failure stays nonfatal, private extra fields never enter a report, and construction performs no work. These checks make no model calls.

The console displays a selected request's current observation and receipt/check timestamps separately from durable status. Optional read failure cannot hide the durable request. Browser/persona acceptance should run a model-free app that reports inside its callbacks, read the observation with a separate read token, then age or expire the receipt in the disposable test database and refresh the selected history row. Verify recent/stale/absent wording without treating stale/absent as cancellation or retry permission. No automatic runner heartbeat is required or introduced.
