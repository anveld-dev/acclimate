# CI, quality policy, and evidence handoff design

Design proposal for council integration, 2026-11-16. This is a source-grounded proposal, not implemented or runtime-qualified behavior. It addresses the [CI review](../../../research/developer-experience-review/ci-release-engineer.md) and [researcher review](../../../research/developer-experience-review/evaluation-researcher.md).

## Recommendation and seam

Keep three independent results: an evaluation's lifecycle state, an application-owned policy verdict over a comparison, and a deliberate release decision. Publish a pure policy module and a private evidence-export module beside the supported runner. The runner reports execution; it does not choose a quality threshold. The policy module never invokes callbacks, modifies an evaluation, or promotes a channel. Evidence export creates a separate sidecar over a sealed comparison and never rewrites its outcome references.

These modules provide depth: callers supply their task/grade behavior and policy; implementation owns inventory validation, paired calculation, deterministic diagnostics, artifact selection and hashing. The policy seam is in-process. The evidence seam has local-substitutable filesystem dependencies and the existing remote-owned client for optional online verification. Third-party artifact storage is the application's adapter; no new hosted evidence store is needed in this milestone.

### Current source anchors

- `scripts/evaluate-app.ts:58–64`: all resolved evaluation results currently print success; only rejected promises change exit status.
- `examples/evaluation/runner.ts:88–99`: completed/failed return normally; interrupted and ambiguous execution are distinct recovery failures.
- `src/evaluations.rs:293–319`: `completed` means the bound comparison is complete; otherwise `failed`. Quality is deliberately absent.
- `packages/sdk/src/types.ts:72–113`: fixed case/repetition identities, scalar finite rewards, separate execution/grading status, optional cost, immutable comparison identity.
- `packages/sdk/src/compare.ts:130–158,205–214,230–259`: isolated paired inputs, retained infrastructure failures, grading retries without execution replay.
- `apps/console/src/lib/evaluation-score-summary.ts:5–33`: current display averages gradeable paired repetitions. `evaluation-pairs.ts:21–28` includes scored task failures and excludes infrastructure/missing grades.
- `examples/evaluation/runner.ts:123–132` and `journal.ts:100–118`: private local output files, sealed report, original absolute root.
- `tools/operator/cli.ts:13–20,199–253`: review and explicit release/rollback already exist; retain them.
- `packages/sdk/src/client.ts:46–58,181–189`: SDK has structured status/code/request ID that the current CLI drops.

## 1. CLI contract

The concrete launcher is the application's installed, statically wired evaluator entrypoint; it can use the core council's selected CLI wrapper. The following example assumes `node dist/evaluate.mjs` imports its adapter from local application code. No command reads an adapter/module/path/URL from a service request or dynamically discovers plugins.

```sh
# Public descriptor and private preflight are covered by the onboarding lane.
node dist/evaluate.mjs run --handoff request.json --config /private/evaluator.json

# Pure policy calculation uses fetched immutable evidence and a trusted repo policy.
node dist/evaluate.mjs check --config /private/evaluator.json \
  --handoff request.json --comparison UUID --descriptor eval-public.json --policy eval-policy.json

# Export from the private local journal with an explicit application redactor.
node dist/evaluate.mjs export --config /private/evaluator.json \
  --bundle UUID --request UUID --comparison UUID --out /private/review-export

# Local verification never fetches arbitrary output references.
node dist/evaluate.mjs verify-export --manifest /private/review-export/manifest.json
```

All normal command results are exactly one bounded JSON object on stdout. Stable structured failures are one JSON object on stderr. Progress uses stderr only when explicitly requested and never prints raw callback errors, paths, private configuration or model outputs. `run` results identify `requestId`, `attemptId` when known, `status`, `comparisonId`, `nextAction`, and `executionCertainty`; they do not contain raw runtime configuration. A structured result remains available on a nonzero terminal exit.

### Exit semantics

