# Named metrics and paired analysis

Install `@acclimate/sdk` or the `acclimate-sdk` wheel in your application. The evaluation starter archive includes
`analyze.mjs` and `analyze.py`; both scripts import only the installed package. They analyze saved evidence and execute no tasks.

After a named run, let the script assemble the evidence from your evaluator journal and the service:

```sh
node analyze.mjs --name "$RUN_NAME" --config "$EVALUATOR_CONFIG" [analysis-config.json] > analysis.json
python analyze.py --name "$RUN_NAME" --config "$EVALUATOR_CONFIG" [analysis-config.json] > analysis.json
```

It reads the run's handoff from `journalRoot/comparisons/RUN_NAME/request.json`, fetches the request and
comparison, and derives the descriptor and the seven-field trusted binding from the authoritative request.

For saved files, pass them explicitly:

```sh
node analyze.mjs comparison.json descriptor.json trusted-binding.json [analysis-config.json] > analysis.json
python analyze.py comparison.json descriptor.json trusted-binding.json [analysis-config.json] > analysis.json
```

Save the authoritative comparison returned by your reader client as
`comparison.json`. Save your installed evaluation descriptor as `descriptor.json`.
Retain the request/attempt identity before execution, then obtain the exact
comparison ID from the authoritative request result. Your trusted binding file is:

```json
{
  "parentVersionId": "parent-version-id",
  "candidateVersionId": "candidate-version-id",
  "parentDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "candidateDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "requestId": "request-id",
  "attemptId": "attempt-id",
  "comparisonId": "comparison-id"
}
```

Errors are one JSON line on stderr. `analysis.file_unreadable` and `analysis.file_not_json` name the
file, `analysis.binding_invalid` lists the missing binding fields, and `analysis.invalid_config`
appears only for an analysis config you supplied, with any unknown field names.

Populate it from the app's retained request/attempt and authoritative service
responses, separately from any untrusted downloaded analysis sidecar. Matching a
binding asserts consistency; it does not attest execution or authenticate files.
Omit the config argument for descriptive higher-is-better scalar reward, in
reward units. Explicit metadata should describe the actual grader's scalar scale.

For multiple metrics, the application retains components with its grader
explanations, then explicitly projects the selected finite numbers into
`observations`. Nothing automatically extracts numbers or shares private text.
Each observation includes the exact final grader revision and outcome binding:

```json
{
  "metrics": [
    {
      "id": "correctness",
      "name": "Correctness",
      "unit": "fraction correct",
      "direction": "higher",
      "source": "reward"
    },
    {
      "id": "latency",
      "name": "Latency",
      "unit": "ms",
      "direction": "lower",
      "source": "component"
    }
  ],
  "observations": [
    {
      "requestId": "request-id",
      "attemptId": "attempt-id",
      "comparisonId": "comparison-id",
      "graderRevision": "grader-revision-from-descriptor",
      "caseId": "case-a",
      "repetition": 0,
      "side": "parent",
      "versionId": "parent-version-id",
      "bundleDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "values": { "latency": 241.5 }
    }
  ]
}
```

The shown row illustrates the format. Add one row per side of every expected
pair, including every selected component. `null`, absent components, missing
outcomes, infrastructure failures and unscored grades remain missing. The
affected metric returns `indeterminate` and coverage counts. Its `cases` contains
means for cases with every planned repetition scored. Its suite summary and
interval remain null. `evidenceGaps` identifies the case, repetition, side and
stage for the first 32 missing observations and reports their full count.
Other complete metrics can still be analyzed. A component requires a
valid finite scalar score and cannot upgrade failed or incomplete scalar grading.
A `task_failed` outcome with a valid
score remains gradeable. Unknown component names, duplicate rows and stale
request/attempt/comparison/version/digest/grader identities are rejected.

The installed API is also directly usable:

```js
import { analyzeComparison } from '@acclimate/sdk/evaluation/analysis';
const analysis = analyzeComparison({
  comparison,
  expectedDescriptor,
  expectedBinding,
  metrics,
  observations,
});
```

```python
from acclimate.evaluation_analysis import analyze_comparison
analysis = analyze_comparison(comparison=comparison, expected_descriptor=descriptor,
                              expected_binding=binding, metrics=metrics,
                              observations=observations)
```

