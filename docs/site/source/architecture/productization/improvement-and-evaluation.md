# Improvement and evaluation

**Implemented as an operator workflow.** Connect existing proposals, versions, comparisons and promotions. The application runs and grades its own agent; the operator reviews the evidence and chooses a release.

The current boundaries are in [the improvement design](../../design/improvement.md), [service](../../../src/improvement.rs), [compare helper](../../../packages/sdk/src/compare.ts) and [app-owned example](../../../examples/service-proposer/workflow.ts). The [release console](../../../apps/console/src/components/bundle-releases.tsx) has history and rollback, not this workflow.

```text
save a draft or request a proposal → choose an immutable candidate
app: fetch both versions → run paired fixtures → grade → submit comparison
console: show diff + evidence → operator publishes the reviewed snapshot
```

## Propose and choose

Start from the selected project, bundle, channel and published version/revision. Show the pinned parent, editable paths, hypothesis and authorized evidence. Existing proposal POST/GET routes return queued, running, succeeded or failed state, attempts, rationale, errors and candidate. Poll with backoff; add scoped listing so refresh can recover a request. Keep cancellation out of the UI until its actual semantics exist.

**Provider disclosure:** the current proposer sends the whole selected parent bundle and supplied evidence to the operator-configured provider. `allowedPaths` restricts edits, not reading. This matches the original bundle-level design. The form must state that scope and require authorization to share that bundle, including reusable memory. Do not promise file-level privacy. If that becomes a requirement, filter disclosed files and reconstruct the candidate server-side; it is a separate product change, not a prerequisite patch protocol. Private session memory remains app-owned.

The worker saves a validated immutable candidate; it does not run or grade the app and never publishes automatically. Show provider failures. An operator selects the exact candidate after reviewing its verified digest, parent, rationale and file diff. Native preparation must also check compatibility; generic bundle validation is insufficient.

## Keep evidence fixed

The compare helper now captures report version IDs/digests, dataset revision, runtime settings and grader revision before asynchronous callbacks. Later caller mutations cannot relabel an executed comparison.

It also keeps a canonical output isolated from graders and passes a fresh clone to every attempt. Outputs must be structured-cloneable data; an uncloneable output records a grading failure without rerunning execution. In-process retries do not imply durable storage or cross-process recovery.

Both fixes have [model-free regression tests](../../../packages/sdk/tests/compare/compare.test.ts). They need no server profile registry, downloadable manifest or output-index service.

## Request and run evaluation

The first console handoff is a small durable request: parent/candidate IDs and digests, dataset revision, expected cases/repetitions, runtime/model settings, grader revision, requester, state, attempt and optional comparison ID. Record the app's declared limits and configuration ID/digest where useful. Freeze those fields at creation. They describe intended execution; the service cannot certify an external host's behavior.

Ship one app-owned fixture command by adapting [the existing workflow](../../../examples/service-proposer/workflow.ts). It reads private service configuration, fetches the request, verifies both version digests and parentage, and uses locally installed fixtures, execution and grading functions. Document its exact invocation with a request ID. Do not put credentials in the copied command, download code from a request or follow arbitrary fixture URLs. This runnable example is required with the evaluation UI; a universal runner and server-side profile registration are not.

Under the bundle, add request create/list/detail plus `POST /{id}/start`, `/finish` and `/interrupt`. Start binds the authenticated evaluator principal and a caller-generated attempt ID. Finish checks that same principal, attempt and current scoped permission; require the linked comparison to have that submitter too. Match its version identities, declared dataset/runtime/grader fields and expected inventory to the stored request. A request ID in evidence identifies the association; no exact-byte manifest protocol is required.

```text
requested → running → completed | failed
requested or running → interrupted (terminal)
```

Start, finish and interrupt use conditional database transitions. Both requested and running can be interrupted; an interrupted request cannot later start or finish. Same-attempt replay is safe; another attempt conflicts. `completed` means a matching complete comparison exists, not that the candidate won. `failed` can retain partial evidence. A crashed evaluator stays at its last reported state; show that current execution is unknown. Interruption changes metadata and does not stop remote work or undo charges. Retry uses a new linked request. No leases, automatic reassignment or dispatcher.

The app gives both versions the same fixture snapshots, settings and repetitions, enforces limits, prevents live writes and supplies `execute`/`grade` to `compare`. Keep task failures, infrastructure failures, missing grades and unknown cost distinct. Completing an evaluation requires its exact request and attempt IDs on the comparison. Standalone comparison reports remain available for inspection and direct promotion.

For durable regrading, the app saves immutable outputs with case/repetition, version identity and a content digest, then verifies bytes before reuse. This is app responsibility and is separate from in-process grade retries. Changed grading rules create new evidence. Acclimate stores the report, not a second immutable output index. In v1, render output references as bounded escaped text; defer clickable links, remote fetching and preview resolvers.

Use existing project grants within the trusted app boundary: read for inspection, propose for proposals, write for requests/comparisons and promote for release. Evaluators never need promote. Existing write permission is broad; add a narrower right before granting evaluator access outside that trusted boundary. Console credentials stay server-side; app credentials and fixtures stay with the app.

## Review and release

Show the verified diff, declared settings, paired outcomes, sample count, failures, missing grades and known/unknown costs. Missing data never becomes zero. Incomplete evidence is not a win; complete evidence alone is not statistical proof.

For example, evaluate one saved retry-review edit against its published base using two fixtures with two repetitions: four pairs. If one judge fails, show three scored pairs, one missing grade and any unknown cost. Regrade the same captured output without claiming improvement or savings prematurely.

Evidence-backed release binds candidate and comparison IDs/digests, the candidate's parent and the current channel revision. Existing promotion checks already enforce that identity. A saved draft uses its publication command with the expected generation, so draft state and release commit together. If another draft save or channel release intervenes, reject mismatched evidence and require a fresh review. New service proposals branch from the published base; they do not silently branch from an unpublished draft.

Manual seeds, edits and rollbacks require an explicit unevaluated reason. Record the decision and previous version in history. Publishing affects future resolutions; pinned workspaces stay pinned.

## Build and check

1. **SDK — complete:** frozen report identities and isolated grade retries, covered by mutation regression tests.
2. **Service/app:** add conditional request records and the runnable fixture adapter. Test settings mismatch, another evaluator, interruption before start, crashes, conflicting attempts, late completion and grade retry without execution.
3. **Console:** proposal polling/recovery, verified candidate diff, request handoff, evidence display and explicit release. Test incomplete reports, unknown cost, stale generation/revision/parent and manual reasons.
4. **Integration:** run the exact reopened-draft path in [acceptance](acceptance.md), then the separate proposal path. Use existing same-key retries and result reconciliation for the recovery guarantees each command promises.

Defer profile registries, manifest distribution, service output indexes, automatic acceptance, multi-candidate search, hosted execution and a campaign scheduler. Apps own execution and grading; Acclimate owns content, evidence records and atomic release.