| Command | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| `run` | Confirmed terminal `completed`, including a fully scored loss | Usage/config/auth/transport/protocol error with safe category | Confirmed terminal `failed` / incomplete evidence | Confirmed interrupted, ownership/recovery obstruction, or uncertain execution requiring inspection |
| `check` | `pass` | Invalid policy, malformed/tampered comparison, access/transport error | `fail`: valid complete evidence violates policy | `indeterminate`: incomplete evidence, required cost unknown, numeric analysis unavailable, untrusted offline provenance |
| `export` | Export completed and manifest committed | Invalid selection, redactor/export error, access/transport error | Reserved | Evidence selection unavailable, e.g. comparison not yet known or local outputs missing; no misleading complete export |
| `verify-export` | All declared local hashes and bindings consistent | Malformed manifest, traversal/symlink/duplicate entry or hash mismatch | Reserved | Source authenticity unavailable; caller requested online verification but cannot establish it |

The distinct JSON `code` and `phase` are authoritative within each command; exit numbers are only coarse scripting categories. A transport error before confirmed execution can be exit 1 while a transport error after an execution-started marker is classified as recovery-required exit 3. This phase distinction takes precedence over a generic network category. A lost submission response with a durable report is `nextAction: "retry_same_command"` only within the documented idempotency recovery window below; ambiguous callbacks are `nextAction: "inspect_then_interrupt"`. Do not infer a safe retry merely from exit 1.

Signals retain conventional process semantics if the process is killed (130 for SIGINT, 143 for SIGTERM where the shell supplies them). A managed graceful cancellation may return exit 3 after persisting a truthful stopped/uncertain state. CI uses `if: always()` for explicit artifact export after failed checks. No wrapper catches a forced kill and pretends a confirmed terminal result exists.

Error envelope: `{schemaVersion:1, command, error:{code, phase, requestId?, httpStatus?, nextAction, executionCertainty}}`. Codes come from an allowlist, never from arbitrary remote prose. Request IDs are bounded printable identifiers; malformed remote IDs are omitted. Unexpected exceptions map to `internal_error`; their raw message and stack stay out of stdout/stderr. Examples include `config.invalid_schema`, `auth.denied`, `descriptor.mismatch`, `request.interrupted`, `journal.ownership_busy`, `execution.uncertain`, `submission.unconfirmed`, `policy.invalid`, `evidence.incomplete`, `analysis.nonfinite`, and `artifact.hash_mismatch`.

Changing existing checkout `evaluate:app` exit behavior is intentional and documented in release notes. Its JSON success fields remain additive-compatible. Applications importing the runner keep receiving a structured result rather than having the library call `process.exit`.

## 2. Pure quality policy

Suggested export: `checkComparison({comparison, expected, descriptor, policy}): PolicyVerdict`. The coordinator may place it under `@acclimate/sdk/evaluation` or a companion package, but it must be callable without filesystem, credentials, native peers, or network. It accepts a validated immutable `Comparison`, an independently supplied expected identity, the app's trusted expected public descriptor, and an explicit policy. It does not trust a supplied `comparison.complete` boolean without recomputing completeness from inventory/outcomes.

```ts
interface ComparisonExpectation {
  comparisonId: string;
  parent: { versionId: string; digest: string };
  candidate: { versionId: string; digest: string };
  binding: { requestId: string; attemptId: string } | null;
}

interface EvaluationPolicyV1 {
  schemaVersion: 1;
  id: string;
  revision: string;
  metric: { name: string; unit: string; direction: 'higher' | 'lower' };
  aggregation: 'equal-case-means';
  minimumMeanImprovement: number;
  maximumCaseRegression: number;
  minimumCandidateMean?: number; // metric direction applies
  requiredCases: string[];
  maximumCandidateTaskFailures?: number;
  cost?: { maximumCandidateUsd?: number; maximumIncreaseUsd?: number };
}

interface PolicyVerdict {
  schemaVersion: 1;
  verdict: 'pass' | 'fail' | 'indeterminate';
  policy: { id: string; revision: string };
  comparisonId: string;
  checks: Array<{ code: string; result: 'pass' | 'fail' | 'unknown' }>;
  counts: { distinctCases: number; expectedPairs: number; comparablePairs: number };
  summary: {
    parentMean: number | null; candidateMean: number | null;
    orientedMeanImprovement: number | null; worstCaseRegression: number | null;
    candidateCostUsd: number | null;
  };
  interpretation: 'descriptive-policy-check';
}
```