For reproducibility, retain the configuration, observations, result, descriptor,
comparison and trusted binding together under your own access controls. The
manifest helper's derived descriptor binds the private cases/settings and grader
revision; the observation's `graderRevision` must equal that exact descriptor
value. Adding components is part of your grader implementation and requires a
new grader revision. Acclimate cannot detect a falsely unchanged revision label.
The artifact export workflow can explicitly share a selected grader explanation;
analysis does not read local output references or fetch URLs.

## Collect balanced repetitions

Pass `collection: { protocol: 'seeded-balanced-v1', seed: 'experiment-01' }` to
`defineEvaluation`, or `collection={"protocol": "seeded-balanced-v1", "seed": "experiment-01"}`
to `define_evaluation`. Choose the seed before the run. The descriptor binds the seed
and schedule digest. Each pair runs both arms consecutively, and the number of
parent-first and candidate-first pairs differs by at most one across the inventory.
The callback's collection context includes its pair index, arm index, and first side.
The private journal retains `collection.json` and a `collection-binding.json` for
each started job. Give each arm a fresh isolated tool fixture, cache and conversation.
The seed changes arm order. Application code controls model sampling and fixture reset.

## Fit a larger suite into multiple requests

At definition time the SDK reserves space for both outcomes of every pair.
If it raises `definition.report_budget_exceeded`, its `reportBudget` diagnostic
provides `estimatedBytes`, `limitBytes`, `expectedPairs` and
`maxPairsPerPartition`. The last value uses the largest row in the submitted
inventory. Keep all repetitions of a case together and group whole cases up to
that limit. For example, a ceiling of 420 pairs permits 42 ten-repetition cases
in a request. Validate each resulting definition again with its actual metadata.
If one case alone exceeds the ceiling, reduce its repetitions before collecting
any evidence or use an application-owned analysis of separately identified runs.

Freeze a full case inventory, exact parent and candidate IDs/digests, grader,
model/tool settings, collection protocol, and metric definitions before splitting
the cases. Retain a private manifest and independent trusted binding for each
partition. Select the same saved candidate for each request in the console, or
call `client.create_evaluation(project_id, bundle_id, body, partition_key)`
(`client.createEvaluation` in TypeScript). Construct `body` from the partition's
public descriptor plus the four frozen version ID/digest fields and
`requireBoundEvidence: true`. Keep an individual idempotency key for each
partition. Run and analyze each request separately with its binding. Abort the
aggregate if an immutable version, grader, metric, collection setting or expected
case count differs from your plan. Each partition has its own request, attempt,
comparison, inventory and schedule digest.

To combine one descriptive metric from individually verified partitions, use the
per-case rows in each analysis. `planned_repetitions` below is the complete frozen
mapping from case ID to repetition count and `parts` contains that metric's
result from each partition. Equal weighting across all cases also handles a
smaller final partition.

```python
from statistics import fmean

rows = {}
for part in parts:
    if part["status"] != "descriptive" or part["counts"]["missingPairs"]:
        raise ValueError("incomplete partition")
    if part["metric"] != expected_metric:
        raise ValueError("metric definition changed")
    for row in part["cases"]:
        case_id = row["caseId"]
        if case_id in rows or row["pairs"] != planned_repetitions.get(case_id):
            raise ValueError("duplicate, unexpected or incomplete case")
        rows[case_id] = row
if rows.keys() != planned_repetitions.keys() or not rows:
    raise ValueError("suite inventory is incomplete")
suite_mean = {name: fmean(row[name] for row in rows.values())
              for name in ("parentMean", "candidateMean", "orientedMeanImprovement")}
```

This calculation produces a descriptive suite summary. Evaluate any suite-wide
policy from the combined cases and costs. Partition-level verdicts and interval
endpoints apply only to their individual request.

## Optional uncertainty: two questions

Each interval answers one question and is labeled with it in `uncertainty.estimand`.
The policy verdict answers the first one by default.

| `method` | Question | `estimand` | Minimum |
| --- | --- | --- | --- |
| `paired-t` | Would the candidate do as well on **tasks like these**? | `sampled-cases` | 2 cases |
| `paired-within-case-bootstrap` | What happens if we run **these tasks again**? | `fixed-cases` | 3 repetitions per case |

