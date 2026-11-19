# Connected learning with five proposal admissions

Can five proposal admissions yield a candidate that passes a one-sided 95% non-inferiority audit with a 3 percentage point margin on held-out LLM CLI support requests? The secondary outcome is the paired audit gain and whether its one-sided 95% lower bound exceeds zero. [Pre-registration](5-admission-preregistration.md)

The first attempt passed calibration and sent one proposal to development before a harness status timeout interrupted the comparison. On the fresh restart, the service stopped at calibration with projected cumulative and audit minimum detectable effects of 11.90 and 11.00 percentage points. Neither attempt reached the audit.

## Setup

The Acclimate service was built from source `d33d7f71552e31606a5b69733c1ba6d584a218c0` with Rust 1.89.0 and a fresh disposable PostgreSQL 18.6 cluster. The grader used Python 3.13.1 and Click 8.5.1 with LLM 0.38 at `46f0461d9b1ea9e898cac8a1d7333ab9bc6c8f7f`. The runner used Node v26.13.1, Codex CLI 0.169.1 for readiness and @openai/codex-sdk 0.169.0 for live inference. Every turn requested `gpt-6-luna` at low reasoning effort. The backend model identity was independently unverified.

The frozen 40 development, 40 audit and 10 field cases, grader, baseline payload and validator matched the previous run's SHA-256 digests. The pre-registration records those digests, the revised runner digest and the matching upstream test digest. All 120 reference arrays and their negative controls passed, as did both upstream encode/decode tests. The interrupted attempt’s published baseline version was `5a654b0c-281c-4d12-a6fc-0aa6314a2848` with resolved digest `sha256:5ae11b8aedac22d0f849f9be2636c9aae891689f9c82858a05b155ee205b92b2`.

The restart installed the same resolved digest as version `a9934ca3-5f5f-41aa-954c-fee9980bb1f8`.

Policy v3 used a 3-point development step margin, fresh cumulative superiority at one-sided 90%, audit non-inferiority at one-sided 95% with a 3-point margin, and a +10-point power target. The service was configured for a cumulative check after one accepted development step, as in the previous run, with one audit cohort and automatic rollout disabled.

## Calibration and projected power

Each A/A comparison completed 80 pairs across 40 cases. The service assigned two repetitions per arm for every prospective comparison. The interrupted attempt's A/A request was `a365aba3-dbe9-487e-aff8-4ddaecfaf7ff`. The restart's request was `77c1d907-5092-4335-b2e7-bf25d156fc60`.

| Calibration measure | Interrupted attempt | Fresh restart |
| --- | ---: | ---: |
| Case-mean flip rate | 17.50% (7/40) | 22.50% (9/40) |
| Cases with a disagreeing repetition | 8 | 10 |
| Calibrated paired SD | 0.27050 | 0.34922 |
| Standard error | 4.28 pp | 5.52 pp |
| Calibration MDE | 9.22 pp | 11.90 pp |

| Gate | Interrupted 80%-power MDE | Interrupted power at +10 pp | Interrupted required cases | Restart 80%-power MDE | Restart power at +10 pp | Restart required cases |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development step | 6.22 pp | 95.87% | 21 | 8.90 pp | 85.33% | 34 |
| Cumulative superiority | 9.22 pp | 84.95% | 35 | 11.90 pp | 69.41% | 57 |
| Audit non-inferiority | 7.85 pp | 91.22% | 29 | 11.00 pp | 74.84% | 47 |

The restart's service decision identified the cumulative gate first. The audit projection also exceeded 10 points.

## Field corrections and proposal admissions

During the interrupted attempt, the published baseline passed 2/10 field cases (`cli-07-1` and `cli-08-7`). The harness submitted all eight failures in frozen order.

| Order | Field case | Correction ID | Proposal outcome | Critic verdict and objections | Development result |
| ---: | --- | --- | --- | --- | --- |
| 1 | `cli-01-7` | `3b14dd9b-dc60-4546-a168-e70c968a34b5` | One admission, proposal `30f82da8-6c54-4dcf-b850-d3c8c9733f71`, succeeded after repair | Initial edit rejected for prescribing a command for the reported case. Repair accepted without objections. | Round `a1dd5fcd-f47d-4d83-a1e6-ce7f70e6661c` reached development. The harness stopped during scoring. |
| 2 | `cli-02-6` | `a74c1be2-caac-4ef0-aa8e-36a8efd6c6c5` | Queued, unadmitted at interruption | — | — |
| 3 | `cli-03-5` | `bb94baae-6589-45a2-9040-a52ea6900ac5` | Queued, unadmitted at interruption | — | — |
| 4 | `cli-04-4` | `9793aaf8-b1bb-4b86-b3aa-762070a2f2f8` | Queued, unadmitted at interruption | — | — |
| 5 | `cli-05-3` | `6181fa43-472d-4833-a784-0908d9021efa` | Queued, unadmitted at interruption | — | — |
| 6 | `cli-06-2` | `99cf8f0f-df95-4a37-93ba-fbafdbb6bb98` | Queued, unadmitted at interruption | — | — |
| 7 | `cli-09-6` | `71bcd8c6-ee63-43bf-b9ce-c00481f08853` | Queued, unadmitted at interruption | — | — |
| 8 | `cli-10-5` | `3b037ee9-02c0-415d-9fe0-3ba0fdbaa8da` | Queued, unadmitted at interruption | — | — |

The sole admission in the interrupted attempt had three proposer calls. The first returned an empty edit list and said it lacked reusable evidence. The second expanded `context.md` with general verification and output guidance plus a command specific to report extraction. The critic rejected the case-specific instruction. The repair dropped that edit and instead changed these sentences in `AGENTS.md`. The critic accepted it.

