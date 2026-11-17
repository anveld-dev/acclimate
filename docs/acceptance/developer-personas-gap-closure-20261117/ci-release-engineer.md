# CI and release engineer gap-closure retest

Independent acceptance criteria frozen before execution on 2026-11-17:

1. Extract the verified fresh distributed CI archive and install its released SDK outside the checkout, with package-byte provenance.
2. Exercise the actual archived `ci.sh`: complete pass exits 0, genuine regression exits 2, incomplete run exits 2 with explicit check exit 3, and missing required export exits 3.
3. Confirm CI leaves the channel unchanged; inspect bound immutable evidence and explicitly promote under operator authority. Evaluator promotion must return 403, stale revision 409, and an old immutable SDK pin must survive promotion and rollback.
4. Copy the committed review export and handoff into a separately installed reader project, remove worker journals, and verify under distinct project-read authority. Export bytes must contain neither fixture credentials nor the private journal path.
5. Lose all five actual committed draft/request/start/submit/finish responses after simulating transient idempotency expiry beyond 24 hours. Replay the same intent without changing request/comparison identity or executing callbacks again.
6. Run the newly distributed optional analysis recipe against authoritative saved evidence and an independently retained binding. This deterministic fixture must remain descriptive, without an interval or automatic confidence gate.

These criteria were sent to the coordinator before the fresh-release GO. Historical acceptance reports remain unchanged. The driver requires explicit fresh release and source fingerprint settings.

Result: **accept for the exercised model-free CI and release workflow**. The actual archived `ci.sh` from the fresh `0.1.0` release ran against a disposable real Rust/PostgreSQL service. Consumer processes imported the installed package; both the CI app and separate reader verified all 94 installed SDK files against the release tarball. Their SDK content hashes matched. The private extracted app alone was instrumented to count executions, trigger a controlled infrastructure failure, and decline a required review artifact; its public configuration/runtime identity changed before execution. The archived shell and installed SDK bytes were unchanged.

| Evidence | Actual result |
| --- | --- |
| CI-PASS-REPLAY | Shell exits 0 and replay exits 0. Candidate mean 1 versus parent 0.5. Request `4f053c70-522a-4287-a398-9bb8458a2501`, comparison `20237c7a-ba64-4657-8ea5-7ea02f3968fb`; handoff bytes and both IDs stayed fixed. All five committed response phases were dropped after simulated 25-hour transient expiry; execution callbacks stayed 4 → 4. |
| CI-LOSING | Genuine baseline retry-key behavior regressed against a separately seeded known-good parent: candidate 0.5 versus parent 1, improvement −0.5. Completed saved evaluation; policy fail and shell exit 2. |
| CI-INCOMPLETE | Controlled private executor failure produced a failed saved request, shell exit 2, explicit `check` exit 3 and `evidence.incomplete`. |
| CI-EXPORT-FAILURE | Complete passing evaluation but required app review mapping unavailable: shell exit 3, zero committed manifests. |
| NO-AUTOPROMOTION | CI jobs left the initial stable channel at revision 1. |
| RELEASE-ROLLBACK | Operator explicitly promoted inspected bound candidate `ec3e3ae8-77a3-4c21-a7f8-31d8b4d542ef`; revisions 1 → 2. Evaluator promotion returned 403/`denied`; stale promotion returned 409/`revision_conflict`. Explicit rollback advanced revision 3. The installed SDK's pin to parent `95a0f433-2ed6-4b81-af37-3d62ec7ff0cf` kept the same digest throughout. |
| DOWNLOADED-REVIEW | Copied selected export and handoff verified from a separately installed reader project under principal `viewer` with project `read` rights after worker journals were deleted. Exit 0, `online_scalar_binding`, `executionAttested: false`; no journals recreated, fixture credentials or private journal path found in export bytes. |
| OPTIONAL-DESCRIPTIVE-ANALYSIS | Archived `evaluation/analyze.mjs` used the installed analysis export with authoritative comparison, installed app descriptor, and retained trusted request/attempt binding. Exit 0; equal-case improvement +0.5, `descriptive`, `uncertainty.not_requested`, null interval and no execution attestation. The archive also contained `ANALYSIS.md` and `analyze.py`; the Python program was not executed by this persona. |

The copied review manifest SHA256 is `bc0448db2c0515dc398e38884e59013feca0fe736448dbc45f2bbc8102629713`. The CI archive SHA256 is `f92218758dfd4eabc47c706e81d0d18a8920701271655b4b1915867877ef2368`; source inventory SHA256 is `63b0bc9a1751a7b5bf9e230e7bde81f0801ea7d4946171d628449c575cc6cfbd`; service binary SHA256 is `c84d1961249e635c024346fb23328dccf738f0aa7eef0e5e50fa4b00111d2a50`. The [machine-readable proof](ci-release-engineer.json) retains full request/comparison/dropped-response IDs, exact verdicts, revisions, archive/installed-content/recipe hashes, and cleanup flags.

The optional CI artifact recipe is to save the authoritative comparison, final descriptor, independently retained binding, explicit analysis configuration if any, and `analyze.mjs` JSON output together under application access controls. Use the distributed `ANALYSIS.md` invocation after the ordinary CI job; retain the policy verdict separately. Only explicitly selected, reviewed analysis inputs should travel to reviewers. Analysis exit 0 means valid analysis output and can also accompany indeterminate metrics; it grants no quality or release approval. This deterministic two-case fixture used no stochastic protocol and cannot establish model-quality confidence. The existing selected review export remains the tested handoff for case output evidence.

This independently accepts C1–C6 within their stated scope; it does not close every finding in the original source review. Hosted CI, physical machine transfer, native harness session lifetime, cancellation timing boundaries and the original full diagnostic matrix were not exercised. Transient expiry was simulated in the owned database rather than waiting 25 hours. The service binary was hashed without binary-to-source build attestation. These are workflow limits, with no blocker in the exercised criteria.

The service stopped and its disposable database directory was removed. Private logs/configs remain only below `/private/tmp/acclimate-ci-gap-retest-20261117`. No provider/model calls, production changes, builds, commits or pushes were performed by this persona.

Reproduce with Python 3.11+ and the verified fresh release:

```sh
ACCLIMATE_PERSONA_RELEASE=/private/tmp/acclimate-dx-release-20261117-gaps-1 \
ACCLIMATE_PERSONA_SOURCE_SHA256=63b0bc9a1751a7b5bf9e230e7bde81f0801ea7d4946171d628449c575cc6cfbd \
python3.12 scripts/acceptance/dx_personas/ci_release_engineer.py
```
