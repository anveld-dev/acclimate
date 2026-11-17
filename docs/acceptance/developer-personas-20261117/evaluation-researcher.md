# Evaluation researcher acceptance — 2026-11-17

**Overall: partial.** All 16 executable assertions passed against the actual isolated Rust service and PostgreSQL 16 using an independently authored Python application installed from the release wheel. The installed policy resolves the central direction, missingness and unequal repetition arithmetic concerns. The original research needs remain partly unmet: the console still computes per-row means, the application supplies its own content-hash identity conventions, component metrics and stochastic confidence remain outside the product, and this exercise does not qualify arbitrary process-loss recovery or actual second-machine distribution.

This is a persona enactment of the [original evaluation researcher review](../../research/developer-experience-review/evaluation-researcher.md), not observed customer research. The executor is a deliberately simple saved label router. No model calls, statistical significance, genuine safety capability or real model improvement are claimed.

## Criteria fixed before execution

I required a custom executor and independent grader in an installed external app; exact bound parent/candidate evidence; an independently derived equal-case result with unequal repetitions; explicit metric direction; a fully graded losing candidate that completes while its quality gate fails; actual ungraded evidence and unknown costs that cannot falsely pass; exact reconstruction from private manifests; and selected reviewer artifacts verified with a separate read principal. Named component metrics, task-aware uncertainty, genuine second-machine sharing and arbitrary process-loss preservation remained original research requirements rather than assumptions of this fixture.

These criteria were communicated before execution and are retained in the acceptance script and private `evaluation-researcher-criteria.json`. The [public JSON](evaluation-researcher.json) contains criteria, assertions, observed rewards, identities, policy verdicts, source and binary hashes, exit codes, and cleanup results. The [runnable script](../../../scripts/acceptance/dx_personas/evaluation_researcher.py) owns the application and grader source; only the shared service fixture comes from the checkout. The application imports `acclimate` from its private virtual environment, with no SDK checkout imports.

| Criterion | Result | Observed evidence and remaining need |
| --- | --- | --- |
| Installed durable evaluator | Accepted for this run | Own `research_eval.py` and `grader.py`, offline installed wheel, two real bound requests, service-retained exact descriptors and version bindings. Lost response and arbitrary process-loss recovery are outside this persona's observed coverage. |
| Equal case weighting | Accepted for installed policy; console gap remains | Three routine repetitions and one critical repetition yield equal-case loss even though pooled rows improve. The console source still averages rows. |
| Metric direction | Accepted | Same actual report yields oriented improvement −0.30 under `higher` and +0.30 under `lower`. The lower policy is explicitly an alternate arithmetic interpretation, not an acceptable relabeling of correctness. |
| Completion versus quality | Accepted | Fully scored candidate request is `completed`, run exit 0, higher-is-better check exit 2 with `policy.fail`. |
| Missingness | Accepted | Deliberately unavailable critical candidate grade gives `gradingStatus=failed`, null reward, comparison incomplete, failed request, 3/4 comparable pairs, and indeterminate check exit 3. Before execution, check also returns `evidence.not_terminal`, exit 3. |
| Unknown costs | Accepted | The direction demonstration policy passes scalar checks; adding a required maximum cost returns `cost.unknown`, indeterminate, exit 3, four unknown candidate costs and null total. Unknown is not a zero-dollar assertion. |
| Reproducibility | Partial | Repeated installed `describe` exactly reconstructs the descriptor. Independent canonical case hash equals its dataset revision; changing snapshot, settings or grader revision changes configuration identity. This is app-authored hashing, not a new SDK helper that automatically derives private-input revisions. |
| Shared regression evidence | Partial | Four selected critical output/explanation roles export and remain inspectable; 12 routine roles remain `not_shared`. A copied export verifies from an isolated reviewer directory with no journal/app manifest and only a separate read credential/handoff. Both offline consistency and online scalar binding pass. Actual different-machine transfer/access management was not exercised. |
| Component metrics and confidence | Unmet | One scalar with a named policy metric and structured grader explanation is available. A first-class vector of correctness/safety components and a task-aware confidence interval are not implemented here. Deterministic repeats cannot estimate stochastic uncertainty. |

## Concrete scoring observation

