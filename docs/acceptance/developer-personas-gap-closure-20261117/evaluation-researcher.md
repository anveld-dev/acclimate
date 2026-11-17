# Evaluation researcher follow-up acceptance — 2026-11-17

**The bounded manifest, named-metric and conditional uncertainty follow-up is accepted.** All 30 executable assertions passed using a fresh release wheel in an external application against the actual isolated Rust service and PostgreSQL 16. The broader original persona acceptance remains partial: this researcher did not exercise arbitrary process-loss recovery or an actual second-machine artifact distribution channel, and the conditional interval does not establish general model quality or population inference.

This is an independent persona enactment and a synthetic collection experiment, not observed customer research. The [historical report](../developer-personas-20261117/evaluation-researcher.md) and its JSON remain unchanged. Criteria were saved before each execution. The [current public JSON](evaluation-researcher.json) retains all criteria, 30 assertions, exact request/attempt/comparison/version identities, observed scalar rewards, policy results, analysis results, artifact hashes and cleanup. The [script](../../../scripts/acceptance/dx_personas/evaluation_researcher.py) defines the app, independent grader, private manifest, component projection, collection protocol and independent arithmetic.

| Requirement | Observed result |
| --- | --- |
| Installed external consumer | Offline installed checksummed wheel; every shipped Python file matched the archive; SDK import stayed inside the external virtual environment. No checkout SDK imports. |
| Actual unequal repetition evidence | Three routine pairs and one critical pair still yield equal-case parent .70 and candidate .40; pooled rows would reverse the result to .55 and .60. Installed policy and named analysis agree with independent calculations over service-returned rows. |
| Completion versus quality | The fully graded losing candidate completes, while the actual higher-is-better correctness policy fails. Changing direction demonstrates orientation only; it does not justify releasing a correctness regression. |
| Missing grades and costs | Actual failed candidate grading leaves null reward, incomplete comparison and indeterminate policy with 3/4 comparable pairs. Requiring cost returns indeterminate with four unknown candidate costs and null total. |
| Generated manifest | Installed create_evaluation_manifest captures the same Case inventory used by define_evaluation. Saved private JSON restores identical bytes, descriptor and executable definition; the app executes from the restored definition. |
| Provenance change detection | Snapshot, expected answer, repetition count, settings, actual grader source and retained build-artifact changes alter the expected dataset/grader/runtime and configuration revisions. Independent domain-separated SHA-256 calculations over the retained private inventory reproduce all four generated revisions. |
| Public/private separation | Public descriptor excludes the private sentinel, grader source text and private artifact-map name. Only public descriptor identities are sent with requests; the service retains the exact descriptor. Hashes identify declared content and provide no encryption or execution attestation. |
| Named components | Actual service comparison rows and explicitly selected retained grader explanations feed the distributed installed analyze.py. Correctness uses fraction-correct units and higher direction; positional errors use label-count units and lower direction. |
| Exact component binding | Trusted binding comes separately from retained request/run identity and authoritative comparison version/digest fields. Stale request, attempt, comparison, version, digest and grader-revision sidecars each reject with analysis.identity_mismatch. |
| Missing component | A null error component makes only that metric indeterminate with one missing pair and no summary; complete scalar correctness remains descriptive. No zero imputation. |
| Deterministic evidence | Both metrics return uncertainty.not_requested and null intervals for the original saved-label run. Deterministic repeated rows do not acquire confidence. |
| Separate stochastic collection | Actual app executions produce 16 paired observations across two fixed cases, eight pairs each. Service-returned rows match the independently reconstructed declared collection algorithm, with varying within-case paired differences. |
| Conditional bootstrap | Explicit samplingProtocol and independentStochasticPairs declarations enable approximate paired within-case intervals. Saved analysis reproduces exactly; independent arithmetic over observed service rows reproduces the scalar mean and interval endpoints. |
| Selected review evidence | Four selected critical response/explanation roles export and verify using a separate read principal from an isolated reviewer directory; 12 roles remain not_shared. Online verification says online_scalar_binding and executionAttested=false. |
| Cleanup | The fixture service stopped and PostgreSQL directory was removed. Private manifests, app/journal, commands, scalar comparisons, analysis configuration and review evidence remain only in owned private fixture directories. |

The deterministic correctness calculation remains:

```text
parent:    (mean(.4,.4,.4) + mean(1)) / 2 = .70
candidate: (mean(.8,.8,.8) + mean(0)) / 2 = .40
higher-oriented improvement = -.30; policy.fail
```

The component grader independently counts positional errors against retained expected labels. Its equal-case means are parent 1.5 and candidate 1.0 labels, oriented improvement +.5 under lower-is-better direction. This component asks a different question from fraction-correct: cases contain different numbers of labels. The two metric scales remain explicit, and no safety claim follows from fixture label names.

## Separate collection and uncertainty assumptions

