# Continuous learning

## Service-managed connected learning

All suffixes below use `/v1/projects/{project}/integrations/{integration}/learning`. The application runs its native agents and graders and retains private inputs, expected answers and traces.

A closed round releases its audit reservation if no complete comparison was recorded. Evaluation execution and review have configurable deadlines, defaulting to 24 hours from execution start and 14 days from entry into review. Replay obligations expire 24 hours after assignment. Expired reviews appear as rejected rounds with the expiry reason. After five consecutive processing errors, the round closes and its last error appears as the rejection reason. Automatic rollout and rollback promotions report `service:connected-learning` as the reviewer.

| Method and suffix | Authority and operation |
| --- | --- |
| `PUT` | A workspace administrator enrolls an enabled connection with a released source channel, separate outcome/evaluator principals, an installation ID, file permissions, proposal allowance, development and audit descriptors and rollout settings. Enabling automatic rollout requires promotion authority. |
| `GET` | Inspect enrollment, remaining audit inventory, delivery target, development incumbent and recent rounds. Protected audit descriptors are available to authorized administrators. |
| `POST /outcomes` | The outcome principal reports `outcomeId`, `status`, `versionId`, `digest`, the observed `deliveryRevision` and optional teaching. A matching `startedReceiptId` identifies a sample for field grading. |
| `POST /corrections` | The outcome principal appends a correction to a recorded outcome. Supply a stable `correctionId`, the original `outcomeId`, and an approved `lesson` or `feedback`. Replay the same contents under the same ID. |
| `GET /work` | The enrolled evaluator fetches its assigned development/audit evaluations and outstanding observation rechecks. |
| `POST /rechecks` | The evaluator submits `correctionId`, current `versionId`, `digest`, `revision`, and `verdict` after privately checking whether the original failure persists. |
| `POST /rounds/{round}/review` | An independent reviewer approves or rejects a qualifying audited candidate. Promotion checks the exact candidate, audit comparison, parent and delivery revision. |
| `POST /field-audits` | The evaluator reports a verdict for the exact job and served release. Historical verdicts stay with their original release. |
| `GET /field-requalifications/{versionId}` | The evaluator obtains the private outcome IDs it must replay before previously withdrawn content can be authorized on the current baseline. |
| `POST /field-requalifications` | The evaluator records the pinned candidate, current baseline revision, outcome ID and majority result of three private replays. |
| `POST /renew` | An administrator submits a stable `renewalId` and numeric `expectedRevision` to increase admissions, append fresh audits, or change development and selection controls at a round boundary. Past audit exposures remain consumed. |
| `POST /restore` | An independent reviewer with promotion authority restores an earlier connection release or adopts the current approved source release under a checked delivery revision. |
| `POST /stop` | Stop learning on the connection. Jobs continue to resolve its last delivered release. |

#### Fixtures, acceptance and mutation

Register descriptors made by `connectedEvaluationDescriptor(app)` from `@acclimate/sdk/learning`. The `installed-v1` fixture protocol hashes the ordered inventory of case IDs, normalized repetitions and canonical hashes of the private inputs and expected answers. The runner also commits to the sorted input fingerprints so the cohort registry can detect reused inputs under different case IDs. The service registers declared cohort identities and binds the fixture commitment to the evaluation request and report. The installed evaluator recomputes the commitment before grading. Audit inputs must be disjoint from exposed development and other audit inputs within the bundle. The application chooses genuinely independent tasks and can supply family fingerprints to register known relationships.

An enrollment may specify `selectionPolicies: { development, audit }`. Each stage accepts a versioned evaluation policy with metric direction, equal-case mean aggregation, minimum mean improvement, maximum regression per case, required cases, and optional absolute threshold, task-failure and monetary limits.

A `requiredCases` entry must occur in every applicable cohort. `protectedCaseThresholds` maps individual case IDs to thresholds. In a cohort containing a named case, every repetition must complete and meet its threshold. Use `minimumRepetitionsPerCase` to require repeated measurements and `minimumCostSavingsUsd` to require savings across the paired jobs. The relevant per-arm costs must be known. The thresholds describe this sample and workload.

