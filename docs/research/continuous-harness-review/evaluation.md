# Evaluation concepts for continuous harness improvement

Source inspection on 2026-11-17. No tests or model runs were executed for this review. Local source is authoritative for implementation statements; upstream comparisons use the pinned RRSI checkout named in `.repos.json`. Findings below distinguish a defect in the goal's architecture from a defect in today's deliberately narrower content service.

## Verdict

The immutable evidence substrate is useful and should be retained. It is not yet a complete experiment protocol for a continuously adapting harness. Three additions matter: immutable evaluator/environment identity, controlled paired execution, and a durable search-to-release decision protocol. These belong primarily in an application-owned learning controller and its retained records; they do not require moving agent execution into the Rust service.

## 1. High: content identity is exact; experiment identity remains a declaration

**Classification:** reproducibility gap for continuous improvement, not a claim of broken request authentication.

`defineEvaluation` freezes case data and captures executable callbacks, but the public identity is `datasetRevision`, `graderRevision`, caller runtime fields, and config labels. It does not automatically hash private case input/expected data, evaluator code, grader code, SDK/runtime build, or resolved model configuration. See [definition.ts:137](../../../packages/sdk/src/evaluation/definition.ts#L137) and [definition.ts:159](../../../packages/sdk/src/evaluation/definition.ts#L159). The server comparison shape has the same label-based identity alongside exact content digests ([types.rs:120](../../../src/types.rs#L120)). The runner's structural identity check compares that descriptor ([runner.ts:80](../../../packages/sdk/src/evaluation/runner.ts#L80)); it cannot discover that a callback's implementation changed without its revision label changing.

**Failure scenario:** an evaluator deployment changes tool permissions, a grader prompt, or case expected answers while keeping the descriptor labels. A newly resumed attempt or next search round passes descriptor checks but measures a different experiment. An apparent gain can come from the changed grader or harness implementation rather than the content candidate. Exact bundle digests alone cannot distinguish them.

**Counterargument:** the application owns its evaluator and is expected to version it honestly; runtime fields can already carry extra hashes. A malicious authorized evaluator can fabricate outcomes regardless of schema. This finding is about accidental drift and valid cross-run attribution, not providing cryptographic proof of real model execution.

**Minimal remedy:** define an immutable experiment manifest with canonical commitments to private dataset inventory/content, grader implementation/configuration, execution implementation, prepared harness mapping, tool/environment configuration, and resolved provider/model settings. Keep sensitive content local; send digests. Freeze that manifest at request creation and validate it on resume and before each callback run. Preserve human revision labels for readability. Model identifiers that providers do not make immutable must be recorded as such, rather than claimed reproducible.

## 2. Medium: the SDK's fixed arm order is an uncontrolled live-experiment variable

**Classification:** concrete runner design limitation when its output is interpreted causally.

The SDK always visits cases in declaration order and runs parent before candidate ([runner.ts:537](../../../packages/sdk/src/evaluation/runner.ts#L537), especially line 545). It does create separate per-side job directories and supplies matching case/repetition input, which is good ([runner.ts:551](../../../packages/sdk/src/evaluation/runner.ts#L551)). Those filesystem properties do not reset application databases, tool state, caches, provider rate limits, or time-dependent fixtures. Execution callbacks are application code and can retain process-level state.

**Failure scenario:** the parent populates a cache or mutates a shared fake service; the candidate benefits on every pair. Alternatively a provider degrades over the run and the candidate consistently sees a different condition. Repeating the same fixed order makes this confound repeatable, not correct. A paired key identifies intended pairing; it does not establish exchangeability or independence.

**Counterargument:** deterministic, side-effect-free simulators have no such issue. Honest callbacks can provision their own isolated environment today. The SDK does not promise hostile-process isolation, and random order alone would not repair shared-state contamination.

**Minimal remedy:** freeze a collection protocol with deterministic, seeded, balanced arm order; expose an application environment-reset/fixture factory contract; retain actual execution order and environment identity. Let deterministic simulators opt into fixed order explicitly. Continue requiring fresh jobs for native SDK sessions and prohibit carryover memory between arms. Keep this protocol separate from the statistical bootstrap seed.

## 3. High for an autonomous controller: descriptive passes and complete evidence do not supply adaptive selection or release policy

**Classification:** missing controller concept; current service behavior is deliberate and internally consistent.

The quality policy compares observed mean improvement and worst observed per-case regression to thresholds ([policy.ts:630](../../../packages/sdk/src/evaluation/policy.ts#L630), [policy.ts:645](../../../packages/sdk/src/evaluation/policy.ts#L645)). It is explicitly descriptive. The analysis module has an optional fixed-case paired bootstrap, an explicit app assertion of independent stochastic pairs, and careful insufficient-data statuses ([analysis.ts:24](../../../packages/sdk/src/evaluation/analysis.ts#L24), [analysis.ts:325](../../../packages/sdk/src/evaluation/analysis.ts#L325)). It does not claim protection against adaptive candidate search or generalization to new tasks.

Promotion validates complete evidence, target/current parent, and content digests ([channels.rs:207](../../../src/channels.rs#L207), [channels.rs:235](../../../src/channels.rs#L235)). It does not enforce an immutable quality-policy verdict, held-out audit, confidence bound, search budget, or evaluator-manifest freshness. This is appropriate for deliberate human review; it is not sufficient authority for a worker that simply promotes any completed comparison or any point-estimate pass.

**Failure scenario:** an indefinite controller proposes candidates against the same small suite until one clears a point threshold by chance, then releases it. A narrow paired interval on that selected run still does not account for all rejected attempts or repeated peeking. A one-time audit becomes a development set if its failures are repeatedly fed back into proposal generation and retried until passing.

**Existing protections and counterevidence:** the twenty-round example already separates adaptive development from a once-used audit, and says so explicitly ([twenty/run.ts:457](../../../examples/self-improvement/twenty/run.ts#L457)). Its search selection checks safety and observed performance, and permits shorter equivalent candidates ([twenty/run.ts:276](../../../examples/self-improvement/twenty/run.ts#L276)). Do not report that this repository has no holdout or conflates completion with improvement. [evidence_regressions.rs:136](../../../tests/evidence_regressions.rs#L136) explicitly exercises a complete losing candidate. RRSI likewise uses a calibrated noise band, a best-accepted floor, cost/novelty shaping, and guards rather than treating every positive observed delta as demonstrated improvement ([calibration](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/calibrate.py#L85-L108), [selection](https://github.com/google-research/rrsi/blob/be50316e1db05914068a973f322770ef08ed7ba1/rrsi/selection.py#L97-L137)). RRSI's heuristic is not by itself a statistical guarantee for unbounded adaptive search.

**Minimal remedy:** introduce a durable learning campaign record: objective/metric contract, immutable experiment manifest, development/audit partition, trial and spend budgets, all candidate decisions, and an explicit audit-consumption policy. Separate `searchAccepted`, `auditPassed`, and `releaseAuthorized`. Have a release authority verify the frozen decision artifact against the current parent and configured gate. That authority can be an app controller with narrowly scoped promotion credentials; the service need not choose statistical policy globally. Calibrate noise with unchanged-harness runs; use a preregistered repeated-testing or fresh-audit protocol for continuous operation. Do not simply feed an optional bootstrap interval into an unbounded retry loop.

## Concepts that are already sound

- **Exact saved snapshots and stale-parent rejection.** Promotion checks current parent and compare-and-swap revision, then checks digests. [http_contract.rs:521](../../../tests/http_contract.rs#L521) verifies stale evidence cannot promote. Preserve this.
- **Execution/grading failures stay separate.** Completeness requires all expected pair keys, no infrastructure failures, and scored grades on both arms ([improvement.rs:4](../../../src/improvement.rs#L4)). The SDK records grading exceptions as failed rather than manufacturing zero grades ([runner.ts:728](../../../packages/sdk/src/evaluation/runner.ts#L728)). A gradeable task failure may legitimately carry a metric-specific score; do not force all metrics to a universal zero.
- **Quality, completion and authorization are separate.** Do not fix the missing continuous controller by changing `completed` to mean `improved`, discarding losing candidates, or granting evaluators implicit promotion rights.
- **Independent application ownership.** Strong provenance, controlled collection and campaign policy can be added through explicit application interfaces. A content service can remain small while a separate learning controller closes the loop.

## Suggested order

1. Add and freeze the experiment-manifest identity and collection protocol.
2. Build the campaign controller with retained candidate decisions and explicit audit consumption.
3. Bind release authorization to that controller's decision artifact, retaining the existing service revision/digest checks.
4. Qualify with unchanged-harness controls, seeded balanced order, intentional grader drift, interrupted/resumed runs, and repeated rejected candidates. These test the new guarantees more directly than increasing the number of synthetic proposal rounds.