`minimumCandidateMean` is interpreted as a floor for higher-is-better metrics and a ceiling for lower-is-better metrics; the final schema should rename it to `candidateThreshold` if the council finds that clearer. `minimumMeanImprovement` may be negative to intentionally permit bounded aggregate regression. `maximumCaseRegression` is finite and nonnegative; `0` means no case-mean regression. Required-case IDs are unique and nonempty. Task-failure and cost bounds are finite/nonnegative. Unknown fields, duplicate keys in input files, unsupported schema/aggregation values, and nonfinite numbers are rejected. No implicit defaults choose reward direction or acceptable regression.

### Inventory and identity gates

1. Match the expected descriptor structurally: dataset/grader revisions, full public runtime map and expanded case/repetition inventory. Ignore JSON object-key ordering, preserve exact string/number values and array membership semantics. Duplicate inventory keys are invalid. The descriptor comes from the trusted app checkout, never from the comparison alone.
2. Verify comparison ID, parent/candidate IDs/digests and evaluation binding against `expected`, never derive the expected identity from the comparison being checked. The CLI's first-release path is bound requests: fetch the selected request under the handoff's exact configured service/project/bundle, then derive expected parent/candidate/attempt from that authoritative request. Require its comparison ID to equal the explicitly selected comparison ID. Fetch both versions to confirm bundle membership and digests. Missing/wrong request/attempt binding is rejected. The pure module can support explicit legacy direct expectations with `binding: null`, labeling them `direct`; direct CLI selection is deferred until it has an equally explicit independent parent/candidate expectation.
3. Require every declared pair exactly once, both outcomes present, no unexpected pair, no infrastructure failures, and finite scored grades. Missing never becomes zero. Any incomplete evidence produces `indeterminate` even when the observed subset looks excellent.
4. Require every `requiredCases` entry in the expected inventory. An absent required case is a policy mismatch (`fail`), not evidence that the omitted case passed. A descriptor/policy authoring mismatch can be diagnosed before paid execution.

### Calculation

- For each distinct case `c`, average all declared repetitions separately for parent `P_c` and candidate `C_c`. Both sides use the same fixed inventory.
- Define orientation `s = +1` for higher-is-better, `-1` for lower-is-better. Per-case improvement is `D_c = s * (C_c - P_c)`. Aggregate improvement is the equal-weight mean of `D_c` across distinct cases. Thus extra repetitions of one case improve measurement within that case but do not silently increase its policy weight.
- Pass the aggregate rule iff mean improvement is at least `minimumMeanImprovement`. Pass each-case protection iff every `D_c >= -maximumCaseRegression`. Pass the optional candidate threshold iff oriented candidate mean is at least the oriented threshold.
- Scored task failures remain gradeable, matching the wire contract. If the application also wants a hard failure-count limit, count candidate outcomes with `executionStatus: "task_failed"` across declared repetitions and apply `maximumCandidateTaskFailures` separately. Do not silently reinterpret them as infrastructure failures.
- Cost rules sum reported candidate `costUsd` over all declared candidate outcomes; an increase rule also needs all parent costs. Missing costs make the applicable rule unknown and the verdict `indeterminate`; a zero cost bound does not convert unknown to zero. With no cost rule, unknown cost is reported but does not block a verdict. Known failures plus unknown rules yield final `indeterminate` with visible failed checks, rather than overstating a fully evaluated policy.
- Numeric iteration order is bytewise UTF-8 case ID order, then numeric repetition order. Use explicitly specified sequential IEEE-754 double operations, not locale order, Python version-dependent `sum` improvements, or a language-specific compensated reduction. Nonfinite intermediate arithmetic produces `analysis.nonfinite` and `indeterminate`, not an exception leak or a fabricated score. Threshold comparison is inclusive with no hidden tolerance; policy authors choose explicit tolerances through their numeric limits.
- Output includes individual rule results, distinct-task count and pair count. It never uses the words statistically significant, confidence, probability of improvement, or pass rate unless a separate explicit metric defines that meaning.

The existing console descriptive summary remains a per-pair mean in this milestone. Label it accordingly. A policy verdict displays its separate `equal-case-means` aggregation and direction. Never silently change historical summary semantics or turn a lower scalar into a regression when the policy metric is lower-is-better.

### Example policy

