# Independent evaluation validity and CI review — round 2

Disposition: **APPROVE**. No unresolved blocking objections remain for this review perspective.

Reviewed PLAN.md D2, SHA-256 `9bd400d28d8e07f1906273dd7ead095c9add3f273e5e33adc5045fe9e23462e1`, together with RESOLUTIONS.md and the relevant current comparison/draft/evaluation implementation. Approval applies to this exact design revision, not future edits, implementation correctness, live behavior, or measured user experience.

## Finding dispositions

| Finding | Disposition | Evidence in D2 |
| --- | --- | --- |
| EC-1 — numerical reduction ambiguity | Accepted/resolved | Section 8, lines 308–312 now specifies sum-then-divide with round64 after each operation, ordered case/repetition traversal, per-case oriented differences before aggregation, separate candidate/parent summary means, explicit cost recurrence, overflow disposition and inclusive comparisons. G11 fixes the required cross-language rounding/overflow tests. |
| EC-2 — check eligibility/authoring classification | Accepted/resolved | Section 8, lines 306 and 314 explicitly classify incompatible required cases as authoring error/exit 1; nonterminal/interrupted missing evidence as indeterminate/exit 3; malformed/wrong-bound evidence as error/exit 1; bound partial evidence as indeterminate; complete policy violations as fail/exit 2; known complete passes as exit 0. Doctor validates authoring without inventing an evidence verdict. |
| EC-N1 — lower-level scheduler differs | Accepted/resolved | Section 3, line 100 gives the complete parent-execute → parent-grade → candidate-execute → candidate-grade trace, requires a dedicated high-level loop or equivalent scheduler, and explicitly says unchanged compare(concurrency:1) is insufficient. G09 asserts the trace. |
| EC-N2 — count/bool/empty-cost schema | Accepted/resolved | Section 8, line 306 requires a nonnegative safe-integer failure count, rejects numeric booleans in Python, and rejects empty cost objects. G11 covers those cases. |
| EC-N3 — fixed-order interpretation | Accepted/resolved | Section 3, line 100 explicitly requires independent fixture resets and disclaims randomized/unbiased experimental interpretation. Statistical inference remains a clearly scoped follow-up. |

## Cross-workstream recheck

- The new headless request command completes the CI adoption path with a durable draft/candidate, retained bound request, frozen private intent and public handoff. Its no-model/no-promotion semantics fit the existing write-authorized createDraft route, whose generation-1 snapshot is a direct child of the checked channel base (`src/drafts.rs:138–169`). Its retry/drift rules preserve evidence identity rather than silently selecting another baseline.
- Execution, policy and release remain separate. A completed loss is still run 0/check 2; incomplete evidence is run 2/check 3. Policy output never changes server completeness or supplies release authority. Existing promotion CAS/parent checks remain required.
- Read-only verification/check support does not claim evaluator write access or rely on the originating worker's journal. The handoff is independently selected against a trusted config; an export cannot select its own trusted service/request merely by changing its manifest.
- New artifact role selection and original-file/report/index checks strengthen review handoff without mutating sealed comparison bytes. An online projection check is correctly described as binding verification, not proof that arbitrary redacted bytes are authentic execution traces.
- Callback isolation now covers VerifiedBundle metadata/payload as well as inputs/outputs. ExecutionUncertainError from either execute or grade escapes ordinary failure classification and stops further callbacks rather than producing misleading complete evidence.
- TS/Python implementation and conformance are in the same acceptance milestone. The exact policy recurrence does not depend on Python's sum/fmean or the console's distinct descriptive mean implementation.
- The 22 acceptance gates cover the important failure/identity/CI cases. Remote progress, dynamic credentials, per-case resume and statistical inference remain visible limitations, not silently claimed features.

## Numerical spot checks

Executed standalone Python and Node calculations for the newly specified recurrence; these validate interpretation of the design, not an Acclimate implementation:

| Ordered values | Both runtimes under the specified recurrence |
| --- | --- |
| [1e308, 1e308] | analysis.nonfinite |
| [1e16, 1, -1e16] | mean 0 |
| [0.5, 0.5] | mean 0.5 |
| [10, 12] | mean 11 |
| [8, 10] | mean 9 |

These agree with the earlier unequal-repetition and lower-is-better vectors. Full policy/CLI fixtures remain mandatory implementation gates; the source/design review does not substitute for running them.

## Approval limits

No product source, service, provider, browser, or hosted CI behavior was changed or qualified. No new blocking issue was found in the cross-workstream changes. I am satisfied with the evaluation-validity and CI portions of this exact D2 plan and approve proceeding to implementation under its acceptance gates.
