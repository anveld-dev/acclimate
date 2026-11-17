# Recovery and parity implementation audit

Reviewed the shared working tree on 2026-11-16 against PLAN.md D2 and IMPLEMENTATION.md. Scope: installed TS/Python evaluation cores and private journals, evaluation transport/client changes, legacy adapter, and headless CLI intents. No implementation files changed. Line numbers below describe the reviewed state and may move during integration.

The initial review found five material issues, described below as historical findings. All five and a subsequent root finding about mutable callback results are resolved in the repair rechecks recorded below. Findings were sent to root as discovered. Deterministic repros used existing in-memory service fixtures and fresh private temporary directories; no live providers or external mutations ran.

## 1. P1 — Cancellation during the lifecycle read still starts the next callback

Sources: `packages/sdk/src/evaluation/runner.ts:473`, `:477`, `:513`, `:585`, `:589`, `:591`; `python/acclimate/evaluation.py:449`, `:452`, `:459`, `:489`, `:493`, `:495`. TS ownership check is also only before the GET at `runner.ts:421`–`:422`.

Both loops test cancellation, perform an authoritative lifecycle GET, then invoke execute/grade without checking cancellation again. The GET can take seconds. TS additionally awaits job-directory creation and binding writes before execute. An abort received during any of these awaits starts a new callback after the cancellation was observed by the signal/event. The analogous TS lock-helper death aborts journal.signal, but `check()` does not reassert ownership after its await and the callback can still begin.

Reproduced in TS by aborting the provided AbortController inside the fourth getEvaluation (the first pre-execute GET). Result: `executions: 1, status: failed`. Reproduced in Python by setting cancel_event inside the fifth get_evaluation (preflight adds one GET). Result: `started_after_cancel: ['parent'], status: failed`. These should both perform zero execute callbacks.

Minimum fix: reassert TS ownership after awaited reads and immediately before callbacks; recheck cancellation immediately before every execute/grade invocation, after all preparation awaits, recording the appropriate unstarted/missing outcome without invoking the callback. Preserve full-inventory incomplete-report behavior.

Missing meaningful test: hold the pre-execute/pre-grade GET pending, cancel while pending, release it, assert zero subsequent callbacks. Separately kill the real TS lock helper during that wait and assert no new callback/submission.

## 2. P1 — Confirmed interruption is discarded and the fallback read bypasses safe errors

Sources: `packages/sdk/src/evaluation/runner.ts:424` and the `request.interrupted` catch around `:721`–`:730`.

`check()` receives and validates an authoritative interrupted request, then throws a category without retaining the snapshot. The catch issues another GET and returns its response without validating its identity/frozen binding or even its interrupted status. An outage on that redundant read throws directly from inside the catch, bypassing the normal safe diagnostic conversion.

Deterministic repro: make pre-execute GET #4 return interrupted, then make GET #5 throw `TypeError('private transport detail')`. No callback ran, but the direct runner rejected with a raw TypeError carrying that exact private message (`safeTypedError: false`) instead of returning the already-confirmed interruption. The Python `_Interrupted(latest)` implementation already retains the checked snapshot.

Minimum fix: carry the validated interrupted snapshot through a private sentinel and return it. Ensure any exceptional handling/cleanup still uses safe public errors.

Missing meaningful test: interruption becomes authoritative immediately after start or between callbacks, then every following GET fails; runner must return the checked interrupted snapshot and invoke no further callback/submit/finish.

## 3. P2 — TS crash after comparison-ID persistence permanently breaks selected export

Sources: `packages/sdk/src/evaluation/runner.ts:690`–`:696`; downstream rejection at `packages/sdk/src/evaluation/artifacts.ts:578`.

The comparison ID is saved to attempt.json before being saved to artifact-index.json. A crash between those writes leaves a legitimate index without comparisonId. On retry, the `if (!state.comparisonId)` guard skips the entire index update. The runner finishes successfully, but selected export rejects the retained index's comparison binding forever. Terminal return also does not reconcile this index.