Selection policy schema version 2 uses a one-sided normal lower bound on paired gains. Average the repetitions within each case, orient the candidate-minus-parent difference toward improvement, and weight each case equally. The bound is `meanGain - z * max(sampleSD, calibratedSD) / sqrt(caseCount)`. Development requires the bound to exceed `minimumMeanImprovement` (default 0, with `z=1.28155`, 90% confidence). Audit independently requires the bound to exceed `-nonInferiorityMargin` (default 0, with `z=1.64485`, 95% confidence). Version 1 connected policies remain readable and use the same rules with a zero audit margin. For an offline check of a connected policy, pass the stage and the inspected calibrated standard deviation to `checkComparison`. General-purpose version 1 checks without a connected stage retain their original thresholds. Per-case regression and candidate failure limits apply to required cases and cases with named protections.

At enrollment and policy-epoch rotation, the independent development evaluator grades the published baseline against itself before a proposal can be admitted. Inspect `noiseCalibration` for status, the fraction of measured case differences that are nonzero, the standard error, and the approximate detectable effect at 80% development power, `(1.28155 + 0.84162) * SE`. The noise floor is the root mean square of the A/A case differences with one unit-scale pseudo-observation. A warning flags an improvement threshold below the detectable effect. A failed calibration blocks admission until policy renewal.

Both arms retain an explicit result for every expected repetition. The connected SDK retries a missing trial once. A missing grade or infrastructure failure counts as the worse of 0 for higher-is-better, 1 for lower-is-better, and the worst observed reward in that direction. The comparison is incomplete above 15% missing arms or if any pair is absent. Required costs that are unknown route otherwise passing evidence to human review. Supply `development` or `selectionPolicies` in a renewal to start a new epoch at a round boundary. The round retains its decision epoch.

This binary-correctness example requires a lower bound above five points in development and above minus five points on the independent audit.

```json
{
  "development": {
    "schemaVersion": 2, "id": "accuracy-development", "revision": "1",
    "metric": {"name": "correct", "unit": "fraction", "direction": "higher"},
    "aggregation": "equal-case-means", "minimumMeanImprovement": 0.05,
    "maximumCaseRegression": 0, "minimumRepetitionsPerCase": 3,
    "maximumCandidateTaskFailures": 0, "requiredCases": []
  },
  "audit": {
    "schemaVersion": 2, "id": "accuracy-audit", "revision": "1",
    "metric": {"name": "correct", "unit": "fraction", "direction": "higher"},
    "aggregation": "equal-case-means", "minimumMeanImprovement": 0, "nonInferiorityMargin": 0.05,
    "maximumCaseRegression": 0, "minimumRepetitionsPerCase": 3,
    "maximumCandidateTaskFailures": 0, "requiredCases": []
  }
}
```

Existing-file edits are bounded by `permittedPaths`. To permit named skill package creation or retirement, configure `skillPackages: {createSkillNames, retireSkillNames}`. Each list authorizes only its named operation. An omitted policy creates a fixed-file enrollment. On an enrollment update, omission preserves the current policy, and two empty lists turn off structural editing. Change permissions between rounds. For subsequent text edits inside a creatable package, list those files in `permittedPaths`. These entries can be adjusted at the same idle boundary.

For a graded discrepancy, an authorized proposer can return `skillOperations` alongside ordinary anchored edits. A create supplies a name and files with `relativePath` and `text`, including the package's `SKILL.md`. A retirement supplies a name and the expected digest of its existing package. A path-specific lesson constrains changes to its named file. A graded discrepancy can also use `noteOperations` with `{op: "create_note", path, text, supersedes?}`. Enroll both the new `memory/` path and any existing note it replaces in `permittedPaths`. Note text is limited to 4 KiB. Supersession removes the previous note from the candidate and leaves it in the immutable parent. Existing `memory/` notes use supersession. Native compatibility validation applies to every reconstructed candidate.

Each round admits up to `maxCorrectionsPerRound` eligible queued corrections in queue order, default 5 and range 1–10. Admission stops before the escaped proposer request exceeds 64 KiB or the request runs out of evidence slots, leaving the rest queued. One proposal admission is charged and each member consumes an attempt. Inspect `batchSize` and `includedCorrections` for the correction IDs, outcome IDs and attempts. The proposer receives each correction and its provenance, along with bundles and prior attempts, as fenced data. Its JSON response includes a nonempty `rationale`. The service retries malformed or invalid edits once with the reconstruction error under the same admission. Two consecutive format failures close the round with reason `proposal-format-rejected` and refund the included corrections’ attempts and the proposal admission. Candidate growth is limited to the greater of 10% of the encoded parent size and 2 KiB. Operators can set the floor with `ACCLIMATE_PROPOSAL_GROWTH_FLOOR_BYTES`.

