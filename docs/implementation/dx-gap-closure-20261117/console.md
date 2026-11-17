# Console follow-up contract — 2026-11-17

This is an explicit addendum authorized by the developer-experience gap-closure request after the researcher persona. The frozen [D2 plan](../../design/developer-experience-council/PLAN.md) specified pooled per-pair console means. That original contract is preserved as history; this follow-up changes the displayed aggregate because unequal repetition counts can reverse the comparison relative to the installed equal-case policy.

## Equal-case observed rewards

The console now averages the comparable repetitions within each case, then averages those case means with equal weight. The scorecard and evaluation-history column say **Observed equal-case mean**. The scorecard calculation disclosure explicitly describes both stages. It reports comparable/expected distinct cases, while retaining scored/expected repetition-pair coverage, missing grades, execution failures and expected-outcome cost.

Only expected case/repetition pairs with two finite, scored, gradeable outcomes contribute to either mean. Graded task failures retain their scores and remain visible as failures. Missing grades, missing pairs and infrastructure failures remain excluded from both sides; they are never imputed to zero. An incomplete comparison or a comparison missing any comparable pair remains partial. Its mean describes the observed subset and is not an overall result. Unknown expected usage remains unknown.

The [recorded researcher results](../../acceptance/developer-personas-20261117/evaluation-researcher.json) contain three routine repetitions at parent 0.4/candidate 0.8 and one critical repetition at parent 1/candidate 0. The new console means are parent **0.70**, candidate **0.40**, matching the installed policy summary within floating-point tolerance. Pooled rows would instead give 0.55/0.60. Unit tests compare the fixture rewards and console means directly with the recorded JSON. The complete and missing-critical browser fixture reads those same recorded rewards.

This changes aggregation, not metric direction or release policy. The console has no selected application policy/direction metadata and does not infer a quality verdict. Higher/lower reward labels remain numerical descriptions. The calculation disclosure says that a higher reward does not establish better quality or a passing policy. Complete evidence alone remains insufficient for release approval. The installed policy continues to own direction, thresholds and pass/fail/indeterminate semantics.

## Optional remote evaluator activity

The selected request in version review and evaluation-history detail reads the optional request-progress endpoint with the same browser read scope as request state. It shows the latest bound attempt's reported phase, completed/total count, optional case, report sequence, server receipt timestamp and server check timestamp. Recent means recent **at the last server check**. Stale reports retain their reported values; absent or failed reads say activity is unknown. A progress read failure cannot hide the durable request record. Selection/scope changes clear preceding activity, and request/attempt mismatches do not display another attempt's report.

The UI has no activity write, stop, cancellation or retry control. It explicitly says optional reports do not prove the worker is live or stopped, cancellation, or that retrying is safe. Request status remains the durable request state. Server observation retention and authorization are owned by the progress API follow-up, not by this component.

## Verification and browser evidence handoff

The full console unit suite passes 252 tests, including unequal-case aggregation against recorded installed-policy evidence, partial paired exclusion/case coverage, signed/zero rewards, missing and failed grades, infrastructure failures, unknown costs, unexpected rows, scorecard rendering and history provenance. Activity tests cover fresh/stale/absent/unavailable and wrong-attempt reports, literal case text, receipt/check timestamps and the optional read's failure isolation. Console TypeScript checks pass. No package build, console build, generated model, distribution output, commit, push or production mutation was performed by this implementation worker.

After the parent has frozen and built the final source, run:

```sh
python3 -m scripts.testing.evaluation_weighting \
  --output artifacts/dx-gap-closure-20261117/console-weighting
```

Use the repository's Python environment containing Playwright, and pass `--pg-bin` if PostgreSQL tools are outside PATH. This script never builds. It uses disposable real service/PostgreSQL and fixture OIDC, verifies a stable build fingerprint, and captures 1440/390/320px layouts. It asserts the complete means 0.70/0.40 with 4/4 pairs and 2/2 cases; the missing-critical subset 0.40/0.80 with 3/4 pairs and 1/2 cases, explicitly partial; unknown costs; both weighting stages; policy limits; reachable repetition rows; recent active, stale terminal and absent activity reports; and no horizontal overflow or browser errors. Its `summary.json` records the fixture provenance and practical limits.

These are recorded rewards submitted as fixture results, not another execution of the researcher's private executor/grader. Browser execution and final screenshot review are the parent's post-freeze verification step; this addendum does not claim that unrun evidence has passed.