The stochastic application task emits five yes/no labels for each of two fixed cases. Parent and candidate bundles set Bernoulli thresholds .35 and .70 respectively. For each case/repetition, the app hashes the retained collection seed 918273, exact case ID and repetition into a separate Python random.Random seed. It makes five fresh pseudorandom uniform draws; parent and candidate use the same pair's uniforms, making their outcomes paired. Distinct pairs use distinct streams. The app grader then scores actual emitted labels against the retained five yes labels. No requested reward is supplied by the executor.

The fixed collection plan is two cases × eight pairs, with no adaptive stopping, retries or reused outputs. This controlled, seeded pseudorandom task is acceptable evidence for application algorithm and real service wiring. The independence statement is an application assumption about separate streams, not a theorem of independence or evidence of independent real-model draws. Replaying the same retained seed reproduces this synthetic dataset and does not create additional independent observations.

The separately retained analysis protocol is:

```json
{
  "method": "paired-within-case-bootstrap",
  "estimand": "fixed-cases",
  "samplingProtocol": "researcher-paired-sha256-random-v1-seed918273-two-fixed-cases-eight-pairs-shared-uniforms-no-adaptation",
  "independentStochasticPairs": true,
  "confidenceLevel": 0.9,
  "resamples": 2000,
  "seed": 42
}
```

The analysis resamples complete paired differences within each fixed case, retains that case's pair count and averages the resulting case means equally. Cases are not sampled as a population. The independent reference calculation follows the documented uint32 recurrence, UTF-8 case ordering and nearest-rank percentile algorithm directly over the actual service rows.

| Metric | Parent equal-case mean | Candidate equal-case mean | Oriented improvement | Approximate 90% fixed-task interval |
| --- | ---: | ---: | ---: | --- |
| Correctness, fraction correct, higher | .3625 | .7125 | +.35 | [.275, .425] |
| Positional errors, labels, lower | 3.1875 | 1.4375 | +1.75 | [1.375, 2.125] |

These are conditional algorithm results on an intentionally favorable synthetic Bernoulli task. Eligibility minima and nondegenerate endpoints do not establish calibrated interval coverage, adequate sample size, unseen-task generalization, causal effects, real model improvement, genuine safety/correctness capability or simultaneous multi-metric inference. Analysis returns no policy verdict, promotion or gate, and performs no release action. Application-owned descriptive policy remains separate.

## Identity, reproducibility and limits

Final completed losing request: ee90c902-fce4-41cc-912e-40a359ba7f15; comparison 3f48d656-584f-4850-aa65-9c6505c4b98e.

Final actual ungraded request: 35b77c1a-c1e5-4795-8bd9-99f3e2126711; comparison 2e2650f1-904d-4970-9e2a-25362b42ef99.

Separate stochastic request: fbd96f78-9b74-46b6-be91-4f34d16b8f7e; comparison 63db246b-0e81-4a21-a326-6f49c3fe5fe4.

| Artifact | SHA-256 |
| --- | --- |
| Release source inventory | 63b0bc9a1751a7b5bf9e230e7bde81f0801ea7d4946171d628449c575cc6cfbd |
| Tested service binary | c84d1961249e635c024346fb23328dccf738f0aa7eef0e5e50fa4b00111d2a50 |
| Installed wheel archive | f25f6380080a0ceba369c9f6ac7b49733f11c04f5a828f218bca2addbe26b577 |
| Retained private manifest | 05a3edeb59ed84a7270a93eeb30cc19f11f34ebe5343e5e46bf514b48f49b602 |
| Public result JSON | e081b5d986c4b686d87f5d269b8d1f28ae96478c2d8f79a5d41fe10c18ab03ed |

The release remained unchanged before/after installation and execution. The repository HEAD is 63eb588458732fbba53c0969c9b892cf08a572fe with uncommitted gap-closure changes; the release inventory hash identifies the tested packaged inputs. This researcher records the existing binary hash and does not independently attest its compilation from source.

```sh
ACCLIMATE_PERSONA_RELEASE=/private/tmp/acclimate-dx-release-20261117-gaps-1 \
ACCLIMATE_PERSONA_SOURCE_SHA256=63b0bc9a1751a7b5bf9e230e7bde81f0801ea7d4946171d628449c575cc6cfbd \
/Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 \
  -m scripts.acceptance.dx_personas.evaluation_researcher \
  --output /private/tmp/acclimate-research-gap-retest-20261117
```

The original unmet requirements are not silently expanded or declared complete. Console rendering is owned by the coordinator's separate actual browser weighting fixture. Arbitrary mid-process termination/recovery and lost lifecycle responses were not tested here; separate operator evidence must qualify them. The reviewer directory is on the same machine, so genuine second-machine transfer and access management remain unproven. Component values remain explicit application assertions. Manifest hashes bind declared content and supplied artifact digests; they cannot authenticate callbacks, detect omitted dependencies, select immutable remote providers or prove execution truth. No builds, model calls, commits, pushes or production mutations were performed by this worker.