Service-managed proposals use the configured provider to screen candidate edits for case-specific data or hard-coding, planted instructions, credentials, and contradictions. A rejection permits one repair with the critic’s objections. A second rejection closes the round with reason `critic-rejected`. An unavailable or invalid critic closes it with reason `critic-unavailable`. Only accepted candidates proceed to development. The proposal API exposes completed screens through `screening`, with each stage, verdict, rationale, and bounded edit excerpts.

The proposer sees a bounded history of prior final outcomes and edit excerpts for the same connection and bundle. Case-level history comes from bound development comparisons. Held-out case details stay private.

#### Development incumbent and cumulative audit

Each enrollment and policy epoch starts its private development chain at the published delivery version. A critic-approved candidate must pass the paired development gate and any required replays against its immediate incumbent before it becomes the next search parent. An accepted step can finish in `developed` while jobs keep serving the published version. The proposal growth cap applies both to each edit and to the cumulative payload relative to the published version.

The service checks cumulative development after three accepted steps by default, or on the accepted step that exhausts admissions. `ACCLIMATE_LEARNING_DRIFT_CHECK_STEPS` and `ACCLIMATE_LEARNING_MAX_STEPS_BETWEEN_AUDITS` each default to 3 and accept integers from 1 to 1,000. The earlier limit sets the checkpoint. Before reserving an audit, the same calibrated development gate must pass against the published delivery baseline. The first step's fresh comparison can serve both roles when it already compares that pair. The audit then compares the cumulative head with the same published baseline using one fresh cohort.

A development step from a private incumbent can reuse parent results from a prior development comparison with the same parent digest, development descriptor and case repetitions, evaluator principal and runtime identities, and policy epoch. An accepted incumbent supplies its candidate results for the next step. Fresh parent results from a subsequent development step can refresh that measurement. The work feed offers `cachedParent` and the comparison records `parentSourceComparisonId` when used. Older evaluators can submit fresh pairs. Reuse defaults to a maximum age of 24 hours at execution start and three comparisons per source. Reuse preserves pairing by case and repetition but removes time-pairing. The epoch's A/A calibration remains the standard-error floor. Cumulative checks against delivery, calibration and audits always measure both arms fresh.

A failed cumulative check resets search to the published checkpoint. Audit failure, review decline, or expiry also resets search there. A successful release starts a new chain at the newly delivered version. Changes to either published channel invalidate the chain, and a source-only change starts search again at the connection's current delivery version. Use the reviewed source restore to adopt the new source version. Each accepted edge and reset is retained with its epoch and timestamp. For a multi-step release, the service evaluates a content-identical direct child of the published baseline and records both version IDs.

Inspect `developmentIncumbent` for the head, chain length, cumulative mean estimate and lower bound when measured for that head, and the next audit trigger. Round fields `developmentParentVersionId` and `developmentCandidateVersionId` show the search edge. `candidateVersionId` identifies the release version once it exists. Separate cumulative request and comparison IDs identify the additional development evidence. For an evaluation of the baseline-rooted copy, `GET /work` marks the development or audit assignment with `cumulative: true`. These requests bind both versions and omit the individual edit's proposal ID.

Search pauses during review because the active round owns the delivery revision, audit reservation, and incumbent checkpoint through the review decision. Extending the chain during review would require atomically rebasing those descendants and renewing their delivery-bound replay obligations on approval, or invalidating them on decline or expiry.

#### Observations and delayed feedback

Each job retains its resolved version and delivery revision. The outcome and each subsequent correction have independent immutable IDs. A correction can outlive its observed revision. When the parent moves or an older outcome lacks revision provenance, the evaluator rechecks the original failure against the current, pinned bundle. `reproduced` admits a fresh parent-bound proposal, `resolved` closes the correction, and `unavailable` leaves it parked on that revision. A complete development rejection allows a bounded second attempt for that correction, subject to proposal budget and remaining audit inventory. Development retries retain their measured evidence. An audit or reviewer rejection closes the attempt to release on that evidence.

#### Field evidence and recovery

Connection-qualified reads use `X-Acclimate-Integration-Id` or a scoped delivery credential. Resolution returns the logical channel and the connection's delivery revision and version. A field sample binds an accepted outcome to a matching fresh channel-started receipt accepted within the prior 30 days. The service returns `fieldAudit: { parentVersionId, parentDigest }` when it has an eligible comparison control. Use the exact returned control, including when several releases have shipped since it was validated.

