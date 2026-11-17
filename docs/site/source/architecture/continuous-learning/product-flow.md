# Product flow and console read model

Proposed design, 2026-11-17. This document specifies product behavior; it does not introduce routes, endpoints, permissions, or an installed learner. The application owns execution, task telemetry, local learning state, and its native SDK credentials. The console continues to own content authoring and authorized release review.

## Decision

Keep the existing workspace navigation and bundle pages. Add a scoped **Learning activity** entry inside **Changes** only when a real shared learning projection is available. Learning activity shows the reasons and evidence behind proposed changes; it is not a second content editor or a task runtime. App setup explains how to install the application-owned learner. Connections continues to describe delivery and credentials, not success or learning quality.

Phase 1 needs no new console backend or campaign page. Local campaigns remain inspectable through the learner's private status/report interface, and resulting versions/evaluations/releases appear through the existing service interfaces. The console must never infer those local records, read a developer filesystem, or present a model's final response as a successful learning episode.

Existing behavior is described in [console README](../../../apps/console/README.md), implemented by [scoped route](../../../apps/console/src/routes/w.$.tsx), [navigation](../../../apps/console/src/navigation.ts), and [connection authorization](../../../apps/console/src/server/integration-core.ts). The [second-pass review](../../research/continuous-harness-review/second-pass/README.md) supplies the concept distinctions this design preserves.

## Vocabulary shown to users

A **task outcome** is an app-reported result of a logical task attempt. A **lesson** is a proposed reusable correction whose scope and authority still need admission. An **experiment** compares a saved candidate against an incumbent under a frozen protocol. A **selection decision** chooses what the search retains; a **release decision** determines what future app jobs receive.

Use plain labels: “Delivery reported,” “Task completed,” “Lesson needs review,” “Selected for further testing,” “Audit passed,” and “Released.” Never collapse them into a single “Learning succeeded” badge. A task may complete with a wrong result; a complete experiment may favor the parent; an admissible lesson may not improve measured behavior. Existing jobs remain pinned after release.

## User journey

### 1. Connect the learner through App setup

Extend App setup's existing language-specific recipe with an optional **Improve from task outcomes** section. It explains the selected bundle/channel, supported learner package/version, and the following configuration choices:

- Which application task cohort supplies feedback and which corrections are eligible to teach from.
- What the learner may change: fixed existing files initially; package creation/retirement only when supported and explicitly configured.
- Finite work budget and behavior when spend or execution is unknown.
- Release mode: propose for review by default; an explicitly configured app policy may authorize automatic release later.

The recipe writes no credentials into the page or copied public descriptor. Application provisioning stays outside the browser. Do not reuse a connection receipt token for outcomes, admission, evaluation or promotion; its authority remains delivery reporting only. An integration record is optional, as it is today.

In phase 1 the next action is **Copy learner configuration** or **Open installed runner instructions**, with expected nonsecret output. The page states that copying configuration runs nothing. A local status/report contains campaign identity, current state, next action and artifact references. Resulting evaluation request/comparison IDs link back to existing Changes. No “Connected” badge is based on a copied recipe.

### 2. Inspect real task outcomes

In phase 1, task outcomes are private app artifacts. In phase 2, Learning activity can show a redacted, app-published outcome summary: task family, opaque attempt ID, pinned content/harness reference, terminal state, feedback eligibility, and reported usage completeness. A stable task attempt can have several delivery observations; delivery event counts are not task counts.

An outcome detail separates app-reported task status from any independent grade or correction. It links to an access-controlled app evidence viewer when configured. A missing or unavailable trace is shown as “Evidence unavailable,” not “No failure.” The console does not expose host paths, raw customer prompts or private trace storage URLs by default.

Connections may link to Learning activity for the same bundle/channel when an explicit association exists. It still shows delivery observations independently. An enabled connection or recent `started` receipt never becomes a green “Tasks successful” or “Learner healthy” signal.

### 3. Admit a lesson

A lesson review starts with the proposed reusable change and its intended applicability: task family/customer scope, policy epoch, originating outcome, and who or what supplied the correction. Show the sanitized teaching view before any optional trace detail. Flag supersession and conflicts with active lessons; flags are evidence for review, not a claim that all semantic conflicts were detected.