```json
{
  "schemaVersion": 1,
  "id": "retry-review-ci",
  "revision": "1",
  "metric": { "name": "rubric reward", "unit": "points", "direction": "higher" },
  "aggregation": "equal-case-means",
  "minimumMeanImprovement": 0,
  "maximumCaseRegression": 0,
  "requiredCases": ["checkout-retry", "checkout-keyed"],
  "maximumCandidateTaskFailures": 0
}
```

The example is an explicit conservative application choice, not an Acclimate default or universal claim that zero aggregate loss is sufficient for release.

## 3. Provenance and offline checks

The online `check` command validates that the handoff's exact service/project matches the private configuration, fetches the selected request and immutable comparison using that configured trusted service and credentials, validates exact selected project/bundle/comparison/request/attempt and version identity as above, and checks it against the app's expected descriptor. It never accepts a service URL, policy or expected identity from an untrusted outcome reference. It serializes a **private** input snapshot once to bytes and hashes those exact bytes, not a cross-language reserialization. The snapshot contains the policy bytes, descriptor bytes, comparison export bytes, expected identity, verdict and versioned checker identity. SHA-256 is integrity metadata, not a server signature.

A `check-offline` option is follow-on unless the implementation also includes the provenance rules below. It must never accept an arbitrary uploaded manifest as proof of service evidence.

- Offline checking recomputes file hashes and validates all semantic identities. A trusted expected snapshot digest must come from outside the bundle (for example, a protected earlier CI step or an authenticated artifact record). A digest copied from the same manifest gives self-consistency only.
- Without that external trust anchor, analysis may be shown as `unverified-local-assertion`, but a CI-facing verdict is `indeterminate` and cannot be presented as an authenticated comparison check.
- With a trusted digest, it is `verified-capture`: evidence that these bytes match the trusted capture, not an execution attestation or proof the grader is correct.
- Policy identity is both human `id/revision` and digest of exact file bytes. Descriptor identity is similarly exact-file digest plus structural comparison. Do not invent a canonical cross-language JSON hash protocol in this milestone.
- Promotion always refetches/validates service-side evidence and current channel revision through the existing authorized operator command. Neither local snapshots nor gate exit codes authorize or perform release.

## 4. Evidence sharing sidecar

Keep private attempt recovery and shared review artifacts separate. The sealed submitted report, its bytes and idempotency keys never change to add share links. Existing `file:` output references remain as historical app assertions. The sidecar maps immutable comparison/case/side identities to an explicitly exported artifact. It is not included in the service report body or its replay fingerprint.

### Manifest shape

```ts
interface ReviewManifestV1 {
  schemaVersion: 1;
  kind: 'acclimate-review-export';
  projectId: string;
  bundleId: string;
  requestId: string | null;
  attemptId: string | null;
  comparisonId: string;
  parent: { versionId: string; digest: string };
  candidate: { versionId: string; digest: string };
  projection: { file: 'comparison-review.json'; sha256: string; bytes: number };
  entries: Array<{
    caseId: string; repetition: number; side: 'parent' | 'candidate';
    availability: 'exported' | 'not_shared' | 'missing';
    files: Array<{
      role: 'output' | 'grader-explanation';
      file: string; sha256: string; bytes: number; mediaType: 'application/json' | 'text/plain';
    }>;
  }>;
  exporter: { name: 'acclimate-evidence'; version: string };
}
```

The fixed `comparison-review.json` projection contains only version/digest/request/attempt/comparison IDs, expected inventory, reward/status/usage values and missingness. Exclude raw runtime configuration, arbitrary error strings, original output references, service URL, submitter identifiers, private absolute paths, config files, journals, lock state, raw logs and credentials. It includes all declared cases so omission is visible. A missing local artifact produces `missing`, never an empty output or a fake exported marker.

The source comparison is **not** copied wholesale into the sharing bundle because app-reported errors/runtime/output refs can contain private strings. The online verifier fetches the original comparison from the user's configured trusted service, recomputes the allowlisted projection, and compares identities and values. A shared package without online verification or an externally trusted capture is only self-consistent evidence, explicitly labeled that way.

### Explicit output release

