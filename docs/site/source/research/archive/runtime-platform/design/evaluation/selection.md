# Improvement and selection policy

**Archived proposal — superseded by the smaller content service.** [Current overview](../../../../../design/overview.md).
[Design guide](../README.md)

**For:** improvement, evaluation, and release authors. **Owns:** proposal scope, search rules, and the distinction between search acceptance and release. **Status:** proposed.

For example, a proposed retry-review skill might catch more bugs but cost more per review. Search compares it with the current version on paired tasks and decides what to explore next. A separate release decision authorizes what real jobs may use. Each decision has its own record and permissions.

## What the loop produces

A proposal contains a parent version, hypothesis, changed paths, component tags, evidence references, and a frozen candidate package. Builds record provenance. Evaluation adds measurements. A decision records why the candidate won, lost, failed, or remained inconclusive.

Start with instructions, skills, approved memory, configuration, and exposed context settings. Later permit task-harness code/tools in isolated builds. Candidate edits cannot replace the adapter, evaluator, permission policy, search rules, or control plane.

When post-run reflection is enabled, the control plane queues an improvement job after the run outcome commits. A separate improvement worker reads the authorized input/output, bounded trace, and current package, then proposes a change under the campaign budget. It does not execute inside the finished task sandbox. Failure to reflect doesn't erase a completed job. Static checks validate paths, file types/size/encoding, host metadata, secrets, and edit scope before grading generality, contradictions, duplication, and injection. A kept lesson creates a candidate package, not a live memory write.

## Proposal-side search discipline

Use a bounded, versioned edit schedule—for example, up to three coordinated edits early and one later. Those numbers illustrate the shape, not defaults. An optional smooth taper can follow the cosine schedule in [the RRSI notes](../../../../rrsi.md); record its horizon and min/max values. Declared independent edit counts and component/diff checks guide search; they don't prove semantic complexity or provide isolation.

Keep the full history, including rejected hypotheses. Give the proposer a bounded recent view plus relevant evidence. When progress stalls within the calibrated tolerance, reserve exploration for untried components. Pruning suggestions need ablations before claims that a component helps or hurts; a multi-edit win doesn't identify the cause.

## Search-side selection

Example, with complete evidence and all required checks passing: current score `0.80` at `$0.10/trial`; candidate `0.79` at `$0.08/trial`. With tolerance `0.02`, best score `0.80`, quality/cost weights `1`, and novelty weight `0`, the candidate clears the `0.78` score floor. Its utility is `-0.01 - (-0.20) = 0.19`, so search can keep it for its lower cost. This is not a release approval or a claim of better quality. These values illustrate the policy, not production thresholds.

<!-- diagram:selection-example -->

The proposed rule uses normalized score `S` in `[0,1]`, known comparable mean cost `C`, best accepted search score `S_best`, and positive tolerance `delta`. Novelty `n` is the fraction of changed component categories not previously accepted in this campaign, in `[0,1]` (zero when none changed).

`beta0` is the base allowed fractional cost increase; `beta1` adds allowance per unit of score gain. Nonnegative weights `ws`, `wc`, and `wn` value score change, fractional cost change, and novelty. Pin their values, normalization, cost metric, and component taxonomy before measurement.

```text
dS = candidate.S - incumbent.S
dC = (candidate.C - incumbent.C) / incumbent.C

require complete, valid evidence and all critical guards
require candidate.S >= S_best - delta
if dS > delta: require dC <= beta0 + beta1*dS
else:         require ws*dS - wc*dC + wn*n > 0

choose highest score, then lower cost, then package digest
if nobody passes, keep incumbent
```

Unknown cost never becomes zero change. If both costs are known zero, use `dC = 0`. If the incumbent cost is zero and the candidate cost is positive, this relative-cost policy rejects the candidate; an absolute-cost alternative needs a separately declared policy revision.

Novelty refers to structural component categories not previously accepted, not arbitrary new text. Selection can accept a cheaper candidate with a small score drop inside the floor. This is exploration, not evidence that quality improved.

Calibrate noise with repeated unchanged-harness evaluations, paired comparisons where possible, and a positive minimum tolerance. Keep sample size/uncertainty visible. Don't copy upstream workload thresholds. The [RRSI notes](../../../../rrsi.md#selection-exactly) document its exact source behavior and where this policy differs.

## Release-side decision

Search acceptance never writes a deployment pointer. The [production release gate](../runtime/production.md#rollout-and-rollback) requires a fresh, separately controlled audit evaluation and operator authorization for every v1 release.

Predeclare either quality improvement beyond tolerance, or sufficient cost reduction while a quality confidence bound clears a noninferiority margin. Require critical guards, complete comparable evidence, runtime qualification, campaign budget compliance, and V1 operator review. Record margins, confidence rules, required samples, and limits/corrections for repeated candidate comparisons before evaluating. Adaptive search scores alone do not establish release confidence.

A cheaper routine may become the search incumbent while the stable release stays unchanged. A critical guard failure blocks acceptance even when the average score rises. Missing grading or required cost evidence is inconclusive, not a useful win.

## Decision integrity

The policy is a pure Rust module over a sealed aggregate snapshot, package identities, history, and expected incumbent revision. Store its revision, inputs, coefficients, result, and reasons. Update the search incumbent atomically; concurrent decisions conflict.

Changed candidates, new graders, drifted conditions, and late reconciliations produce new measurement/decision records. They don't rewrite evidence already used for release. Audit access is logged and limited; repeated peeks at a held-out split can still overfit it.

**Next:** [orchestration](workflow.md) for stages and retries, [evaluation contracts](contracts.md) for measurements, and [production](../runtime/production.md) for deployment.
