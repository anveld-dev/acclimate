# Final design consensus

**Status: finalized and approved for implementation planning.**

Date: 2026-11-16. The first batch comprised eight design agents. The second batch comprised seven new, independent critique agents. The coordinator integrated the proposals, resolved objections, and requested explicit exact-revision rechecks. No majority vote or assumed approval was used.

## Frozen design

[PLAN.md](PLAN.md), revision D2, SHA-256:

```text
9bd400d28d8e07f1906273dd7ead095c9add3f273e5e33adc5045fe9e23462e1
```

PLAN.md is the normative design. Proposals contain considered alternatives, not additional requirements. Material changes to the plan require renewed review; this consensus is tied to these exact bytes. This ledger is intentionally separate so recording signatures does not change the approved plan digest.

## Council sign-offs

Every critique reviewer explicitly approved the same D2 digest and reported no unresolved blocking objection in their remit.

| Reviewer | D1 blocking findings | D2 disposition | Exact-revision record |
| --- | --- | --- | --- |
| Protocol/recovery/security | PR-1, PR-2, PR-3 | APPROVE; all resolved | [Protocol](reviews/protocol-r2.md) |
| TypeScript installed-app interface | TS-1, TS-2, TS-3 | APPROVE; all resolved | [TypeScript](reviews/typescript-r2.md) |
| Python/cross-language | PY-1, PY-2 | APPROVE; all resolved | [Python](reviews/python-r2.md) |
| Evaluation validity/CI | EC-1, EC-2 | APPROVE; all resolved | [Evals/CI](reviews/evals-ci-r2.md) |
| Evidence/privacy/handoff | EV-1, EV-2, EV-3 | APPROVE; all resolved | [Evidence](reviews/evidence-r2.md) |
| Adoption/product journey | UX-1 | APPROVE; resolved | [Journey](reviews/journey-r2.md) |
| Native repository/worker operations | NO-1, NO-2 | APPROVE; all resolved | [Native/ops](reviews/native-ops-r2.md) |

Round one withheld approval across all seven perspectives and raised sixteen formal blockers, including overlapping bundle-isolation concerns. D2 incorporated their minimum remedies and cross-workstream acceptance cases. [RESOLUTIONS.md](RESOLUTIONS.md) maps every finding to its remedy and release gates. The linked round-two records accept all sixteen; no blocking item is deferred under another name. Nonblocking implementation advice remains in the individual reports and does not prevent design approval.

## Settled outcome

- An installed evaluator module with three core operations and an app-owned entry point, instead of requiring users to copy the recovery protocol.
- TypeScript and Python in the same acceptance milestone, with paired-input/content isolation, exact serialized replay, conservative cancellation, and explicit foreign-journal refusal.
- A complete interactive and headless path: immutable candidate/request creation, preflight, run, quality check, deliberate review and separately authorized release.
- Separate lifecycle status, descriptive app-owned quality policy, and release authority, with fixed command exit/error behavior.
- Explicitly selected/redacted review artifacts, role-level availability, retained-report binding, and independent read-only scalar verification.
- A native repository recipe with frozen source/context policy, persistent private job locators, confirmed-stop cleanup, and no original-repository mutation.
- Six implementation work packages and twenty-two mandatory release gates, including existing behavior/regression checks.

Dynamic evaluator credential issuance, remote heartbeat storage, per-case resume, statistical inference, hosted evidence storage and in-place native refresh remain explicitly scoped follow-ups. The council accepted those limits; the plan does not claim those critiques' long-term operating costs disappear in this release.

## What was verified here

The coordinator checked the final digest against all seven approval reports and validated document links/whitespace. Reviewers checked current source and design contracts. The eval/CI reviewer also ran standalone numerical vectors in Node/Python to check the proposed reduction semantics; those are design spot checks, not product tests.

No application implementation, package build, service deployment, paid model call, browser workflow, production mutation, promotion or rollback was performed in this design task. The twenty-two release gates remain work for implementation/qualification. Agent agreement is a reviewed-plan outcome, not proof of correctness or measured developer usability.