- Default export shares the safe scalar projection and no raw output content. Optional output/explanation artifacts require an application-provided `toReviewArtifact` mapper with an explicit allowlist of selected case/side/role. The mapper returns new bounded text/JSON bytes or `not_shared`; it is responsible for domain-specific redaction.
- The exporter only reads files previously registered by the runner in a private artifact index, bound to this request/attempt/case/side/version. It does not recursively copy a journal or trust arbitrary paths in submitted `outputRef`. The mapper may read raw local content only inside that explicit private workflow.
- Store grading explanations as optional private sidecar artifacts at grade time. Do not add arbitrary grader text to public errors or change the comparison DTO for this milestone. Export of a grader explanation uses the same mapper/allowlist as model outputs.
- An application can still produce sensitive sanitized content. The tool makes no automatic secret-detection guarantee. Documentation requires previewing intended exported artifacts and using an organization-authorized storage ACL; the product never automatically uploads them.
- Export destination is new/private (0700, files 0600), outside journal/config roots. Reject symlinks, nonregular files, duplicate paths, dot/dotdot, case collisions and absolute entries. Generate filenames from a hash of structured identity, never raw case IDs. Manifest committed last; partial exports are visibly incomplete and never overwrite an existing bundle.
- Bound the complete export to 100 MiB, each released artifact to 1 MiB, and manifest to 2 MiB; refuse before committing a complete manifest if limits are exceeded. Support at most 1000 pairs, 2 sides and 2 roles each. The coordinator may tighten limits but must publish one fixed set.
- `verify-export` checks sizes, hashes, identity uniqueness, projected inventory and complete entry coverage before presenting content. It displays text/JSON as inert escaped content. It does not execute HTML/JS, invoke tools, or download external references.

The console initially displays “Artifacts are private/local unless explicitly exported,” plus copyable comparison/case identities and a link to the retrieval recipe. A subsequent explicit local-manifest import view can render verified sanitized artifacts without server storage; that is a separate UI enhancement, not required to claim portable evidence in this milestone.

### CI storage recipe

The example CI workflow creates the export even when `check` fails, then uses the CI provider's existing authenticated artifact-upload step for **only** `/private/review-export`. Never upload the parent private directory, evaluator JSON, journal, model credentials or trusted private input snapshot. The CI provider controls authorization, expiration and audit. Configure explicit retention and identify the artifact by request/comparison ID. A colleague downloads it through that provider, runs local verification, and optionally performs online comparison verification using their own read credential. No new service-held artifact credential is introduced.

## 5. Cancellation, retries, and worker topology

### Durable worker

Use one canonical absolute private journal mount, stable evaluator principal/service URL, POSIX lock support and the published runtime prerequisites. Replace a disposable container while retaining that exact mount and identity. Acquire the existing kernel lock before reading/writing an attempt. Do not delete locks/journals based on PID, age, heartbeat or a pipeline retry number.

### Bounded lifecycle replay

The core service's ordinary lifecycle/comparison idempotency records expire after 24 hours; these routes must not be mistaken for the separately audited retained operation-result routes (`src/commands.rs` route-right selection). A duplicate unknown `createComparison` after retention expiry can receive a new comparison identity even with identical bytes and key. Therefore "durable report" guarantees callback suppression and exact saved bytes, **not** indefinite original comparison-ID recovery.

Persist the first send time for each lifecycle POST before sending it. Recommended first-release automatic recovery budget is 23 hours from that first send, on a worker whose wall-clock error is operationally bounded to five minutes. The one-hour margin covers error at both observations. Negative elapsed time, an untrustworthy clock, missing legacy timestamps, or an expired budget produces `submission.recovery_window_expired`/exit 3 and requires manual inspection; it never silently generates a new key, comparison or paid execution. The coordinator should freeze this operating assumption or choose the still smaller same-process monotonic-only recovery rule. A deployment needing restart recovery without a trustworthy time assumption must add retained service-side receipts in a separately reviewed protocol change.

Read-only request lookup runs first. If it already confirms the terminal attempt and bound comparison, returning that confirmed result does not replay a mutation and is valid after any age. If a known comparison ID was persisted, fetch/verify it before deciding whether finish recovery is possible. Unknown outcome after retention is not solved by editing the journal or pretending a fresh operation is a retry. Manual inspection may identify the committed comparison; it must independently validate identity before recording a recovery result. A heartbeat/progress timestamp never extends idempotency retention.

