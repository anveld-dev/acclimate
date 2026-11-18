# Continuous learning

## Service-managed connected learning

All suffixes below use `/v1/projects/{project}/integrations/{integration}/learning`. The application runs its native agents and graders and retains private inputs, expected answers and traces.

| Method and suffix | Authority and operation |
| --- | --- |
| `PUT` | A workspace administrator enrolls an enabled connection with a released source channel, separate outcome/evaluator principals, an installation ID, file permissions, proposal allowance, development and audit descriptors and rollout settings. Enabling automatic rollout requires promotion authority. |
| `GET` | Inspect enrollment, remaining audit inventory, delivery target and recent rounds. Protected audit descriptors are available to authorized administrators. |
| `POST /outcomes` | The outcome principal reports `outcomeId`, `status`, `versionId`, `digest`, the observed `deliveryRevision` and optional teaching. A matching `startedReceiptId` identifies a sample for field grading. |
| `POST /corrections` | The outcome principal appends a correction to a recorded outcome. Supply a stable `correctionId`, the original `outcomeId`, and an approved `lesson` or `feedback`. Replay the same contents under the same ID. |
| `GET /work` | The enrolled evaluator fetches its assigned development/audit evaluations and outstanding observation rechecks. |
| `POST /rechecks` | The evaluator submits `correctionId`, current `versionId`, `digest`, `revision`, and `verdict` after privately checking whether the original failure persists. |
| `POST /rounds/{round}/review` | An independent reviewer approves or rejects a qualifying audited candidate. Promotion checks the exact candidate, audit comparison, parent and delivery revision. |
| `POST /field-audits` | The evaluator reports a verdict for the exact job and served release. Historical verdicts stay with their original release. |
| `GET /field-requalifications/{versionId}` | The evaluator obtains the private outcome IDs it must replay before previously withdrawn content can be authorized on the current baseline. |
| `POST /field-requalifications` | The evaluator records the pinned candidate, current baseline revision, outcome ID and result of one private replay. |
| `POST /renew` | An administrator submits a stable `renewalId` and numeric `expectedRevision` to increase admissions, append fresh audits, or change development and selection controls at a round boundary. Past audit exposures remain consumed. |
| `POST /restore` | An independent reviewer with promotion authority restores an earlier connection release or adopts the current approved source release under a checked delivery revision. |
| `POST /stop` | Stop learning on the connection. Jobs continue to resolve its last delivered release. |

#### Fixtures, acceptance and mutation

Register descriptors made by `connectedEvaluationDescriptor(app)` from `@acclimate/sdk/learning`. The `installed-v1` fixture protocol hashes the ordered inventory of case IDs, normalized repetitions and canonical hashes of the private inputs and expected answers. The runner also commits to the sorted input fingerprints so the cohort registry can detect reused inputs under different case IDs. The service registers declared cohort identities and binds the fixture commitment to the evaluation request and report. The installed evaluator recomputes the commitment before grading. Audit inputs must be disjoint from exposed development and other audit inputs within the bundle. The application chooses genuinely independent tasks and can supply family fingerprints to register known relationships.

An enrollment may specify `selectionPolicies: { development, audit }`. Each stage accepts a versioned evaluation policy with metric direction, equal-case mean aggregation, minimum mean improvement, maximum regression per case, required cases, and optional absolute threshold, task-failure and monetary limits.

A `requiredCases` entry must occur in every applicable cohort. `protectedCaseThresholds` maps individual case IDs to thresholds. In a cohort containing a named case, every repetition must complete and meet its threshold. Use `minimumRepetitionsPerCase` to require repeated measurements and `minimumCostSavingsUsd` to require savings across the paired jobs. The relevant per-arm costs must be known. The thresholds describe this sample and workload.

Select an audit policy that permits maintained behavior on a saturated protected suite if that is the intended qualification criterion. Supply `development` or `selectionPolicies` in a renewal to create a new policy epoch at a round boundary. The round retains the epoch that governed its decision. New enrollments require a positive mean development gain and permit audit ties by default. Both defaults allow zero case-mean regression and zero candidate task failures. Upgraded enrollments preserve their original pairwise, strict-gain behavior until an administrator supplies explicit policies.

For example, a team grading binary correctness can paste the following policy pair into enrollment. Each development and audit case in this example runs three or more repetitions. The development gate requires a five-point gain in mean accuracy, and the audit accepts stable mean accuracy with no drop on any case.

```json
{
  "development": {
    "schemaVersion": 1, "id": "accuracy-development", "revision": "1",
    "metric": {"name": "correct", "unit": "fraction", "direction": "higher"},
    "aggregation": "equal-case-means", "minimumMeanImprovement": 0.05,
    "maximumCaseRegression": 0, "minimumRepetitionsPerCase": 3,
    "maximumCandidateTaskFailures": 0, "requiredCases": []
  },
  "audit": {
    "schemaVersion": 1, "id": "accuracy-audit", "revision": "1",
    "metric": {"name": "correct", "unit": "fraction", "direction": "higher"},
    "aggregation": "equal-case-means", "minimumMeanImprovement": 0,
    "maximumCaseRegression": 0, "minimumRepetitionsPerCase": 3,
    "maximumCandidateTaskFailures": 0, "requiredCases": []
  }
}
```

Existing-file edits are bounded by `permittedPaths`. To permit named skill package creation or retirement, configure `skillPackages: {createSkillNames, retireSkillNames}`. Each list authorizes only its named operation. An omitted policy creates a fixed-file enrollment. On an enrollment update, omission preserves the current policy, and two empty lists turn off structural editing. Change permissions between rounds. For subsequent text edits inside a creatable package, list those files in `permittedPaths`. These entries can be adjusted at the same idle boundary.