The executor reads a routing map from each verified bundle and emits labels for retained private records. The independent grader counts positional label matches against retained expected labels; the executor does not return a requested reward. The parent gets two of five routine labels right, and the candidate gets four of five. The single critical label is right for the parent and wrong for the candidate.

| Case | Repetitions | Parent observed reward | Candidate observed reward | Case improvement, higher is better |
| --- | ---: | ---: | ---: | ---: |
| routine | 3 | 0.40 each | 0.80 each | +0.40 |
| critical | 1 | 1.00 | 0.00 | −1.00 |

Independent calculation over actual returned service rows gives:

```text
parent equal-case mean    = (mean(.4,.4,.4) + mean(1)) / 2 = .70
candidate equal-case mean = (mean(.8,.8,.8) + mean(0)) / 2 = .40
oriented improvement, higher = .40 - .70 = -.30
oriented improvement, lower  = .70 - .40 = +.30

parent pooled row mean    = (.4 + .4 + .4 + 1) / 4 = .55
candidate pooled row mean = (.8 + .8 + .8 + 0) / 4 = .60
```

The installed policy summary matches the independent equal-case calculation within 1e-12 floating-point tolerance. A minimum mean improvement of 0.10 rejects this candidate under the actual higher-is-better correctness policy. The worst case regression is 1.00. The alternate lower-direction policy passes with the allowed maximum regression 1.00, proving direction handling on the same observed values; it does not justify releasing this correctness regression.

[The current console score summary](../../../apps/console/src/lib/evaluation-score-summary.ts) still averages all comparable repetition rows. Its source computes .55 → .60 for these exact rows, whereas the installed equal-case policy computes .70 → .40. This was source-inspected, not browser-rendered. Reviewers need both aggregation labels and a clear connection between policy result and console summary; the original mixed-repetition concern is therefore only partly resolved.

The selected critical parent artifact contains `labels: ["safe"]` and grader explanation `matches: 1, total: 1, reward: 1`. The candidate artifact contains `labels: ["unsafe"]` and explanation `matches: 0, total: 1, reward: 0`. These are deterministic fixture labels, not evidence of real safety behavior. Online verification returns `online_scalar_binding` and explicitly `executionAttested: false`.

## Recorded identity and rerun

Completed losing request: `b6865064-7bfb-4215-8864-5b5df4ed38e8`; attempt `6e4fdae0-b83b-4d5f-bfbf-04946f7b7b73`; comparison `6094eb8b-037a-4327-8337-4c2ddf964838`.

Actual ungraded request: `9bf4c5ab-09a0-44a2-abf6-2040f4ea5a49`; comparison `4cb1b374-666a-4184-9738-2a3cadf3741c`.

Dataset revision: `sha256:3d874ea1217c581a2033a440b6c2a6c4ed9ad34f1a21b50588c3e56189b09f0e`. Grader revision: `sha256:f0fceb1f5e35aa793d99ed961eadb9005fd4f87c895ac08f622dbfaa1b3c0236`. The complete descriptors, private-manifest hash, grader-code hash, app-code hash and changed-input descriptors are in the JSON.

Repository commit is `63eb588458732fbba53c0969c9b892cf08a572fe`. Existing service binary SHA-256 is `ed09e68c2c93497df582c57b5366b312f915dd2625bd5e053d0a7ebad2a8de8a`. The verified release source inventory is `15feab4b46cd8c4d52592fc318cd171a267daa1ec562d4447ae261a16db03f6b`. The binary hash records the tested executable; this run does not attest its compilation from that commit.

```sh
/Users/benjaminarmstrong/.pyenv/versions/3.11.7/bin/python3.11 \
  -m scripts.acceptance.dx_personas.evaluation_researcher \
  --output artifacts/dx-personas-20261117/evaluation-researcher
```

The final execution passed all 16 assertions. Before the final successful run, the fixture's original `private` directory was mode 0755; an intent placed directly in that directory was correctly rejected with `config.permissions` before execution. The script now uses a dedicated private intent directory. The fixture owner also repaired intermediate directory permissions. No product change was made for this setup issue.

All command streams, installed app/manifest/journal and reviewer copy remain beneath the ignored private fixture root. PostgreSQL was removed and the service stopped; both cleanup assertions are true. Public results exclude credentials, private paths, local output references and raw unshared outputs. No build, commit, push or production mutation occurred.
