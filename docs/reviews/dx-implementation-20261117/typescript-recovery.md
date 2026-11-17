# TypeScript evaluator recovery review — 2026-11-17

Reviewed the uncommitted evaluator implementation against HEAD `52c1ce1` and the unchanged approved D2 plan. Read the implementation evidence and wire contract as context, then independently inspected definition capture, serial execution, lifecycle reconciliation, private storage, lock ownership, exact request bodies and legacy recovery.

Six confirmed findings were repaired. Each owned regression failed before its repair.

| Finding | Severity | Reproduction and repair |
| --- | --- | --- |
| Recovery diagnostics discarded durable execution certainty | Medium | An execute/grade callback throws `ExecutionUncertainError`; repeating the command correctly refuses callbacks but previously reported `executionState: not_started`. An initial lifecycle GET failure likewise hid an existing marker/sealed report. Read the journal under ownership before the lifecycle GET and restore `may_have_started`/`report_saved` immediately. Tests cover both callback phases and read failures with marker-only/sealed-report state. |
| JSON object keys escaped Unicode validation | Medium | Private input `{ ['\ud800']: true }`, including nested objects, passed definition validation despite the scalar-Unicode contract. Validate own string property names in the same traversal as values. |
| Invalid output references could produce an unsendable report | Medium | A callback returning `outputRef: 'app:\ud800'` was graded and sealed into a JSON body containing an invalid Unicode escape for the Rust service. Reject lone surrogates as the existing `output_reference_invalid` infrastructure outcome before grading. Tests cover lone high/low surrogates and preserve a valid supplementary Unicode reference. |
| Saved-body reads could return after observed lock loss | Medium | A deterministic file-read hook kills the actual flock helper and waits for its abort signal while reading a saved start body; `readBody` previously returned successfully. Reassert ownership after the awaited read and immediately before start/submit/finish sends. The regression verifies the helper really died and body recovery refuses with `journal.ownership_lost`. |
| Duplicate decoded private JSON fields were silently overwritten | Medium | A journal or artifact index could prefix an identity with a conflicting duplicate and retain the original as its final member; `JSON.parse` discarded the conflict before validation. `readPrivateJson` now rejects duplicate decoded names independently in every object using a syntax-validated lexical scan, without coupling private storage to policy/CLI/artifact modules. Tests cover root/nested/escaped names, quotes and prototype-like keys; valid sibling names remain allowed. Journal recovery refuses before callbacks or POST. The evidence reviewer's artifact integration test confirms duplicate index identity fields refuse before mapper invocation. |
| Missing explicit configuration was classified as unsafe permissions | Low | A nonexistent config file in an existing private parent returned `config.permissions`. Explicit file existence is now checked separately; evaluator and reader configurations return `config.missing`, while an existing unsafe file still returns `config.permissions`. Neither category exposes the filename. |

The analogous Python start/finish body-binding concern was checked independently: TypeScript already compares saved start/finish bytes with the expected frozen attempt/comparison body before sending. Added passing regressions for hash/size-consistent altered attempt IDs in both bodies; each refuses before any mutation. Existing full-runner tests also exercise serial callback order, defensive snapshots, cooperative cancellation, actual process death, interruption, immutable terminal evidence, legacy confirmed/unknown submissions, relocated/foreign journals, committed response loss and decoded HTTP response bounds.

Changed files: `packages/sdk/src/evaluation/definition.ts`, `runner.ts`, `journal.ts`, `private-state.ts`, `config.ts`, `packages/sdk/tests/evaluation/core.test.ts`, `private-state.test.ts`, and this record. No changes to D2, generated distributions or other owners' implementation files.

Validation on Node 26.13.1/POSIX:

```sh
node --import tsx --test packages/sdk/tests/evaluation/core.test.ts packages/sdk/tests/evaluation/private-state.test.ts packages/sdk/tests/evaluation/artifacts.test.ts examples/evaluation/runner.test.ts
# 75 passed; 0 failed/skipped
node node_modules/typescript/bin/tsc --noEmit --project tsconfig.json
# passed
```

No unresolved confirmed findings remain in the reviewed scope. This review did not qualify real power loss, network filesystems, the minimum Node version, paid/live providers, published artifacts or deployed service behavior. The lock-loss regression uses an actual helper process plus a controlled filesystem read hook; it does not claim provider termination or exactly-once external execution.