Actions are **Admit for experiments**, **Reject**, and **Hold for clarification**. Admission permits this approved teaching view to inform a bounded proposal; it does not publish content or authorize broader tools. The immutable decision records reviewer/policy identity, exact lesson artifact digest and scope. A changed lesson requires a new decision. A human approving a risky lesson must still have the configured admission authority; ordinary read access is insufficient.

Phase 1 performs this in the application. Phase 2 displays decisions read-only. Browser admission actions require phase 3's explicit command/acknowledgement path and authorization design; they must not be simulated by updating projection rows.

### 4. Follow experiments and search decisions

Learning activity is a campaign list with the current action first, followed by retained rounds. Selecting a campaign opens a compact summary: objective, target bundle/channel, current incumbent, latest selected candidate, budget state, next action and last app report time. IDs and manifest details live in disclosures.

A round links to its exact saved candidate and existing evaluation view. Show admission source references, hypothesis, mutation summary, frozen parent/candidate treatment identities, invariant evaluator protocol, evidence completeness and observed comparison. Keep every rejected candidate discoverable with its reason. “Selected for further testing” describes the search decision; it does not imply publication.

For audits, show **Not yet used**, **In progress**, **Passed**, **Failed**, or **Unavailable/uncertain**, together with audit epoch and whether its exposure policy still permits use. Detailed protected answers are not included in the routine shared projection. A failed audit has no default “Retry until passed” action. The controller must stop or create a permitted new audit epoch under its policy; reuse must not silently turn audit cases into development data.

### 5. Review and release

The next action after a qualifying audit is **Review release**, linking into the existing saved-snapshot release workflow. Keep the exact candidate, comparison/audit reference, release policy or reviewer, and current channel revision visible. Existing authorization and optimistic concurrency checks remain authoritative.

If search produced a descendant of an incumbent different from the published parent, the controller must prepare the release candidate and its valid published-parent comparison before offering this action. Show the link from the selected search artifact to the release snapshot; identical bytes do not justify silently discarding search provenance. A stale current channel requires a new review/comparison, not automatic replacement of the expected revision.

After publishing, Releases remains the authoritative content release history. Learning activity links to that release and later task outcomes, with no claim that releasing content redeploys the app or changes already-running jobs. Automatic release, when configured, is displayed as a policy-authorized decision with policy identity and evidence, never as an automatic implication of `completed`.

### 6. Pause, stop and recover

Use distinct user states:

| State | User meaning | Offered next action |
| --- | --- | --- |
| Waiting for outcomes | No eligible new feedback has been admitted | Inspect source configuration/status |
| Running experiments | App reports active work | Inspect current experiment |
| Awaiting review | Lesson admission or release needs authority | Open that exact review |
| Budget exhausted | Controller stopped admitting paid work | Review budget/policy in owning app |
| Pause requested | Controller has not confirmed the pause | Inspect acknowledgement; do not display “Paused” |
| Paused, work settled | Controller acknowledged no new work and settled its active work | Resume under current policy |
| Outcome unknown | A dispatch or stop lacks confirmed final state | Reconcile the existing attempt |
| Status stale | No recent app projection is available | Check owning app; retain last known state with its timestamp |

A browser **Request pause** command, if supported in phase 3, closes future admission and waits for application acknowledgement. An evaluation's server-side `interrupted` status is not proof the active model/tool call stopped. The page distinguishes **Stop requested** from **Work settled** and retains unknown spend. A replacement evaluation must not start merely because a request was interrupted.

If the app exposes no remote control, show instructions or a link to its operator interface. Do not render an enabled pause/resume button without a real command capability. Browser refresh, sign-out or navigation never starts/resumes/stops the learner.

## Navigation and route proposal

Keep workspace **Bundles**, **Connections/Delivery**, **Members**, and **Account**. Keep bundle **Content**, **Changes**, **Releases**, and **App setup**. Add Learning activity as a section/link within Changes, not a new global sidebar destination. A bundle-library row may gain a quiet “Needs review” indicator only from shared authorized projection data.

