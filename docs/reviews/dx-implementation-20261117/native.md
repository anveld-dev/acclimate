# Native integration review — 2026-11-17

Reviewed the working tree against HEAD `52c1ce1` and frozen normative plan D2, especially section 12 and the execution-uncertainty rules. Scope: `examples/native-repository/**`, `examples/native-session-lifetime.ts`, `examples/codex-agent.ts`, `examples/service-proposer/evaluation-adapter.ts`, `examples/native-integration.md`, and `scripts/native-session-lifetime.test.ts`. Native plugin and installed Codex SDK implementation were inspected read-only to check lifetime assumptions. No plugin changes or generated builds were needed.

## Fixed finding

**P2 — interrupted cleanup could never finish its durable record.** Both normal cleanup and `cleanupQuarantinedJob` removed the owned workspace before persisting `facts.cleaned`. Process loss or a record-write failure between those operations left a record with `cleaned:false` and an absent workspace. A subsequent authorized recovery always failed `canonicalDirectory(record.cwd)`, so it could not complete cleanup despite confirmed termination. Reproduction: finish retention, remove the prepared root, kill the worker before its cleaned save, then invoke explicit recovery.

The helper now fsyncs a `cleanupIntent` before normal/plugin deletion or authorized recovery deletion. Recovery still requires its termination-verification callback and canonical persistent parent. It validates the ownership marker before first deletion. An already absent direct child can finish only when the durable record proves deletion had previously been authorized and work was confirmed stopped (or never launched). Missing files alone remain insufficient ownership evidence. No callback rerun, age/PID inference, automatic deletion, or provider behavior assumption was added.

Changed files:

- `examples/native-repository/repository-job.mjs`
- `examples/native-repository/test/crash.test.mjs`
- `examples/native-repository/test/fault-worker.mjs`
- `examples/native-repository/test/repository.test.mjs`
- `examples/native-repository/README.md`
- `examples/native-repository/QUALIFICATION.md`

## Validation

- `node --test examples/native-repository/test/*.test.mjs` — **22 passed**, zero failures/skips. Uses existing public built package exports. Includes four installed preparations, native option/Pi loader checks, source immutability and control/path conflicts, selected-memory pruning and metadata filtering, result/patch retention before cleanup, persistent TMPDIR/binding checks, uncertainty quarantine, and five real child-process SIGKILL boundaries. The new deletion boundary actually calls the owned cleanup before notifying/killing the worker; it then verifies explicit recovery saves `cleaned:true`. A negative test removes a quarantined root without cleanup intent and confirms recovery refuses to infer ownership.
- `node_modules/.bin/tsx --test scripts/native-session-lifetime.test.ts` — **2 passed**, zero failures/skips. Verifies files stay alive through callback settlement, unsuccessful execution retains inputs, and raw provider error text is replaced with the safe uncertainty type.

## Limits and unresolved issues

No additional confirmed owned defect remains from this review. Quiescence is still an application adapter assertion: fake callbacks and owned/reaped test processes do not establish real provider/native SDK cancellation or termination guarantees. This review made no model/provider session, paid call, deployment, commit, credential inspection, or generated-dist build. Retained results and job records are local/private; no live qualification or fresh extracted-release packaging claim is implied.