Reproduced by restoring the exact reachable post-crash state: saved comparisonId in the journal, running authoritative request, index missing comparisonId. Retry returned completed with the original comparison ID and no additional execution; index.comparisonId remained absent.

Minimum fix: reconcile the index's confirmed comparison binding outside the submission guard, including already-terminal recovery, after validating its existing request/attempt/report bindings. Do not overwrite a conflicting existing comparison ID.

Missing meaningful test: inject failure between the journal and index writes, retry, then complete a required selected output/explanation export and verify it.

## 4. P2 — Python crash after report sealing leaves an unrecoverable empty index hash

Sources: `python/acclimate/evaluation.py:524`–`:528` and `:538`–`:541`.

Python saves the sealed report/body into the journal before storing its hash in the index. A crash after journal.save(state) but before save_artifact_index leaves a valid sealed report and index.reportSha256=''. Recovery skips execution and never repairs that hash; it only repairs comparisonId. Evaluation completes, but selected export rejects the index.

Reproduced using the lost-submit fixture, restoring index.reportSha256 to the empty value present before sealing, then retrying. Result: completed with the original comparison ID, while reportSha256 remained ''.

Minimum fix: order sealing so the report-hash index write precedes the sealed-report journal commit, or conservatively reconcile the missing hash from validated saved bytes and existing bindings during recovery. Reject conflicting nonempty hashes.

Missing meaningful test: fail precisely between sealed journal and index-hash persistence, retry without callbacks, and successfully export required selected content.

## 5. P2 — TS array accessors/custom serializers bypass captured JSON validation

Source: `packages/sdk/src/evaluation/definition.ts:29`–`:52`.

The array path reads elements directly and ignores extra string properties/descriptors and its prototype. Thus accessors execute during validation and custom toJSON is accepted/invoked. structuredClone later re-reads accessors, so captured values can differ from the values admitted by validation and its size budget.

Deterministic repro: define case.input as an array whose index-0 getter returns null on its first two reads and Date(0) on its third. defineEvaluation succeeds; getterCalls=3 and the captured input contains a Date. A nonenumerable array.toJSON is also accepted and invoked by assertJson. Python rejects such exotic values.

Minimum fix: validate array own property descriptors without invoking accessors, allow only ordinary index data properties plus the built-in length, and reject custom serializers/prototypes. The captured clone must retain the same validated JSON value.

Missing meaningful test: array element accessors never execute during define; extra array toJSON/custom prototype/symbol/nonenumerable properties are rejected; no invalid value can appear only at cloning time.

## Reviewed without a material finding

The normal marker-without-report branch refuses reruns; saved retained submissions use the original exact body and key; legacy reports without retained state require a matching committed operation fingerprint before adoption; interrupted request checks stop the normal schedule; Python rejects direct/nested future/awaitable return values before ordinary result classification; CLI creation intents preserve the original draft/request keys and baseline and recover committed creation before channel drift checks. These conclusions are source review of those paths, not qualification of all G01–G22 gates.

## Repair recheck — clear

Rechecked the TS and Python repairs on 2026-11-16. No unresolved material finding remains from this audit.

- Both cores recheck cancellation and ownership after authoritative reads and immediately before callbacks, after job/input preparation. TS also reasserts lock ownership after its awaited GET.
- TS carries a validated interrupted snapshot in a private ObservedInterruption sentinel and returns it without the failing redundant GET.
- TS reconciles a missing index hash/comparison binding outside the submit guard and during terminal recovery, while rejecting conflicting existing bindings. Python repairs a blank report hash from validated saved body bytes during sealed-report and terminal recovery, while rejecting conflicting nonempty hashes.
- TS validates array own descriptors, ordinary prototype and exact indexed keys before reading values, and rejects proxies/accessors/custom serializers.