Proposed scoped detail URL: `/w/{project}/bundles/{bundle}/channels/{channel}/learning?campaign={id}&round={id}`. This is a future route, not a current link. It makes scope explicit; remembered workspace selection cannot retarget it. Existing comparison and release links retain their current routing and exact identity bindings. Campaign details can use local sections for Outcomes, Decisions and Experiments rather than additional sidebar pages. Empty states distinguish “No shared learning data” from “No learning has happened.”

## Projection and capability phases

### Phase 1 — application-owned operation

The learner persists private campaign/outcome/admission/decision artifacts and offers local status plus a redacted report export. Existing SDK calls publish content candidates, evaluations and releases. Console App setup documents installation; Changes/Releases show only existing server records. No Learning activity list, fabricated live status, central outcome table or browser control is required for this phase.

A user may deliberately export a redacted report for review. Displaying that export locally is different from uploading it into the workspace; no implicit upload or arbitrary local-path fetch occurs.

### Phase 2 — shared read model

Add one explicit app-published projection contract only after shared inspection is needed. This is a proposed capability, not reuse of the existing receipt endpoint. The projection contains opaque campaign/round/outcome IDs, bundle/channel binding, source controller identity/epoch, monotonic sequence, immutable decision references/digests, coarse state, timestamps and redacted next-action summaries. Validate scope and referenced content/evaluation IDs server-side. Retain publisher identity and received time. Publication must not let the app claim a human approval or release it did not perform.

Require authenticated, separately scoped projection-write authority; it does not grant content-write, admission, evaluation or promote authority. Deduplicate by controller epoch and sequence, reject contradictory payloads at the same identity, and label out-of-order or stale observations. A sequence establishes projection ordering, not proof of honest execution. Immutable artifacts preserve history; the latest projection is a view, never the campaign's execution authority.

Readers inherit explicit workspace access to the published summary. Sensitive task/evidence details may require narrower app permissions and should remain opaque references. A controller must not publish private evidence and rely on the browser to hide it. Revocation prevents future writes/reads according to current authorization; immutable history does not restore revoked rights.

### Phase 3 — delegated commands and browser review

Add browser lesson decisions or pause/resume only with a real owner-authenticated command interface. Commands bind project/bundle/channel, campaign epoch/revision, exact reviewed artifact digest, caller, action and idempotency key. Persist commands and acknowledge them with controller identity and resulting revision; a transport timeout leaves the operation unresolved. Retry/reconcile the same command instead of inventing another action.

Read-model writes cannot impersonate command acknowledgements. Server permission checks and app admission/effect policy both apply. An editor's existing content-write role is not automatically a grant to change learner budgets or outcome sharing. Choose explicit scoped capabilities for those new operations before implementing them; retain existing release authorization rather than widening it silently. The console's saved-write recovery convention applies to submitted decisions and commands.

## Minimum product acceptance checks

1. Without a projection backend, App setup can explain the learner and existing Changes/Releases remain usable; no page claims to see private local state.
2. Two task attempts with several delivery events render as two task outcomes, not several successes. A completed but wrongly graded task remains a learning failure.
3. A planted/unadmitted observation cannot be shown as an approved standing lesson. Admission of one artifact never approves a later edited artifact.
4. A complete losing comparison remains visible as complete; selection and release labels remain separate. A selected candidate is not displayed as published before a verified promotion.
5. Cross-workspace and unauthorized evidence references are refused. Sensitive artifacts never appear in public projection fields or copied configuration.
6. Out-of-order projections cannot replace a newer campaign state; stale projections show their age and preserve uncertainty.
7. Requesting pause followed by a timeout retains an unresolved command and active/unknown work. Only an acknowledged settlement displays “Paused, work settled.”
8. A stale channel revision blocks release without discarding the reviewed snapshot. After a confirmed release, fresh jobs may resolve it while already-prepared jobs stay pinned.

## Implementation sequence

First ship the app-owned learner and its local status/export contract. Update App setup guidance only when the actual installed interface exists. Reuse current content/evaluation/release views for resulting records. Next introduce the authenticated redacted projection and Learning activity read-only; add narrow browser commands last. This ordering gives users a truthful working flow at every stage without making the console an execution platform.
