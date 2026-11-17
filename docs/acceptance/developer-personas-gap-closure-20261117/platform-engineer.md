# Platform engineer: independent installed-release retest

Criteria were set before execution on 2026-11-17. I am the platform engineer from the original review: teams need truthful readiness, a recoverable app-owned evaluator, optional activity observations, and separate reader authority. The original [platform report](../developer-personas-20261117/platform-engineer.md) and JSON remain unchanged.

## Result: accepted within the tested operating scope

The two confirmed doctor defects are closed in the installed wheel. The optional progress contract is also accepted at the machine/API boundary: a real installed application explicitly reported from its execution callback, persisted its own sequences/counts, and remained responsible for execution and interruption. This accepts the single-host POSIX/static-grant operating model tested here. It does not qualify self-service identity onboarding, a remote execution lease, external provider termination, or container/filesystem replacement. Browser rendering is a separate council fixture and is not claimed by this report.

The journey used fresh owned PostgreSQL 16 and the fresh Rust service with migration `0016_evaluation_progress.sql`, using release `/private/tmp/acclimate-dx-release-20261117-gaps-1`. The verified wheel and extracted starter were installed into a private physical consumer directory outside the checkout. Every installed SDK source file matched the wheel; the proof covers 19 files. The app retained the starter's real payment simulator and independent grader. Instrumentation counted callback entry, explicitly reported progress, and exercised one owned uncertainty path. No ambient API credentials, model/provider execution, product edits, package builds, production resources, commits, or pushes were used by this persona.

| Criterion | Independent result | Observed evidence |
| --- | --- | --- |
| Authority | Accepted within machine/API scope | Secret-safe `--check-grants` succeeded. Evaluator had exactly project read/write, with no promotion grant. Reader advertised write false, start returned 403 and left the request requested. Actual integration content-read credentials could read stable content and could not read the unpublished candidate. Reader credential administration returned 403 and created nothing. |
| Installed execution | Accepted | Four actual simulator callbacks evaluated two paired cases. Parent rewards were 0 and 1; candidate rewards were 1 and 1. Means were 0.5 and 1, and the independent quality policy passed. Stable stayed on its original version. |
| Doctor | Accepted | Known bundle was ready. An absent canonical bundle produced `bundle.missing`, `fix_config`, exit 2. An absent request produced `request.missing`, `fix_config`, exit 2. Permission, JSON/schema, URL, denied authority, and descriptor failures remained distinct. All doctor checks made zero callbacks, started zero attempts, and left request/comparison/bundle/version/operation/command/audit counts unchanged. |
| Optional progress | Accepted within machine/API scope | The installed `EvaluationProgressReporter.report` made eight successful explicit reports around four execute callbacks, using app-owned sequences 1–8 and completed counts 0–4. The app wrote request/attempt-bound counters before each call; fresh installed processes reopened them. A separate reader GET observed fresh, stale, and absent activity. Exact replay preserved `receivedAt`, including stale and expired receipts. Foreign principal and wrong attempt returned 409; reader writes returned 403; revoked credentials returned 401. A reporting failure returned false while lifecycle stayed running and callbacks stayed four; recovery subsequently completed. |
| Rotation/recovery | Accepted within the same fixed local root | Three blocked submissions left a complete privately sealed report. Two service restarts exercised overlap and final revocation. Replacing only the explicit token recovered with the same principal, request, attempt, operation keys, exact report hash, and physical root inode/device. Four callbacks remained four. Terminal replay preserved the comparison. |
| Owned uncertainty | Accepted within synchronous app scope | The fifth real callback explicitly raised `execution.uncertain`. A repeated run refused callbacks. Although a just-received progress observation was fresh, the owned process had exited: this directly shows that fresh does not prove liveness. Explicit interruption preserved attempt and observation; status became interrupted and activity stale. A later exact progress retry returned 409 and run still refused callbacks. No provider job existed or was terminated. |
| Reader delivery | Accepted within machine/API scope | Reader discovered the minimal connection and initially unknown observation. A newly received event with an older `occurredAt` stayed coherent as the latest event, rather than mixing maxima from different receipts. Explicit aging of owned database receive timestamps showed two-hour-old activity, then unknown after 31 days. These are application observations, not proof of model consumption. |

## Concrete evidence

[Public JSON](platform-engineer.json) retains the actual progress GET snapshots, safe failure codes, count snapshots, IDs, rewards, installation proof, and cleanup results.

