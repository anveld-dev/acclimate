# How improvement works

[Design guide](README.md)

The service can draft better harness files. The app tests them through its existing agent SDK. A reviewer decides which version becomes available to future jobs.

## Example: stop missing retry bugs

`reviewer/v7` often misses unsafe retry paths. A developer sends three authorized examples and asks for a better retry-review skill. Acclimate drafts candidate `v8`, changing that skill and explaining the change.

The app's CI job fetches `v7` and `v8`, runs both against the same saved PRs, and applies the same grading function. It sends the comparison to Acclimate. The reviewer sees the diff, scores, failures, missing results, and any known costs before promoting `v8`.

<!-- diagram:improvement-loop -->

## 1. Propose a small change

A proposal pins its parent version, requested files, hypothesis, and authorized evidence. An author can submit a diff directly, or call the service's proposer.

The proposer is a bounded background job inside the Rust service using an operator-configured model API. It reads only the selected bundle and evidence, returns suggested file edits, and saves an immutable candidate. The worker reconstructs anchored edits and optional note supersessions, checks bundle growth, and retries invalid edits once. Bundle and app text are fenced as data. For service-managed learning, the configured provider must accept the candidate in a critic screen before development evaluation. A critic rejection permits one fresh attempt. Reviewers can see the recorded verdicts and full before-and-after changes.

Validate allowed paths, file kinds, text/size limits, and bundle schema before saving. A candidate cannot edit plugin code, app settings, credentials, permissions, the grader, or service policy. V1 edits instructions, skills, and reusable memory text; it does not evolve executable harness code.

Cap proposal attempts, concurrency, and output. A timed-out model call can still cost money; retries follow the job's declared limits. Failure leaves the published version unchanged. No edit is published automatically.

## 2. Compare in the application's environment

The optional SDK helper takes ordinary application functions:

```text
compare(baseline, candidate, cases, execute, grade)
    -> per-case results + comparison report
```

`execute` calls the app's native SDK integration. `grade` checks the saved output. These aren't server-hosted plugin types. CI or the app supplies workspaces, fixture services, credentials, resource limits, and isolation appropriate to the workload. Eval runs must use fixtures or otherwise prevent live writes; Acclimate cannot enforce that on a host it doesn't control.

Create the expected case/repetition list before running. Pair both versions on the same snapshots and settings. Record the native SDK/model configuration and grader revision so a file-only change has a meaningful comparison. For nondeterministic tasks, repeat pairs and report sample size; don't present one lucky run as proof.

The report includes:

| Field | Why it matters |
| --- | --- |
| Parent/candidate version and digest | Identifies the exact content tested. |
| Dataset/case revision and expected inventory | Prevents dropping difficult or missing cases. |
| Runtime/model settings and grader identity | Makes changes in the test setup visible. |
| Per-case output refs, grade, status, and known usage | Keeps the aggregate inspectable. |
| Failures, missing grades, uncertainty, and cost completeness | Prevents an incomplete run becoming a win. |

The helper can retry grading a saved output without rerunning the agent or adding a sample. Candidate failures count under the declared rubric; infrastructure or judge failures remain distinct. Missing grades and unknown cost never become zero. Treat untrusted output as data; execute submitted code only in app-provided isolation outside the trusted grader.

## 3. Record evidence honestly

The service validates the report's identity, inventory, finite score values, and references. It records who submitted it. It does not certify that remote execution happened correctly: these are application-reported results.

Show paired results and known costs. A cost-saving claim requires comparable, complete cost evidence. Incomplete reports stay visible but do not produce an automatic acceptance recommendation. Changed candidates or grading rules create new records rather than overwriting old evidence.

For v1, a person interprets the comparison. Defer novelty scores, annealing schedules, automatic multi-candidate search, mandatory sealed audits, and statistical release automation. RRSI remains [research inspiration](../research/rrsi.md), not the default control loop.

## 4. Promote a bundle version

An authorized reviewer selects the candidate, evidence, and expected current channel revision. When evidence is cited, the service verifies that its candidate and parent version IDs and digests match the selected immutable candidate and its declared parent. An evidence-backed promotion also requires the channel’s current version to be that parent. A mismatch is rejected, even if the caller supplies the latest channel revision. The service atomically updates the channel and records the decision and previous version. A conflict requires a new review against the actual current version.

Manual seed versions, edits, or rollbacks can be promoted with an explicit unevaluated reason; they aren't shown as measured improvements. Promotion only changes what later SDK resolutions receive. It doesn't deploy an agent, hot-reload a session, or own the application's rollout.

Rollback points the channel to a retained version through the same recorded operation. Apps decide when to refresh or pin versions.

## Feedback and memory

Feedback submission is opt-in. Send only examples the application is authorized to share; full traces and private session history are not uploaded by default. Keep project/user scope and retention with the evidence.

A learned memory is a proposed text edit with provenance. Private mutable memory remains app-owned; turning it into reusable shared knowledge requires explicit review. Nothing silently accumulates in production memory after each job.