For tasks like these, add:

```json
{
  "uncertainty": {
    "method": "paired-t",
    "estimand": "sampled-cases",
    "samplingProtocol": "app-protocol-revision-that-documents-case-selection",
    "confidenceLevel": 0.95
  }
}
```

It is a two-sided Student t interval on the equal-weight case means, at 0.80, 0.90, 0.95 or 0.98.
It treats your cases as a sample from the tasks you care about, so it reflects both case-to-case
variation and run-to-run noise. Identical case differences return `insufficient_data`.

For these tasks again, only opt in when you actually collected independent stochastic paired
repetitions, under a retained protocol that explains randomization, pairing and
independence across repetitions and cases:

```json
{
  "uncertainty": {
    "method": "paired-within-case-bootstrap",
    "estimand": "fixed-cases",
    "samplingProtocol": "app-protocol-revision-that-documents-collection",
    "independentStochasticPairs": true,
    "confidenceLevel": 0.95,
    "resamples": 2000,
    "seed": 42
  }
}
```

The analysis first averages paired parent/candidate repetitions within each case,
then gives each distinct case equal weight. Repetitions do not increase a case's
weight. The bootstrap resamples whole paired differences within each case,
keeping that case's original repetition count. Resampling `r` values understates the
variance of a case mean by `(r - 1) / r`, so each resampled case mean `m*` is replaced by
`d + sqrt(r / (r - 1)) * (m* - d)`, where `d` is the observed case mean. The resampled case
means are then averaged equally. It never resamples the fixed inventory as if it were a sampled
task population; use `paired-t` for that question.

Coverage at a nominal 95% in simulations with binary rewards (per-case success rates from
U(0.2, 0.8), true effect around +0.05, 600 to 2,000 runs per cell):

| Cases × repetitions | Unscaled bootstrap (before) | Scaled bootstrap | `paired-t` |
| --- | --- | --- | --- |
| 10 × 2 | 78% | 91% | 95% |
| 10 × 3 | 86% | 93% | 95% |
| 30 × 2 | 80% | 93% | 97% |
| 30 × 3 | 86% | 94% | 95% |
| 30 × 5 | 92% | 94% | 94% |

The scaled bootstrap still undercovers by one to four points with few repetitions, so it requires
at least three repetitions per case. Treat its intervals as approximate. Very small samples, skewed
distributions, dependence, order effects, adaptive stopping, reused outputs and unrepresentative
draws can make any interval misleading. The helper cannot validate the collection protocol.

One case, fewer than three repetitions for the bootstrap, constant paired differences, or
degenerate resampled endpoints return `insufficient_data` with no interval.
Deterministic convenience fixtures must use the descriptive default; setting a
declaration does not turn them into stochastic evidence. Missingness is never
zero-filled. Finite arithmetic overflow returns `indeterminate`.

## How this relates to the policy verdict

The policy gate uses the `paired-t` question with a one-sided lower bound, a minimum case count,
an SD floor and conservative imputation of up to 15% missing trials per arm. Its default
false-pass rate at zero true effect stays near the nominal 5% (4.3% to 5.7% across 10 to 60 cases
in 2,000-run simulations), while a point-estimate comparison passes about half of such candidates.
Run `acclimate-eval plan --policy quality-policy.json` to see the minimum detectable effect for your
inventory. The Methodology page in the documentation (Concepts) has the full table.

No interval supports a causal claim or a claim about general model quality,
unseen tasks, or safety. The intervals are per metric without a simultaneous
multiple-comparison guarantee. They neither apply an effect threshold nor
produce a release/promotion verdict. The policy checker remains a separate
explicit application decision.

The reproducible algorithm sorts case IDs by UTF-8 bytes and repetitions
numerically; each metric starts the same independent stream. Its uint32 state is
`(1664525 * state + 1013904223) mod 2^32`, and each draw index is
`floor(state / 2^32 * casePairCount)`. Sorted bootstrap draws use nearest-rank
quantiles `max(0, ceil(p * resamples) - 1)`. Seeds include zero and the full uint32
range. Confidence levels are 0.80–0.99 and resamples 100–10000. JavaScript and
Python follow the same operation order and reject nonfinite component numbers.
