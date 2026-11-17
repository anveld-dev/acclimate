# Platform engineer: installed-service acceptance

Criteria recorded before execution on 2026-11-17. I am the platform engineer from the original DX review: I need to provision teams, distinguish authority from readiness, recover one evaluator safely, and let readers diagnose delivery without handing out administration.

1. **Authority:** provision separate evaluator, project-reader and actual integration content credentials; validate grants without revealing them. Match capability observations to denied writes and unpublished-content denial, with no unauthorized state change. Evaluation must need no promotion grant.
2. **Installed execution:** install the distributed wheel/starter outside the checkout, run a paired request against owned Rust/PostgreSQL, and inspect IDs/scalars and quality policy separately from release authority.
3. **Diagnostics:** distinguish private permission, malformed JSON, invalid URL, denied access, descriptor mismatch and missing-resource cases. Doctor must neither execute callbacks nor start attempts. All public command output must exclude fixture secrets and private paths.
4. **Uncertain execution:** an owned app callback may report uncertainty; subsequent invocation must refuse callbacks. Once the local app is known to have exited, explicit interruption must preserve its request/attempt and evidence. A running record alone must not claim liveness.
5. **Recovery and rotation:** stop with a complete report privately sealed before submission, restart the service with overlapping same-principal grants, rotate the explicit token, recover using the same fixed physical journal root, request, attempt and operation keys, then revoke the original credential and restart. No callbacks repeat.
6. **Reader delivery:** discover a minimal connection and unknown latest observation using a read-only credential, deny administration, and show coherent latest receipt fields for fresh and old/delayed activity without claiming model consumption.

Explicit exclusions: real JWT/SSO, production deployment, containers, distributed/network storage, provider liveness/termination, and paid/model execution. The existing service binary is hashed; its correspondence to the source commit is not independently attested.

## Result: partial acceptance

I can now follow the operator recipe to provision and recover an evaluator. I would approve its tested single-host POSIX operating model with the documented constraints. I still cannot promise teams self-service evaluator onboarding, remote evaluator liveness, or fully actionable missing-resource diagnostics.

The completed journey used an owned PostgreSQL 16 cluster, the existing Rust service at source commit `63eb588458732fbba53c0969c9b892cf08a572fe`, and the checksummed release at `/private/tmp/acclimate-dx-release-20261117-review-1`. I installed its wheel and extracted starter into a private consumer directory. The installed app retained its actual payment simulator and independent grader; instrumentation counted callback entry and, for the second request, explicitly reported uncertainty. No model/provider was invoked. [Public JSON evidence](platform-engineer.json) contains actual request/attempt/comparison IDs, safe diagnostic codes, reward scalars, release inventory hash and service binary hash.

| Criterion | Outcome | Observed evidence |
| --- | --- | --- |
| Authority | Accepted within machine/API scope | `--check-grants` succeeded without credentials in output. Evaluator had exactly read/write, reader capability reported write false, actual reader start returned 403 and left the request requested. An actual integration content credential could read stable delivery and could not read the unpublished candidate. |
| Installed execution | Accepted | Two cases required four real app callbacks. Parent rewards were 0 and 1; candidate rewards were 1 and 1. Means were 0.5 and 1; policy passed. The stable channel remained on its baseline. |
| Diagnostics | Partial | Distinct `config.permissions`, `config.schema`, `config.url`, `auth.denied`, and `descriptor.mismatch` appeared with zero doctor callbacks and no attempt started. A nonexistent request produced `capabilities.unsupported` with `retry_same_command`; a nonexistent bundle UUID passed bundle-only doctor. |
| Uncertainty | Accepted within owned synchronous app scope | A callback reported `execution.uncertain`, leaving running state. Another invocation refused callbacks. The local command process had exited and no external provider job existed; explicit interrupt preserved its attempt. A later run returned interrupted without callbacks. |
| Rotation/recovery | Accepted within fixed local storage scope | An owned HTTP submission gate rejected three comparison POSTs, leaving a real complete report sealed privately. Overlap grants and one restart preserved both old/new access. Replacing only the token recovered the report without callbacks. Removing the old grant and restarting denied the original token; terminal replay preserved comparison. Request, attempt, operation keys, exact report hash, and physical journal root inode/device stayed unchanged. Four callbacks remained four. |
| Reader delivery | Accepted within machine/API scope | Reader discovered the connection with latest observation null and no credentials. Fresh then delayed receipt fields remained bound to one latest server-received event. Explicit aging of only owned PostgreSQL receive timestamps showed two-hour-old activity, then null after 31 days. Reader credential issuance returned 403 and created no credential. |

## Original review findings revisited

**PLAT-1 is improved but remains a lifecycle limitation.** The runbook and secret-safe validator make the responsible role and exact minimum available rights actionable. The capability endpoint gives a truthful point-in-time check without running an evaluator. Broad project write and static configuration still require platform coordination and restarts; the rehearsal actually required both overlap and final-revocation restarts.

**PLAT-2 remains open.** Running status and `/ready` did not establish evaluator progress. The uncertain app record remained running until explicit interruption. There is no remote heartbeat/progress observation. The test established only that the owned local command had exited, and does not establish provider termination or automatic liveness detection.

**PLAT-3 is addressed for the tested fixed local root.** A fresh installed command process recovered its saved report after service restarts and same-principal rotation with exactly the same physical storage. This is useful operator evidence beyond a source review. It is not a disposable container replacement, filesystem restore, different mount, different principal, or distributed lock qualification. Original recovery journals remain private and retained separately from the deleted database.

**PLAT-4 is addressed at the machine-reader API boundary tested here.** Minimal connection discovery and coherent delivery observations are available with read authority while credential administration is denied. Receipt age remains visible factual activity, never proof of consumption. Human membership/JWT and browser rendering were not tested in this persona and remain outside this acceptance.

**PLAT-5 is improved but incomplete.** Local permissions/schema/URL, access, and descriptor mismatch now have useful distinct categories without leaking fixture tokens or private paths. Missing-resource preflight still needs correction: a missing request is reported as unsupported capabilities with a retry action, and bundle-only doctor does not verify bundle existence. This could send a team toward repeated retries or platform escalation for the wrong reason.

## Reproduction and verification

From the repository root, run:

```sh
/Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 -m scripts.acceptance.dx_personas.platform_engineer --output artifacts/dx-personas-20261117/platform-engineer
```

The complete journey passed against fresh isolated infrastructure. A first fixture attempt correctly failed because its intermediate private intent directory was 0755; the shared fixture was corrected to create all private ancestors as 0700 before the completed acceptance runs. This was fixture setup friction, not a product failure. The final journey additionally checked paired scalar rewards and aged/expired receipt behavior. Private command streams and journals remain in ignored acceptance artifacts. The service stopped and its isolated database directory was removed. No production or ambient credentials, builds, provider calls, commits, or pushes were used by this persona.