Focused TS recheck command: `node --import tsx --test --test-name-pattern='JSON validation rejects array|cancellation observed during|lock helper loss during|observed interruption returns|comparison/index crash window' packages/sdk/tests/evaluation/core.test.ts`. Result: 6 passed, 0 failed, including actual helper SIGKILL during the authoritative GET.

Focused Python recheck used Python 3.12 and `PYTHONPATH=python:python/tests` to run these EvaluationCoreTests: `test_report_seal_crash_repairs_blank_index_hash_without_callbacks`, `test_cancellation_during_authoritative_reads_never_starts_next_callback`, and `test_cancellation_after_job_record_write_never_starts_executor`. Result: 3 passed, 0 failed.

This clears the reported recovery defects; it does not establish every release qualification gate or live provider behavior.

## Additional root finding — callback result mutation during I/O (resolved)

P1, TS runner: after execute settles, the implementation serializes its output to a private artifact but later re-reads application-owned execution.output following artifact/index/lifecycle awaits to construct the grade input. App code retaining its returned object can mutate that object during I/O, causing the saved output and graded output to differ. Execution status, reference and usage are likewise read after artifact awaits. The grade result's reward is re-read following optional explanation writes, creating the same mismatch between validation and report sealing.

Required repair: immediately capture a module-owned output clone and allowed execution metadata before any await, then use that captured output for both artifact and grading. Capture validated grade reward and explanation before explanation I/O. A meaningful regression mutates the application-retained results while filesystem/lifecycle work is pending, then verifies artifact content, grade input and final reported scalar remain equal to their values captured at settlement. Root reported this finding and requested this focused recheck.

Repair recheck: clear. Inspected `runner.ts:563`–`:571` and `:636`–`:643`: output/explanation are validated and cloned, execution status/reference/usage and grade reward are captured before persistence awaits. All subsequent artifact/grade/report construction uses captured values; no application result fields are re-read afterward. Ran `node --import tsx --test --test-name-pattern='callback result output' packages/sdk/tests/evaluation/core.test.ts`: 1 passed, 0 failed. Its timer mutations actually ran four times and the test verifies original saved outputs/explanations, grading inputs, status/reference/usage and reported rewards. No unresolved material finding remains from the requested recheck.

## Final acceptance-evidence recheck

Reviewed IMPLEMENTATION-RESULTS.md G01–G11 claims against the implementation, installed qualification record and relevant tests. Rehashed all 144 SOURCE inventory entries: no mismatches. The report's scoped source/evidence claims remain clear; its runtime/provider/deployment limits remain necessary.

Three initially missing direct acceptance cases now have meaningful focused coverage:

- TS core serves an actual gzip HTTP success response whose compressed body is below 4 MiB but decoded JSON exceeds 4 MiB, after retaining the original committed comparison. The public runner rejects it as response_too_large with report_saved, then reuses identical body/key and the original comparison ID without execute/grade calls. Python core performs the equivalent actual HTTP over-budget response/recovery with exact saved body/key/attempt and unchanged callback event trace.
- TS CLI loses every comparison-submit response through transport retry exhaustion and asserts exit 3/report_saved, then exact retained retry to exit 0 without callbacks or identity changes. Python CLI independently exercises committed comparison submission followed by an actual >4 MiB HTTP response, exit 3/report_saved, then identical body/key/fingerprint/attempt/comparison recovery to exit 0 with no new execution. The Python core test independently asserts unchanged execute and grade counts for this recovery path.
- Both CLI suites now check running and interrupted authoritative requests without terminal comparison evidence: read-only check returns exit 3, indeterminate/evidence.not_terminal, with zero callbacks or comparison creation. Requested-state coverage also remains present. Running/started-interrupted fixtures have canonical attempt/principal bindings.

Direct focused reruns passed: 4 TS tests covering decoded oversize, uncertain-submit CLI and both lifecycle checks; 1 Python core HTTP-oversize recovery test; 2 Python CLI tests covering HTTP-oversize recovery and all three nonterminal lifecycle states. No product-source edits were needed for these acceptance additions. No unresolved material findings remain from this audit or its evidence rechecks.
