# Research follow-up design and implementation — 2026-11-17

This additive design implements the research follow-up in frozen D2 §16. It
does not edit or retroactively expand that approved first-release design. The
original source review and current persona acceptance both requested named
component metrics and task-aware stochastic uncertainty; the current report
explicitly marked those capabilities unmet.

The coordinating agent approved this contract before implementation:

- Analysis consumes an already bound comparison, separately trusted exact
  descriptor/request/attempt/comparison/version/digest binding, and optional
  explicitly supplied application-retained component observations.
- Every component observation binds the case, repetition, side, version,
  bundle digest, request, attempt, comparison and grader revision. Components
  count only for scored, non-infrastructure-failed comparison outcomes with a finite scalar reward. They
  cannot repair a failed grade or an absent execution.
- Metrics have IDs, display names, units and directions. Scalar reward remains
  available by default. Components are application assertions, never numbers
  inferred from arbitrary explanation text. No server outcome/wire change,
  private upload, executable URL, execution attestation or automatic promotion
  is introduced.
- Each complete metric averages repetitions within a case and cases equally.
  Coverage and missing pairs are explicit per metric. Missing/null components
  suppress that metric's summary and interval rather than becoming zeros.
- Uncertainty is opt-in and conditional on these fixed cases and an explicit
  retained collection protocol declaring independent stochastic paired draws.
  It resamples paired differences within each case, preserving case inventory
  and repetition counts, then takes equal-case means. The result is an
  approximate percentile interval for repeated execution on that fixed task
  inventory, never confidence about a sampled task population.
- At least two cases and two pairs per case are necessary, not sufficient for
  statistical validity. Constant within-case differences, a single case/pair,
  degenerate endpoints and missing evidence produce no interval. Assumptions
  remain application assertions; these helpers cannot detect falsely labeled
  deterministic fixtures or prove independence. There are no causal, general
  model-quality, safety, simultaneous-metric or release claims.
- Sorting, finite arithmetic checks, quantiles and seeded uint32 recurrence
  have the same semantics in JavaScript and Python. Arithmetic overflow is
  indeterminate. Existing descriptive policy checks remain separate.

The supported APIs are `analyzeComparison` from
`@acclimate/sdk/evaluation/analysis` and `analyze_comparison` from
`acclimate.evaluation_analysis`. The TypeScript module depends only on the
browser-safe policy validator and type-only domain imports. Both reuse existing
strict descriptor, inventory, binding and outcome validation, without changing
the validator or interpreting its descriptive policy result as a gate.

`examples/evaluation-starter/ANALYSIS.md` contains complete installed-package recipes,
sidecar format, trusted-binding origin, provenance limits and exact statistical
algorithm. Executable `analyze.mjs` and `analyze.py` ship in the evaluation starter
archive and read saved comparison,
descriptor, trusted binding and optional application analysis configuration;
they write JSON and perform no execution or service mutations. Successful JSON
analysis returns exit 0 even when a metric is indeterminate; exit 0 is not a
quality verdict. Invalid inputs return a bounded diagnostic and exit 1.
The historical `examples/evaluation/analysis.*` entry points are thin wrappers
around those canonical distributed programs.

The manifest helper's derived descriptor can bind private case/settings inputs
and grader revision without sharing their contents. Observation grader revision
must equal the final descriptor's exact revision. Applications must revise the
grader identity when component definitions or measurement change. Matching IDs
cannot attest that an application actually used the retained inputs.

## Exact acceptance and evidence

The deterministic shared fixture is an arithmetic/algorithm oracle, not evidence
of stochastic model improvement or calibrated coverage. It uses two tasks with
unequal repetition counts and two metrics: named scalar correctness in points,
and lower-is-better latency in milliseconds supplied explicitly by the app.

| Acceptance                                        | Evidence                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Equal-case named metrics and explicit direction   | Routine has three paired improvements `[1,3,2]` (mean +2), critical has two `[-4,-2]` (mean −3); equal-case improvement is −0.5 while pooled rows give 0. Parent equal-case mean is 5 and candidate 4.5. Both metrics yield the expected oriented result.                                   |
| Paired task-aware, reproducible optional interval | 1000 resamples at seed 42, nominal level .90, fixed-case conditioning and explicit protocol produce paired-difference endpoints approximately −1.1666666666666665 and +0.16666666666666674 in both languages. Test declarations describe algorithm vectors, not empirical data collection.  |
| Descriptive default and conservative refusal      | Omitted protocol produces `not_requested`; a single case/pair and constant within-case paired differences produce `insufficient_data`, null interval.                                                                                                                                       |
| Missingness stays explicit                        | A null latency component affects only that metric; failed comparison grading prevents either metric from silently upgrading the outcome. No missing pair becomes zero.                                                                                                                      |
| Exact binding and grader revision                 | Independent stale request, attempt, comparison, version, digest and grader mutations reject; duplicate observations reject.                                                                                                                                                                 |
| Finite and cross-language semantics               | Finite input overflow becomes indeterminate; local tests reject nonfinite/boolean component values and invalid protocol options. Shared vectors cover seed 0, seed uint32 max, UTF-8 order that differs from UTF-16 order, reversed inventory/sidecars, and deterministic repeated results. |
| No input mutation or metric-order randomness      | Both languages retain inputs unchanged, detach returned metadata, and reset the same PRNG stream per metric so metric ordering cannot change results.                                                                                                                                       |

Observed source verification:

```text
node --import tsx --test packages/sdk/tests/evaluation/analysis.test.ts
27 passed

PYTHONPATH=python python3.12 -m unittest python.tests.test_evaluation_analysis -v
5 passed (including all 23 shared vectors)

./node_modules/.bin/tsc --noEmit --pretty false
exit 0
```

The shared fixture lives at
`contracts/fixtures/evaluation-analysis/vectors.json`; both SDK test suites
compare full returned results against the same expected objects. The tests also
use an independently written arithmetic check for equal-case means. The
packaged-release coordinator owns fresh tarball/wheel installation and recipe
verification; source tests alone do not claim that installed release check.

Within this explicit fixed-case conditional scope, named components and a paired
task-aware uncertainty helper are implemented. Population task sampling,
simultaneous inference, causal effects, component authenticity, stronger
bootstrap coverage guarantees and automatic release decisions are outside this
contract. A deterministic saved-label persona should retain descriptive mode;
its original outputs cannot acquire stochastic confidence by using this API.