```diff
-Return the requested command using the specified output format. Do not execute the suggested command.
+Follow the requested output format. Do not execute suggested commands.
```

One admission reached development, zero ended in critic rejection, and four slots went unused in the interrupted attempt. The restart stopped before field evaluation and used zero of five slots. Both attempts left the audit cohort unused. The service requested no operator review.

## Comparisons and decisions

| Attempt and stage | Comparison ID | Parent | Candidate arm | Paired gain | Lower bound | Decision |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Interrupted A/A | `b829834d-c3b8-4468-aa5e-46c2f7da6a2f` | 22/80 baseline | 22/80 same baseline | 0.00 pp | — | Power guard admitted |
| Interrupted development | — | Published baseline | Rephrased guidance | — | — | 121 of 160 turns completed before interruption |
| Interrupted cumulative and audit | — | — | — | — | — | Unevaluated |
| Restart A/A | `98e72cd9-10da-46e9-a224-c2bde2fcb3e1` | 19/80 baseline | 23/80 same baseline | +5.00 pp | — | Cumulative power guard stopped admission |
| Restart development, cumulative and audit | — | — | — | — | — | Unevaluated |

The A/A comparisons estimate baseline noise. Neither attempt yielded a candidate paired gain or a candidate confidence bound. The primary audit decision and secondary superiority analysis are unevaluated.

## Turns, time and deviations

| Segment | Luna turns | Input tokens | Output tokens |
| --- | ---: | ---: | ---: |
| Readiness | 1 | 16,108 | 5 |
| Interrupted attempt A/A | 160 | 2,300,999 | 4,679 |
| Interrupted attempt field | 10 | 147,619 | 299 |
| Interrupted attempt proposer | 3 | 44,060 | 351 |
| Interrupted attempt critic | 2 | 28,985 | 55 |
| Interrupted attempt development | 121 | 1,727,051 | 3,577 |
| Restart A/A | 160 | 2,297,824 | 4,686 |
| **Total** | **457** | **6,562,646** | **13,652** |

Usage was reported for all turns. Readiness through the first database cleanup took 29 min 47 sec. The restart and cleanup took 16 min 28 sec, for 46 min 15 sec of active run time and 46 min 38 sec elapsed including the restart gap. The preregistered full-path projection was 1,331 turns.

- The first attempt exposed a harness error path. A 15-second enrollment status GET timeout escaped the poll loop during development and shut down the service and database in cleanup. The SDK independently logged a transient configuration failure near the same event. The reproduction conditions were an active development evaluation on the disposable service with enrollment status polled every 100 ms. An enrollment GET taking longer than 15 seconds triggered the fatal exit. The source of the slowdown was unverified. The harness switched to one-second polling and at most two retries on a timed-out status read. The restart also logged one transient SDK configuration failure and completed calibration. No service source changed.
- The restart used a fresh database and ran a fresh A/A after the first attempt had already observed a critic verdict. It reused the successful readiness check. The task, grader, baseline and policy settings were unchanged. The amended runner SHA-256 was `47e2809683d6295e5f2a83e841a4718eca490b8be17c461723cf5f67e30c2cc9`. The first attempt's calibration and screening data are reported separately. The terminal power stop ended the restart.
- Readiness emitted the prior PATH-helper warning because the isolated Codex home was under the temporary directory. Lint and builds ran outside the live intervals.

## Comparison with previous experiments

| Measure | First experiment | 30-case replication | Previous 40-case run | Five admissions, interrupted | Five admissions, restart |
| --- | --- | --- | --- | --- | --- |
| Development / audit cases | 30 / 30 | 30 / 30 | 40 / 40 | 40 / 40 | 40 / 40 |
| Repetitions per arm | 1 | 2 | 2 | 2 | 2 |
| A/A case-mean flip rate | 16.67% | 10.00% | 25.00% | 17.50% | 22.50% |
| A/A SE | 8.03 pp | 4.64 pp | 4.28 pp | 4.28 pp | 5.52 pp |
| Calibration MDE | 17.05 pp | 10.04 pp | 9.22 pp | 9.22 pp | 11.90 pp |
| Projected cumulative / audit MDE | — | 11.41 / 10.46 pp | 9.33 / 7.98 pp | 9.22 / 7.85 pp | 11.90 / 11.00 pp |
| Development | +16.67 pp, +4.25 pp bound, passed | Unevaluated | Unevaluated | Interrupted | Unevaluated |
| Audit | 0.00 pp, −13.66 pp bound, rejected | Unevaluated | Unevaluated | Unevaluated | Unevaluated |
| Terminal event | Audit rejection | Cumulative power guard | Critic rejection | Harness timeout | Cumulative power guard |
| Candidate released | No | No | No | No | No |

[First experiment](README.md) · [30-case replication](replication.md) · [Previous 40-case run](40-case.md)

## Conclusion

The experiment produced no audit evidence about non-inferiority or improvement. The only admitted correction demonstrated that the same previously observed field case could pass critic screening on a fresh attempt. The initial edit would have prescribed a command tied directly to the failure. The repair received approval after changing wording in guidance the baseline already contained. Across the two 40-case experiments, the critic's concern about case specificity corresponds to concrete edits. The accepted repair suggests the proposer struggled to add new reusable guidance, while also showing that the critic could approve a low-substance rewrite. These observations are too few to separate proposer quality from critic strictness or establish the value of five admissions.

Both calibrations used identical cases and repetition counts and landed on opposite sides of the power guard. The projections depend on realized baseline variation as a proxy for candidate comparisons. The scope is one pinned CLI, exact parsed Click parameters, one shared model configuration and one audit cohort. The interrupted development comparison and the terminal restart limit what can be learned about subsequent corrections, cumulative gains or release.
