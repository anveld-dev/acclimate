# Native repository starter qualification

This ledger distinguishes deterministic wiring from actual provider/session behavior. New live claims require separately authorized qualification; default implementation tests make no paid calls.

| Check | Codex | Claude | Pi | Cursor |
| --- | --- | --- | --- | --- |
| Public installed preparation imports | Passed offline | Passed offline | Passed offline | Passed offline |
| Source + instructions + selected-memory fixture | Passed fake task | Passed fake task | Passed fake task | Passed fake task |
| Native option/loader interface | Passed offline options | Passed offline options | Passed offline loader | Passed offline options |
| Durable job locator/process-loss fixture | Shared fake-process tests passed | Shared fake-process tests passed | Shared fake-process tests passed | Shared fake-process tests passed |
| Real fresh-session source task and output retention | Unrun | Unrun | Unrun | Unrun |
| Real cancellation/termination guarantee | Unrun | Unrun | Unrun | Unrun |
| Live behavioral improvement | Unrun | Unrun | Unrun | Unrun |
| Resumed session/in-place refresh | Unsupported by this recipe | Unsupported by this recipe | Unsupported by this recipe | Unsupported by this recipe |

Historical Codex marker checks in the main native guide belong to their dated resource-only fixtures; they do not qualify this repository starter. Passing a fake task proves the declared resources were supplied to the fake callback, not that a model discovered a skill or consumed all content.

On 2026-11-16, `node --test examples/native-repository/test/*.test.mjs` passed **20 tests** against the locally built public package exports. Coverage includes all four installed plugin preparations, native options/actual Pi resource loader, source/patch/memory lifetime rules, uncertain-work quarantine, and four separate child-process SIGKILL points (launch intent, accepted handle, retention error, and retained results before cleanup). The owned fake process is reaped before an explicit post-stop cleanup test; no PID-age inference is used. No model/provider session, paid call, deployment or real SDK termination was exercised.

The suite's installed imports use the current local build, not a registry publication. Packaging separately validates extracted release artifacts. Product-wide G14/G21 also depend on the evaluator module's callback/lock/report tests and cannot be claimed from this directory alone.

The 2026-11-17 installation correction adds a private dependency-free manifest, explicit npm prefix/workspace controls and a public-import boundary check. `scripts/packaging/native-starter-install.test.mjs` installs checksummed existing release tarballs into both an external extracted starter and one nested beneath an enclosing npm workspace. It verifies five public imports, preserves the enclosing manifest/lockfile/node_modules, runs the deterministic repository job and rejects a checkout symlink. Set `ACCLIMATE_NATIVE_RELEASE_ROOT` to an existing verified release to run both installation cases; without it they are explicitly skipped. No release rebuild or provider call is part of that test. `test/codex-policy.test.mjs` checks the explicit environment/model boundary and copied SDK policy inputs; it does not prove that every CLI host configuration source is isolated.

On 2026-11-17, the same command passed **22 tests** against existing locally built public exports. Added coverage kills the worker after the owned tree is deleted but before completion is saved, then finishes cleanup from its durable deletion intent. A missing quarantined root without that intent is rejected even after explicit termination verification. The separate `node_modules/.bin/tsx --test scripts/native-session-lifetime.test.ts` passed **2 tests**. These checks remain offline wiring/lifetime evidence; provider termination gates above remain unrun.