### Disposable CI worker

Use a unique request for the job and upload only explicit review exports. A fresh worker without the original journal cannot resume a running request. The recipe exposes `status` and an explicitly authorized `interrupt --reason` action using existing lifecycle methods; it does not silently interrupt or create replacement paid work. Request interruption records operator intent, not proof that a detached model process stopped. Confirm/terminate the app-owned worker before approving replacement execution.

| Failure point | Recovery contract |
| --- | --- |
| Before attempt/journal creation | No app callback ran; a new invocation can validate and start normally. |
| Start request response lost, execution marker absent | Same root/principal/attempt/key recovers exact start; no new execution until ownership confirmed. |
| Graceful abort before first callback | Preserve state and classify which marker was persisted; retry only when the implementation can establish no execution started. |
| Any callback in flight, process lost or forced timeout | Execution effect unknown; no replay of that attempt. Inspect external job, then explicit interruption/new request when appropriate. |
| Callbacks complete but report not durably saved | Same conservative unknown rule; do not reconstruct a successful whole report from scattered outputs in this milestone. |
| Exact report saved, submission response lost | Within the bounded replay window, retry same command and persisted submit key/body; callbacks never run again. Beyond it, inspect and refuse automatic resubmission. |
| Submission confirmed, finish response lost | Resolve terminal state read-only first; otherwise retry exact finish within the bounded replay window using persisted comparison ID/key. No resubmission with altered output refs. |
| Report finished, policy check failed | Keep completed comparison; fix content/policy in a new explicit operation. No automatic rerun, release or evidence rewrite. |
| Heartbeat stale or journal lock busy | Liveness/ownership unresolved; no cancel, claim or execution replay inferred from age. |

The runner's cooperative abort signal and timeout policy must stop new scheduling and wait for callbacks to settle before cleanup/releasing owned resources. If the app callback ignores cancellation, the wrapper must not claim cancellation completed; an external hard kill leaves an uncertain attempt. Deadline mechanisms do not guarantee cessation of external side effects.

## 6. File-level implementation and migration

Exact paths depend on the chosen evaluator package; recommended changes:

1. `packages/sdk/src/evaluation/policy.ts`: pure schema validation, structural descriptor match, completeness checks, equal-case policy calculation, safe verdict type. `.../policy.test.ts` via exported interface, using fixture comparisons rather than private functions.
2. `packages/sdk/src/evaluation/cli.ts`: common JSON envelopes and exit mapping. Checkout `scripts/evaluate-app.ts` becomes a statically registered caller, preserving its explicit built-in allowlist and paid `--live` opt-in.
3. `packages/sdk/src/evaluation/artifacts.ts`: private runner artifact index, explicit export mapper, sealed manifest, verification and online projection check. Extract private I/O helpers into package-owned internal code rather than importing `scripts/private-state` from a distributed package.
4. Extend the supported runner's grade callback wrapper to register optional explanation sidecars without mutating `GradeResult`'s wire meaning or sealed reports. Root wire contract remains unchanged in the first milestone.
5. `tools/operator/cli.ts` and README: add request status/interrupt recipes or commands if the central CLI does not expose them; keep release/rollback behavior and authorization unchanged. Retain old error JSON shape as a compatibility field if changing to structured errors; advertise the new schema version.
6. `scripts/packaging/verify.mjs`: installed tarball consumer exercises deterministic run → check pass/fail/indeterminate → export → verify, with no relative imports into this checkout or implicit `npx` downloads. Python wheel uses shared policy/manifest fixtures and the same behavior, not same-language serialized JSON assumptions.
7. `examples/ci/README.md` plus a checked-in model-free workflow/template: explicit application-owned adapter, trusted descriptor/policy files, persistent-worker/disposable-worker variants, failed-check artifact retention, safe release handoff, fixed dependencies.
8. `apps/console/src/components/evaluation-scorecard.tsx` / case rows: label descriptive aggregation and local/private artifact availability, preserving current missingness/grade semantics.

Existing journal schema/root binding stays readable. New artifact indexing is additive and owner-only; old attempts without an index may export projection only, with local outputs marked unavailable rather than scanning legacy directories. No journal rewrite, relocation, resubmission or implicit replay is needed to migrate. Existing comparisons and console views retain their meaning. No database migration is required for the initial policy/export design.

