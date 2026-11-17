# Independent evidence and operational handoff review — round 2

Disposition: **APPROVE**.

I am satisfied with PLAN.md D2 at exact SHA-256 `9bd400d28d8e07f1906273dd7ead095c9add3f273e5e33adc5045fe9e23462e1`. No unresolved blocking objection remains from this review. Approval applies to this document revision; a material revision requires another check.

This is a design/source review on 2026-11-16, not implementation, privacy qualification, execution attestation, or observed usability research. I verified the plan digest and read the objection resolutions plus revised artifact/command contracts, relevant new execution/context rules, and receipt projection.

## Original findings

| Finding | Disposition | Reason |
| --- | --- | --- |
| EV-1 — independent role availability and required selections | **Accepted/resolved** | Section 9 now specifies exactly one row for each output/explanation role, selected/required flags, separate exported/not_shared/missing/unavailable states, file-presence rules, and no committed complete manifest when any required role is not exported. Scalar-only export reports localInspection:not_requested rather than guessing whether files exist. G13 covers mixed roles and required omissions. |
| EV-2 — supported selection, mapper registration, read-only verification and absent-journal workflow | **Accepted/resolved** | Sections 7/9 now provide data-only `ArtifactSelectionV1`, role-only `ReviewMapper`, static `evaluationMain` registration, `--selection`, and the exact online `verify-export --read-config ... --handoff ...` invocation. ReaderConfigV1 requires only explicit trusted service/project/read token, not evaluator write authority, originating principal or journal. Scalar-only export explicitly avoids journals; nonempty content selections require the original supported journal and cannot silently fall back. G22 tests the second-reader workflow and independently selected trust target. |
| EV-3 — local artifact/report/authoritative comparison binding | **Accepted/resolved** | Section 9 requires originating scope/root/principal/attempt and confirmed comparison match, sealed-body hash validation, structural equality of all comparison report fields, bound index/report identity, and original file length/hash verification before mapper invocation. Corruption/mismatching roles are integrity failures rather than optional missing. The mapper receives only the role value and immutable identity, never callback envelopes, config, journal or expected answers. |
| EV-N1 — unambiguous latest receipt projection | **Accepted/resolved** | Section 13 specifies one retained receipt selected by server `(receivedAt,eventId)` ordering, all stage/version fields from that same receipt, separate application occurredAt/server receivedAt, 30-day retention, and no synthetic consumption claim. G16 includes delayed/out-of-order and mixed-version cases. |

## Integrity and privacy conclusions

- Immutable submitted report bytes and fingerprints remain unchanged when artifacts are shared. Retained-response recovery remains separate from artifact availability.
- Default scalar projection excludes raw error/config/runtime/ref/path/output content. Content release requires explicit selected roles and application redaction; the module does not promise automatic secret detection.
- Local hash/manifest consistency, online scalar/request binding and actual output execution truth are distinct. The online verifier does not manufacture artifact authenticity from matching scalar data.
- Scalar verification cannot derive its trust origin or expected request solely from the downloaded manifest and requires only read authority.
- Missing optional content is visible; required content cannot be silently omitted under a successful complete manifest. Bad hashes/path aliases/report bindings cannot be downgraded to missing.
- Output handling remains bounded, private, non-overwriting and inert. Exports never recursively copy journals or fetch untrusted output URLs.
- New native job locators remain private, bind their own context/source/version, preserve uncertain work and do not become automatic artifact selections. The filtered EffectiveContext rule removes unselected memory from both files and returned metadata before the harness adapter receives it.
- New headless request handling does not convert manifests, task configuration or request data into executable selection, and does not grant a reviewer evaluator or release authority.

## New blockers

None identified within the evidence/privacy/handoff remit. The implementation still must pass G12/G13/G16/G21/G22 and the wider release matrix; this approval is not a substitute for those checks.

## Verification

No product source changed and no models, browsers, external services, dependency installs or runtime tests were used for this recheck. Only this review record was written. The exact D2 digest above is the approved artifact; RESOLUTIONS.md provides supporting history rather than an additional unfrozen contract.
