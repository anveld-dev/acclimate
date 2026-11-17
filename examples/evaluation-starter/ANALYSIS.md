# Named metrics and paired repeated-execution analysis

Install `@acclimate/sdk` or the `acclimate-sdk` wheel in your application. The evaluation starter archive includes
`analyze.mjs` and `analyze.py`; both scripts import only the installed package. They analyze saved evidence and execute no tasks.

```sh
node analyze.mjs comparison.json descriptor.json trusted-binding.json analysis-config.json > analysis.json
python analyze.py comparison.json descriptor.json trusted-binding.json analysis-config.json > analysis.json
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
affected metric returns `indeterminate`, coverage counts and no summary or
interval; other complete metrics can still be analyzed. A component requires a
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

## Optional fixed-task uncertainty

Only opt in when you actually collected independent stochastic paired
repetitions, under a retained protocol that explains randomization, pairing and
independence across repetitions and cases. Add this object to `analysis-config.json`:

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
weight. For uncertainty it resamples whole paired differences within each case,
keeping that case's original repetition count, and averages the resampled case
means equally. It never pools repetitions as independent tasks or resamples the
fixed inventory as if it were a sampled task population.

The result estimates an **approximate repeated-execution interval for these
fixed tasks**, conditional on the declared protocol. It requires at least two
cases and at least two complete pairs per case. Those are eligibility minima,
not guarantees of adequate sample size or calibrated coverage. Very small
samples, skewed distributions, dependence, order effects, adaptive stopping,
reused outputs and unrepresentative draws can make bootstrap intervals
misleading. The helper cannot validate the collection protocol. Collect enough
independent repetitions and evaluate those assumptions in the application.

One case, one repetition, constant paired differences within every case, or
degenerate resampled endpoints return `insufficient_data` with no interval.
Deterministic convenience fixtures must use the descriptive default; setting a
declaration does not turn them into stochastic evidence. Missingness is never
zero-filled. Finite arithmetic overflow returns `indeterminate`.

No interval supports a causal claim or a claim about general model quality,
unseen tasks, or safety. The intervals are per metric without a simultaneous
multiple-comparison guarantee. They neither apply an effect threshold nor
produce a release/promotion verdict. The existing descriptive policy checker
remains a separate explicit application decision.

The reproducible algorithm sorts case IDs by UTF-8 bytes and repetitions
numerically; each metric starts the same independent stream. Its uint32 state is
`(1664525 * state + 1013904223) mod 2^32`, and each draw index is
`floor(state / 2^32 * casePairCount)`. Sorted bootstrap draws use nearest-rank
quantiles `max(0, ceil(p * resamples) - 1)`. Seeds include zero and the full uint32
range. Confidence levels are 0.80–0.99 and resamples 100–10000. JavaScript and
Python follow the same operation order and reject nonfinite component numbers.