The evaluator sends `outcomeId`, `startedReceiptId`, `versionId`, `digest`, `revision`, `parentVersionId`, `parentDigest` and a `win`, `loss` or `tie` verdict. A win means only the served release was correct. A loss means only the control was correct. Legacy `pass` and `regression` are accepted and retained outside the sequential test. Identical retries return the original result.

For each release and control, the sequential probability ratio test compares loss rates of 50% and 75% among discordant pairs. Its log likelihood is `losses * ln(1.5) + wins * ln(0.5)`. The first boundary ends the test. At nominal alpha 0.05 and beta 0.20, the upper boundary `ln(16)` permits automatic withdrawal and rollback, while the lower boundary `ln(0.20 / 0.95)` validates the release. Ties provide no directional evidence. Historical verdicts remain bound to their original release and cannot move present traffic. Each restore creates a new delivery revision.

To requalify previously withdrawn bytes, the enrolled evaluator looks up the candidate version and reads the `pendingOutcomeIds`, `failedOutcomeIds` and `baselineRevision`. Replay each required private outcome three times using the exact candidate. Submit `{versionId, digest, baselineRevision, outcomeId, verdict, attempts}` with three `attempts` set to `pass` or `regression`. The aggregate passes only with at least two passing attempts. Each result binds that case, candidate and baseline. Managed promotion and manual restore check these obligations. The private replay callback can complete this work through its normal evaluator polling loop.

For a reviewed restore, send `{restoreId, expectedRevision, target: {kind, revision, versionId}, reason}`. Delivery and target revisions are canonical decimal strings. Pin a prior managed release with `kind: "delivery"` or the currently approved release on the enrollment's source channel with `kind: "source"`. Retain the request ID for exact retries. Read eligible `restoreTargets` from the enrollment. The request reason is nonempty and at most 1,024 bytes. A successful response is a promotion on the connection's private channel. Replaying the same restore ID and body as its original reviewer returns that promotion. Restoring an enabled, stopped connection leaves its learner stopped.

[Evaluator installation and reporting](../docs/evaluator-operations.md#serve-connected-learning) · [Operator setup and upgrade](../deploy/README.md#operate-connected-learning)

#### Outcome lookup and incident replay

`GET /v1/projects/{project}/integrations/{integration}/learning/outcomes/{outcome}` requires project read access and returns only this connection's receipt metadata and correction states. The response contains `outcomeId`, terminal `status`, `versionId`, nullable `deliveryRevision`, `receivedAt` and `corrections`. Each correction carries its ID, current state, latest round ID and reason when available, and nullable `incidentReplay`. The lookup also supplies the enrollment’s bundle and source channel for navigation and the current delivery version and revision. The `servedRelease` and each correction’s `release` identify their original promotions with a `withdrawn` flag and optional rollback promotion, restored version and restored revision. A recorded `fieldAudit` identifies its control version, verdict and whether it triggered the rollback. A correction can retain a promoted round after its release was withdrawn. Where available, candidate and request IDs identify the development and audit evidence. Private teaching and traces are omitted.

Send `requireIncidentReplay: true` with a lesson or feedback on an outcome or subsequent correction to require a private reproducer. Omitting the flag preserves existing policy. All rounds for this correction require a passing candidate replay before the independent audit and rollout. The evaluator's `/work` response includes `incidentReplays` with `roundId`, `outcomeId`, candidate `versionId` and `digest`, and `baselineRevision`. Post those fields with `verdict` and the three private `attempts` to `/learning/incident-replays` using the enrolled evaluator. Allowed verdicts are `pass`, `regression` and `unavailable`. At least two passes make the aggregate pass. At least two unavailable attempts make it unavailable. Everything else is a regression. Exact retries recover previous verdicts. Conflicting verdicts, mismatched identities and new submissions for stale assignments are rejected. Round inspection exposes `incidentReplay` as null when no member requires a replay, pass when every required replay passes, or the aggregate pending or failing state. After development passes, a missing verdict expires the round 24 hours after the candidate entered development.

When a candidate has a failed or indeterminate reported quality policy, a manual rollout requires an independent reviewer to acknowledge the current set. The connected review accepts `{approve: true, policyOverride: {reason, receipts: [{comparisonId, policyDigest}]}}`. A changed set returns `409 policy_override_required`. Refresh the candidate’s receipts and review them again. The promotion records the reviewer, reason and acknowledged receipts.

After a manual decision commits, the original reviewer can repeat the same approval or decline. A different reviewer, decision, override reason or receipt set receives `409 review_already_decided`. For a release, the conflict identifies the promotion and shows the recorded reason to reviewers who can read its evidence.
