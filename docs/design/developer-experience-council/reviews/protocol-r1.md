# Independent protocol, recovery, and security critique

Disposition: **BLOCKED** on D1.

Reviewed plan SHA-256: `afa98dc2146c5a70ddda6aeda15730e69e1f53348c26897845133ec8b81b872c`.

This is a source-grounded design review, not an implementation test or live security assessment. I independently checked the plan against current operation replay, auth, evaluation transition/submission, transport, and journal code. No application code changed, models ran, secrets were read, or external systems were mutated.

## PR-1 — Retained transition snapshots must not authorize callbacks

**Blocking ambiguity.** Sections 5–6 (D1 lines 171, 187, 201–205) add retained replay for start/finish and say the runner obtains confirmed start ownership, but specify only a final authoritative re-fetch after finish. Retained responses are historical snapshots, not fresh request state. The plan needs to define reconciliation after a replay and immediately before new callback scheduling rather than leaving this consequential ordering to each implementation.

**Current evidence:** `src/evaluations.rs:260–262` returns a replay before loading or locking the evaluation row. `src/commands.rs:207–241` returns the stored response after current authorization; it does not refresh lifecycle state. Current authorization is necessary but does not establish that the request is still running. The existing runner trusts its start response (`examples/evaluation/runner.ts:101–107`).

**Failure scenario:** a start committed and its response was lost. A recovering worker reads running/requested state, then an operator interrupts it before its retained start replay returns. The replay contains the old running snapshot. An implementation following D1 literally can mark execution and schedule callbacks based on that snapshot, even though the latest state was already interrupted. Similarly a retained finish response can report an old terminal snapshot and must not replace current-state reconciliation.

**Minimum fix:** state that operation results establish the exact mutation result only. After claim/replay, fetch the latest request, verify request/principal/attempt/descriptor/version binding and running status, then persist the marker and schedule. Recheck current state before new case callbacks or define the precise weaker observation cadence. If interruption is observed, stop scheduling, retain private artifacts, and do not submit/finish successfully. Acknowledge that an interruption racing after the last check cannot stop an already-started external job; no atomic cancellation or lease guarantee is implied.

**Acceptance addition:** hold a retained start response, interrupt the request, then release the replay; zero callbacks run once the authoritative read observes interruption. Hold a finish replay and ensure returned result is reconciled with current request/binding. Test the permitted race after the last check without claiming provider termination.

## PR-2 — Capability success must imply that the selected target supports retained routes

**Blocking omission.** Section 4 exposes `retainedEvaluationOperations: true` as a deployment flag, while section 6 relies on `commands::rights` recognizing the actual route. The guided config/handoff contract does not freeze the current operation route's project-ID grammar. Static project grants permit a wider identifier set than retained routing.

**Current evidence:** `src/commands.rs:21–29` returns no route rights when a project is longer than 128 bytes or contains characters outside ASCII letters/digits/`-_.`, or is dot/dotdot. In that case `audited` and `retained` become false (`src/commands.rs:164–168`) and the retained header is silently ineffective. `src/auth.rs:9–13` validates only nonempty grant project IDs; `src/workspaces.rs:31–36` backfills them without that grammar. `scripts/evaluator-config.ts:35` permits a project value up to 1024 bytes.

**Failure scenario:** a legacy static-grant project with a 129-character ASCII ID has valid read/write authority and a database row. A capability handler implementing D1 can return both write=true and retained=true. The runner then submits to a route that retained routing does not recognize; a lost comparison response retried after the transient 24-hour record expires creates another comparison despite the advertised guarantee.

**Minimum fix:** define one exact supported guided-target grammar, including canonical project and UUID route IDs, shared by preflight, capability response, route generation, retained execution/lookup/close, and SDK handoff parsing. The smallest change is to reject/mark unsupported out-of-grammar guided projects before any lifecycle write while preserving explicit legacy raw-client behavior. Alternatively make retained routing support those identifiers consistently. Do not let a deployment-wide true flag mask per-target ineligibility.

**Acceptance addition:** capability/preflight for long, Unicode, dot, encoded-separator and noncanonical ID targets cannot report retained-ready while writes fall back to transient dedup. Supported IDs preserve original comparison identity beyond 24 hours through marked and unmarked replay.

## PR-3 — Request-size limits need a separate response/recovery-envelope budget

**Blocking contract gap.** Section 5 (D1 line 197) permits a report request up to 2 MiB and says maximum report size is checked against the service request cap. Sections 6 and 11 then require both languages to recover it through comparison and operation-result responses. The response is larger than the request, and the operation lookup wraps the whole result again.

**Current evidence:** `src/improvement.rs:169–181` adds comparison ID, completeness, submitter and creation time to the submitted report. `src/commands.rs:409–410` wraps that comparison in an operation object with operation/path/fingerprint fields. Python caps every non-payload JSON response at 2 MiB (`python/acclimate/client.py:112–119`), while current TypeScript non-payload JSON responses are unbounded (`packages/sdk/src/client.ts:230–234`). Merely extracting the current transport does not establish parity.

**Failure scenario:** a valid serialized comparison report fits just below 2 MiB, commits, and loses its response. The Python client rejects the larger create/get/operation envelope every time. The app has durable evidence and a retained original ID but cannot recover it through the supported client; a payload admitted by the defined contract cannot complete.

**Minimum fix:** freeze distinct bounded request, ordinary JSON response and retained-operation-envelope limits for the new evaluator transport, or reserve sufficient request headroom for all response metadata. Account for maximum bounded principal/route/ID sizes. Keep raw bundle download limits separate. Apply the same observable limits in both runtimes without making TypeScript unbounded or silently weakening existing low-level behavior.

**Acceptance addition:** maximum admitted report fixtures succeed through create, GET comparison and operation lookup/recovery in TS and Python; a response exceeding the declared envelope cap fails with a safe error and retains report/keys without callbacks. Exact-boundary tests cover the metadata wrapper, not only request bytes.

## Nonblocking advice

- Define the interrupt command's private intent storage separately from the long-held evaluation lock. Otherwise a convenient implementation might block a headless interrupt while the run owns its journal. The command must not edit an active runner's attempt state.
- Keep the explicit legacy `not_observed` refusal. It correctly avoids treating an expired transient receipt as proof no comparison was ever committed. Existing close machinery can preserve a known legacy commit atomically; it must never be used to infer that unknown past effects did not occur.
- Keep scalar export authenticity narrowly stated. Online matching of a sanitized projection binds scalar evidence; it does not attest redacted model-output contents. The plan currently preserves this distinction well.

## What is sound

The selected installed-app seam, exact saved-body replay, existing retained operation/fence extension, effective authorization rechecks, marker-before-callback ordering, foreign-runtime refusal, explicit uncertain-execution exception, nonexecuting capability checks, and no automatic rerun/promotion are coherent foundations. These three blockers require concrete contract/acceptance additions, not a replacement architecture.

I can ratify after reviewing a revised exact digest that resolves PR-1 through PR-3. I have not approved D1.