For a graded discrepancy, an authorized proposer can return `skillOperations` alongside ordinary anchored edits. A create supplies a name and files with `relativePath` and `text`, including the package's `SKILL.md`. A retirement supplies a name and the expected digest of its existing package. A path-specific lesson constrains changes to its named file. Native compatibility validation applies to the reconstructed candidate. An unchanged candidate ends the proposal before a development or audit request is issued.

#### Observations and delayed feedback

Each job retains its resolved version and delivery revision. The outcome and each subsequent correction have independent immutable IDs. A correction can outlive its observed revision. When the parent moves or an older outcome lacks revision provenance, the evaluator rechecks the original failure against the current, pinned bundle. `reproduced` admits a fresh parent-bound proposal, `resolved` closes the correction, and `unavailable` leaves it parked on that revision. A complete development rejection allows a bounded second attempt for that correction, subject to proposal budget and remaining audit inventory. Development retries retain their measured evidence. An audit or reviewer rejection closes the attempt to release on that evidence.

#### Field evidence and recovery

Connection-qualified reads use `X-Acclimate-Integration-Id` or a scoped delivery credential. Resolution returns the logical channel and the connection's delivery revision and version. A field sample binds an accepted outcome to a matching fresh channel-started receipt accepted within the prior 30 days. The service returns `fieldAudit: { parentVersionId, parentDigest }` when it has an eligible comparison control. Use the exact returned control, including when several releases have shipped since it was validated.

The evaluator sends `outcomeId`, `startedReceiptId`, `versionId`, `digest`, `revision`, `parentVersionId`, `parentDigest` and a `pass` or `regression` verdict. A retry with identical contents returns the original result. The latest ten accepted verdicts form the release's field window. With automatic rollback enabled, three regressions in the current release's window can change delivery transactionally. A late verdict for a superseded release updates its historical assessment and can require requalification of those bytes before reuse. It cannot move present traffic. Each restore creates a new delivery revision.

To requalify previously withdrawn bytes, the enrolled evaluator looks up the candidate version and reads the `pendingOutcomeIds`, `failedOutcomeIds` and `baselineRevision`. Replay each required private outcome using the exact candidate. Submit `{versionId, digest, baselineRevision, outcomeId, verdict}` with `verdict` set to `pass` or `regression`. Each result binds that case, candidate and baseline. Managed promotion and manual restore check these obligations. The private replay callback can complete this work through its normal evaluator polling loop.

For a reviewed restore, send `{restoreId, expectedRevision, target: {kind, revision, versionId}, reason}`. Delivery and target revisions are canonical decimal strings. Pin a prior managed release with `kind: "delivery"` or the currently approved release on the enrollment's source channel with `kind: "source"`. Retain the request ID for exact retries. Read eligible `restoreTargets` from the enrollment. The request reason is nonempty and at most 1,024 bytes. A successful response is a promotion on the connection's private channel. Replaying the same restore ID and body as its original reviewer returns that promotion. Restoring an enabled, stopped connection leaves its learner stopped.

[Evaluator installation and reporting](../docs/evaluator-operations.md#serve-connected-learning) · [Operator setup and upgrade](../deploy/README.md#operate-connected-learning)

#### Outcome lookup and incident replay

`GET /v1/projects/{project}/integrations/{integration}/learning/outcomes/{outcome}` requires project read access and returns only this connection's receipt metadata and correction states. The response contains `outcomeId`, terminal `status`, `versionId`, nullable `deliveryRevision`, `receivedAt` and `corrections`. Each correction carries its ID, current state, latest round ID and reason when available, and nullable `incidentReplay`. The lookup also supplies the enrollment’s bundle and source channel for navigation and the current delivery version and revision. The `servedRelease` and each correction’s `release` identify their original promotions with a `withdrawn` flag and optional rollback promotion, restored version and restored revision. A recorded `fieldAudit` identifies its control version, verdict and whether it triggered the rollback. A correction can retain a promoted round after its release was withdrawn. Where available, candidate and request IDs identify the development and audit evidence. Private teaching and traces are omitted.

Send `requireIncidentReplay: true` with a lesson or feedback on an outcome or subsequent correction to require a private reproducer. Omitting the flag preserves existing policy. All rounds for this correction require a passing candidate replay before the independent audit and rollout. The evaluator's `/work` response includes `incidentReplays` with `roundId`, `outcomeId`, candidate `versionId` and `digest`, and `baselineRevision`. Post those fields with `verdict` to `/learning/incident-replays` using the enrolled evaluator. Allowed verdicts are `pass`, `regression` and `unavailable`. Exact retries recover previous verdicts. Conflicting verdicts, mismatched identities and new submissions for stale assignments are rejected. Round inspection exposes `incidentReplay` as null, pending, or its recorded verdict. After development passes, a missing verdict expires the round 24 hours after the candidate entered development.

When a candidate has a failed or indeterminate reported quality policy, a manual rollout requires an independent reviewer to acknowledge the current set. The connected review accepts `{approve: true, policyOverride: {reason, receipts: [{comparisonId, policyDigest}]}}`. A changed set returns `409 policy_override_required`. Refresh the candidate’s receipts and review them again. The promotion records the reviewer, reason and acknowledged receipts.

After a manual decision commits, the original reviewer can repeat the same approval or decline. A different reviewer, decision, override reason or receipt set receives `409 review_already_decided`. For a release, the conflict identifies the promotion and shows the recorded reason to reviewers who can read its evidence.