- Paired request: `28c635a9-ec69-471e-9450-bca9f27a2412`; attempt: `f17eb9a7-099a-48f8-9b67-18d7a6a7a747`; comparison: `8d571175-16db-4db7-96c8-5bba404e8eb9`.
- Uncertain request: `033509e2-dfbd-41e6-b8e0-506f0281a2ec`; preserved attempt: `c2e34c4e-be91-40c2-b7d8-da7c234fccfe`.
- Delivery connection: `414d4df3-b61f-4fef-a9fb-73352bb72e1c`; coherent latest event: `1520b7b8-8fce-4199-99eb-1abe1b65fe8b`.
- Release source inventory SHA256: `63b0bc9a1751a7b5bf9e230e7bde81f0801ea7d4946171d628449c575cc6cfbd`.
- Service binary SHA256: `c84d1961249e635c024346fb23328dccf738f0aa7eef0e5e50fa4b00111d2a50`.
- Sealed submit-body SHA256, unchanged through recovery: `ba383a19525bbe76449cd437a752cbb3e784cb573d4d8ca7dc98950b94d237ea`.
- All 31 subprocess exits matched expectations: 19 exit 0, four exit 1, four exit 2, and four exit 3. Expected nonzero exits represent the deliberate diagnostics, submission gate, and uncertainty/interruption scenarios.
- Final owned database: two requests, two retained attempts, one comparison, one bundle, three versions, nine operation records, three command results, eleven audit rows. Progress helper successes, retries and denials left the preexisting lifecycle/operation/command/audit counts unchanged.

Receipt/check timestamps are server supplied. Aging was performed explicitly in this disposable database: 61 seconds for stale progress, expired `expires_at` for absent progress, and two hours/31 days for delivery receipts. These checks do not claim real elapsed waits. `fresh` is a received app assertion; stale or absent never means stopped, cancelled, safe to replay, or available for takeover. Construction/reporting starts no background timer or execution owner. Sequence persistence belongs to the application; this rehearsal does not qualify arbitrary crash recovery of that app state.

The checkout HEAD was `63eb588458732fbba53c0969c9b892cf08a572fe` with gap-closure worktree changes. The source inventory identifies the packaged inputs. The binary hash records the executable used; this persona does not independently attest the binary-to-source build.

## Original findings revisited

**PLAT-1 remains a scoped lifecycle limitation.** Provisioning and exact grants are actionable and tested, but static machine grants require coordinated restarts and broad project write. Human JWT/SSO/self-service onboarding was excluded.

**PLAT-2's missing activity observation is closed within the opt-in contract.** Actual installed callback reports and separate reader GETs now show received activity and truthful unknown states. This supplies diagnosis, not a remote execution lease, termination detector, automatic heartbeat, or takeover authority. Owned uncertainty still requires an explicit app/operator decision.

**PLAT-3 remains accepted for the fixed physical local journal root.** Recovery preserved the privately sealed report, operation keys, request, attempt, comparison and callback count across same-principal rotation and both restarts. Different storage, restores, mounts, containers, principals and distributed locks remain unqualified.

**PLAT-4 remains accepted at the machine-reader boundary.** Minimal connection discovery, coherent latest receipt facts, and separate read authority passed. Browser rendering is independently handled by the council fixture.

**PLAT-5's confirmed missing-resource defects are closed.** Bundle existence is actually checked and missing requests no longer masquerade as unsupported capability. Both failures produce the right safe code, `fix_config`, exit 2, without changing state or executing callbacks.

## Reproduction and cleanup

```sh
ACCLIMATE_PERSONA_RELEASE=/private/tmp/acclimate-dx-release-20261117-gaps-1 \
ACCLIMATE_PERSONA_SOURCE_SHA256=63b0bc9a1751a7b5bf9e230e7bde81f0801ea7d4946171d628449c575cc6cfbd \
/Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 \
  -m scripts.acceptance.dx_personas.platform_engineer \
  --output /private/tmp/acclimate-platform-gap-retest-20261117
```

The service stopped and the isolated PostgreSQL directory was removed. Private command streams, app-owned sequence state, original recovery journals and fixture cleanup evidence remain beneath `/private/tmp/acclimate-platform-gap-retest-20261117`. Public output was checked against every fixture credential and private fixture path. The old reports were preserved.