## 7. Acceptance and fault matrix

- A complete winning comparison returns run 0/check 0; a complete loss returns run 0/check 2 under a no-regression policy. A failed/incomplete comparison returns run 2/check 3. A terminal interrupted request returns run 3 and never invokes execution.
- A marker without a report produces recovery-required 3, while a saved report with lost submit/finish response resumes within the documented retention window with exact persisted bytes/keys and zero callback count. Beyond retention, unknown submission refuses automatic replay; a confirmed terminal request still recovers read-only. Missing timestamps and clock uncertainty take the conservative path. Changing sidecar share destinations does not alter report bytes.
- Gate rejects wrong descriptor, project/bundle/comparison/request/attempt binding, duplicate/unexpected cases, malformed outcomes, bad finite flags and false `complete` assertions.
- Missing grade/infrastructure output never counts as zero. A scored task failure affects reward normally and fails only a separately requested task-failure limit.
- Unequal repetition counts produce equal distinct-case policy weights. A lower-is-better fixture reverses orientation correctly. Boundary equality is inclusive. Nonfinite intermediate arithmetic yields indeterminate.
- Cost-limited unknown cost yields indeterminate; no cost rule allows a valid score-only verdict with unknown cost explicitly retained.
- A required-case omission cannot pass. All-missing evidence cannot pass. A tiny stochastic gain produces a descriptive policy result with no confidence claim.
- Export excludes a token-bearing error, private URL/outputRef, raw runtime values and journal/config files by construction. A selected raw output appears only after the explicit redactor returns released content; redactor failure produces no complete manifest.
- Malicious case IDs cannot escape the export root. Symlinks, altered hashes, duplicate manifest entries, oversized artifacts and unsupported media types are rejected.
- A teammate retrieves exported outputs/explanations after the original worker is gone, verifies local hashes and binding, and distinguishes self-consistency from online/trusted-capture provenance.
- Tampering both a local manifest and content cannot create trusted offline provenance. Offline analysis without an externally supplied expected digest is indeterminate for CI and never accepted as promotion evidence.
- Process cancellation cases cover before marker, in-flight callback, after saved report, and lost finish. No state asserts that SIGTERM, a stale heartbeat, or request interruption stopped a model.
- Python/TypeScript conformance fixtures cover numeric ordering, case grouping, statuses, policy reason codes and manifest bytes hashing. Different serialization of an equivalent input is allowed; each digest always refers to actual stored bytes.

## Rejected alternatives and deferred scope

- Automatic promote-on-pass: conflates policy with release authorization and current revision checks.
- Boolean `complete` as quality success: discards losing-but-valid evidence.
- Mean over observed subset with missing as zero: changes experiment and hides infrastructure failures.
- Universal default policy or universal confidence interval: domain assumptions must be explicit; repetitions are clustered within tasks.
- Freely relocatable journal backups, automatic interruption/reexecution, or per-case resume bolted onto this scope: weakens a consequential recovery contract. Per-outcome checkpoints need their own design and tests.
- Rewriting `outputRef` after uploading artifacts: breaks exact immutable report/replay semantics. Use a sidecar.
- Recursive journal upload or transparent fetch of arbitrary output URLs: mixes secrets and untrusted locations into review.
- Server-hosted evidence storage, artifact credentials in the console, signed execution attestation, multiple reward components, and statistical inference: useful separate milestones, unnecessary to solve the immediate handoff.

## Decisions needed during integration

1. Adopt one exit map across the chosen CLI launcher and Python wrapper. The recommended map above distinguishes failure/incomplete/uncertain states while preserving JSON detail.
2. Choose `candidateThreshold` rather than `minimumCandidateMean` if clarity warrants it, and freeze one policy schema before implementation.
3. Agree the public runner's artifact registration seam and optional grader-explanation shape; do not expose journal internals as public interface.
4. Decide whether online policy checking is the only initial supported CI path (recommended) or include the complete trusted-capture offline contract; never offer half-trusted offline success.
5. Decide first-milestone console scope: source/privacy explanation plus retrieval recipe is sufficient; local sanitized manifest import may follow.
