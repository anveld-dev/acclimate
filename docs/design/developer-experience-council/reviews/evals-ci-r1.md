# Independent evaluation validity and CI review — round 1

Disposition: **BLOCKED**, pending two small but normative contract clarifications. This is independent source/design review, not implementation qualification.

Reviewed PLAN.md D1, SHA-256 `afa98dc2146c5a70ddda6aeda15730e69e1f53348c26897845133ec8b81b872c`. The plan's direction is sound: complete evidence, application quality policy, and release authorization remain separate; uncertainty and missingness cannot pass; bound online evidence is required; unequal repetitions do not silently change case weights. The blockers concern reproducible verdict/exit behavior promised by the plan, not disagreement with those choices.

## EC-1 — Freeze the exact numerical reduction, not just traversal order

**Plan evidence:** section 8, lines 285–289 specifies case/repetition ordering and sequential IEEE-754 addition/division, but does not provide the exact reduction recurrence for a case mean, aggregate candidate/parent mean, aggregate improvement, or cost total. G11 requires cross-language overflow and exact-threshold behavior.

**Concrete ambiguity:** averaging `[1e308, 1e308]` can mean `(x0 + x1) / 2`, which overflows and must be indeterminate under this plan, or `x0/2 + x1/2`, which is finite. Both use sequential double additions/divisions in the declared order. Incremental mean is another plausible interpretation, and is used in the existing console score summary (`apps/console/src/lib/evaluation-score-summary.ts:13–15`). Near an inclusive threshold, different reductions can also produce different pass/fail bits without overflow.

**Minimum remedy:** add normative pseudocode such as `sum = 0.0; for x in orderedValues: sum = round64(sum + x); mean = round64(sum / count)`, checking every intermediate for finiteness. Specify whether aggregate improvement is `mean(oriented per-case differences)` (the present prose appears to choose this), rather than difference of aggregate means, and use the same explicit recurrence for costs and threshold arithmetic. Keep console descriptive means separately labeled as already planned.

**Acceptance:** shared TS/Python fixtures include the overflow example, cancellation-prone mixed magnitudes, exact threshold equality and one rounding-sensitive vector. Each fixture fixes either the exact finite result/verdict or the exact indeterminate reason. The two implementations must not substitute online means, compensated summation, or summing predivided terms unless that algorithm is the normative choice.

## EC-2 — Complete the policy/check eligibility and authoring-error decision table

**Plan evidence:** section 7's exit table (lines 255–263) separates invalid/wrong-identity errors (1), complete policy violations (2), and incomplete/indeterminate evidence (3). Section 8 (lines 267 and 283–287) requires a terminal bound comparison and says a required case absent from app inventory cannot pass, but does not choose a verdict/category for either no terminal comparison or a policy-required case that the trusted descriptor never declares.

**Concrete ambiguity:** running `check` while a request is still requested/running or after interruption has no terminal comparison ID. An implementation can report a wrong-identity/lookup error (exit 1) or missing evidence/indeterminate (exit 3). Separately, `requiredCases:['critical-task']` with an otherwise complete trusted inventory containing only `ordinary-task` can be treated as invalid policy (1), a quality failure (2), or incomplete evidence (3). All reject promotion, but the plan promises predictable CI categories and exact conformance; these distinctions drive retry versus policy repair versus content repair.

**Minimum remedy:** add a small ordered decision table covering requested/running/interrupted without terminal comparison, failed with a bound incomplete comparison, absent policy-required case in the trusted descriptor, missing declared result, malformed/duplicate inventory, mismatched binding, and unavailable transport. Choose one stable reason/exit for each. Prefer treating an absent required case as a policy/descriptor authoring incompatibility before execution, and nonterminal/interrupted/no-evidence states as indeterminate rather than fabricating a comparison. Other choices are acceptable if explicit and consistent across doctor/check/pure policy.

**Acceptance:** CLI/pure-policy fixtures assert the chosen code, verdict and process category for those scenarios. `doctor --policy` validates the same authoring rule without callbacks; a normal candidate loss remains run=0 and check=2, and an incomplete failed evaluation remains run=2 and check=3.

## Nonblocking implementation advice

### EC-N1 — Do not reuse the current comparison scheduler unchanged for the new serial order

Section 3 line 93 chooses serial parent-then-candidate behavior. Existing `compare` starts both sides with `Promise.all` and a callback limiter (`packages/sdk/src/compare.ts:268`); at concurrency 1, an asynchronous case can execute in the order parent-execute, candidate-execute, parent-grade, candidate-grade. That does not mean a complete parent run/grade finishes before the candidate starts. Add an explicit callback trace to G09 and implement the chosen high-level sequence; retain the old low-level behavior for compatibility. This is a known implementation consequence of the plan, not a reason to reject its interface.

### EC-N2 — Use integral types for count limits

Require `maximumCandidateTaskFailures` to be a nonnegative safe integer, and reject JSON booleans in Python numeric fields. A fractional maximum currently has an obvious numerical interpretation but is a poor count interface. Give optional empty `cost:{}` a documented validation rule as well.

### EC-N3 — Fixed order is descriptive, not an unbiased experimental design

Always executing parent before candidate can couple results to time or shared external state. The initial serial choice is acceptable and recorded; explain that the app must reset fixture state independently for both sides. Counterbalancing/randomization and clustered uncertainty remain properly deferred research work, not implied confidence from repeated rows.

## Concrete policy-vector checks

Ran a standalone Python calculation implementing a simple sum-then-divide interpretation of the draft. These are checks of the proposed math, not tests of implemented Acclimate behavior:

- One case improves 0→1 once; another regresses 1→0 with nine repetitions. Equal-case parent/candidate means are both 0.5, aggregate improvement 0, worst case regression 1. A pair-weighted delta would be −0.8, so the proposed policy's weighting distinction is meaningful and correct.
- Lower-is-better parent rewards `[10,12]`, candidate `[8,10]`: means 11 and 9, oriented improvement +2, worst regression 0.
- Equal 0.5 rewards produce improvement 0 and pass an inclusive zero-improvement/no-regression policy.
- A scored task failure with reward 0 remains gradeable; an explicit candidate-failure-count policy can reject it separately.
- `[1e308,1e308]` overflows under sum-then-divide and must be indeterminate, never quality-pass.
- A required unknown cost is a logical unknown and remains indeterminate; the draft correctly forbids converting it to zero. A known failure plus a required unknown remains indeterminate with the known failure visible, as the plan deliberately chooses.

## Source reviewed and limits

Reviewed current `packages/sdk/src/compare.ts`, wire types, `src/improvement.rs` comparison validation, `src/evaluations.rs` submission/finish binding, console score-summary code, SDK transport, and operator review/release code. Server completeness currently means fixed coverage with finite scored outcomes and no infrastructure failure; fully graded task failures can count as complete. The new plan preserves those semantics and explicitly does not turn a policy pass into release authorization.

No service, hosted CI, provider, UI browser, or product tests ran. No product source changed. Statistical inference and multi-metric work are reasonably deferred, with the new scalar policy explicitly descriptive. I can approve after EC-1 and EC-2 are fixed in the normative plan and I inspect its exact revised digest.
