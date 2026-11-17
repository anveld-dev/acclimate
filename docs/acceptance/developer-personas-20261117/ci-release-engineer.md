# CI and release engineer acceptance

Personal criteria defined before live execution, 2026-11-17:

1. I can extract the distributed CI archive from the verified release, install the released SDK, and run application-owned headless candidate/request/run/check/export against a disposable real service.
2. A passing complete candidate exits zero, a concrete losing candidate exits nonzero, and incomplete evidence exits nonzero. Required export failures also keep CI red.
3. CI never changes the channel. I can inspect saved bound evidence, explicitly promote under fixture-owned operator authority, reject a stale revision, pin an old session, and roll back without changing that pin.
4. Retained downloaded evidence verifies under an independent read-only reader after worker journals are removed; exported files contain no fixture credentials.
5. I can replay this CI intent after committed response loss with transient idempotency expired beyond 24 hours, retaining the same saved request/comparison without duplicate execution.

This assessment uses private fixture credentials and no paid/model/provider calls, production mutation, build, commit, or push.

Acceptance result: **accept for the exercised model-free CI and release workflow**. The criteria above were recorded before execution. The actual archived `ci.sh`, extracted from the verified 0.1.0 release, used the released JavaScript SDK against an isolated real Rust/PostgreSQL service. This supersedes the original source-only review for the scenarios below. No product code was changed.

| Evidence ID | Actual result |
| --- | --- |
| CI-PASS-REPLAY | Candidate mean 1 versus baseline 0.5; policy pass and shell exit 0. The same CI intent replayed with byte-identical handoff and identical comparison. Execution callbacks stayed at four. |
| CI-LOSING | Concrete bad retry-key candidate compared against a separately seeded known-good baseline: mean 0.5 versus 1, improvement −0.5; completed saved evaluation, policy fail, shell exit 2. |
| CI-INCOMPLETE | Concrete candidate triggers a controlled application executor failure: request failed, CI shell exit 2; explicit `check` returns indeterminate and exit 3. Required selected export also fails. |
| CI-EXPORT-FAILURE | Passing evaluation and quality policy, but the application's review mapper declines a required artifact: shell exit 3 and zero committed export manifests. |
| NO-AUTOPROMOTION | Across the CI jobs, the stable channel stayed at revision 1 and its initial version. |
| RELEASE-ROLLBACK | Inspected immutable version digests and complete request-bound comparison, then explicitly promoted under owned operator authority: revisions 1 → 2. Evaluator promotion denied 403; stale revision rejected 409 with `revision_conflict`. Explicit rollback advances to revision 3. An installed-SDK old version pin retained its original ID/digest before promotion, after promotion, and after rollback. |
| DOWNLOADED-REVIEW | Copied a committed selected export and handoff, removed all terminal fixture worker journals, then verified through distinct principal `viewer` with read rights. Verification returned `online_scalar_binding`, did not recreate journals, and explicitly reported `executionAttested: false`. Export files passed fixture credential canary and private journal-path checks. |

The first actual CI pipeline also lost committed draft, request, start, submit, and finish responses through a local proxy. The proxy expired transient idempotency records to 25 hours old before dropping each response. The same archived CI script then replayed its saved intent after another expiry, preserving request, comparison, and callback count. This tests durable recovery using the CI entrypoint; 25 hours were simulated in the owned database rather than elapsed on a clock.

The evaluator remains application-owned. The archived shell script and SDK were unchanged; only private extracted application callbacks were extended to count executions, deliberately fail one candidate, and deliberately decline required sharing. Their public configuration/runtime identity was changed before any request. The passing and losing candidates use the starter's real deterministic retry/charge behavior, rather than changing policy thresholds to manufacture failure.

I can now install a release, use its headless CI workflow, preserve failure evidence, and independently inspect a retained artifact without creating release authority in the CI job. CI shell exit 2 covers both a losing policy and a failed run; automation should retain the structured request and `check` verdict to distinguish them. I would adopt this recipe for a fixed private worker root and application-owned quality policy.

Limits: this run exercised JavaScript, local processes, and an immutable SDK version pin. It did not exercise hosted CI, container relocation, native harness session lifetime, live provider quality, or the three cancellation timing boundaries from the original review. It does not establish all original diagnostic acceptance categories. The existing service binary was hashed; its compilation is not attested by the release source inventory. The private service stopped and disposable database directory was removed after the run.

The [machine-readable evidence](ci-release-engineer.json) records request/comparison IDs, verdict scalars, revisions, and artifact/service hashes. Reproduce with Python 3.11+:

```sh
python3.11 scripts/acceptance/dx_personas/ci_release_engineer.py --output artifacts/dx-personas-20261117/ci-release-engineer --report docs/acceptance/developer-personas-20261117/ci-release-engineer.json
```

Private consumer logs/configs are retained only beneath the ignored acceptance artifact directory. Early acceptance-script attempts corrected expected run exit categories and response field names; the reported results come from the subsequent complete successful run.
