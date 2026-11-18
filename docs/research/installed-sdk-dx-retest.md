# Trying the installed SDK again

Eight developer-role reviewers retried the implementation in this worktree using the locally packaged 0.1.0 release. They exercised independent application directories, a strict TypeScript build, Python packages, a Git pull-request workflow, the native repository starter, the production-built console and field rollback. The standalone review also used the installed Python wheel to compare a search over this repository’s getting-started guide. These are observations from role-played integration sessions. No paid model or external customer application participated.

## Follow-up after the fixes

All eight reviewers repeated their tasks from clean release-package installations. They used local application callbacks, Git and Node tools, a Rust service, PostgreSQL 16 and the production-built console.

| Reviewer | Result on the updated product |
| --- | --- |
| First-hour adopter | A named comparison ran four callbacks across two cases. Repeating it ran zero. The same handle worked for status, checking the policy and exporting evidence. After an app change, an explicit fresh attempt ran four callbacks once. |
| TypeScript integrator | Strict NodeNext source and compiled ESM both loaded. Changing the imported grader stopped the resident worker before submission. A fresh worker recorded 0.25 on both arms with the new revision. An independent reader verified a copied export without loading agent code. |
| Python integrator | A dotted package and its absolute path produced identical descriptors, including transitive imports. Editing a dependency while preserving its timestamp and length stopped a named retry before callbacks or service writes. A separate wheel-only reader retrieved status and verified the evidence online. |
| Eval owner | A known critical regression with missing cost exited 2 from both commands and recorded a failed receipt. A broken grader exited 3, identified the case, repetition, arm and stage, and preserved the fully scored case. |
| CI owner | A PR regression reported the change from 1.0 to 0.5 and the three failed criteria. An explicit retry after a repaired evaluator made one successor. An unavailable receipt store held a passing PR check at exit 1. Restoring it recorded the verdict without another agent call. |
| Console reviewer | The copied Python command recorded a failing verdict. The result survived a reload with the Python command still selected. Publishing required a reason for overriding the reviewed receipts, and release history showed it. Partial evidence kept the evidence-based release action disabled. |
| Native agent developer | The packaged application exported the callbacks the CLI expects. A real repository test failed after a source edit and both revisions changed. Switching the model changed the evaluator revision alone. The installation verifier identified a missing platform binary before starting a turn. |
| Production owner | The job’s saved start receipt established field-audit eligibility. A failing policy paused automatic rollout. Independent approval recorded the exact receipts and reason. Following a later regression, both incident tickets identified the withdrawn and restored releases. |

The final package also passed the issues uncovered during these retries. A full start-event queue returned no receipt until it drained, then the same prepared job sent one event with its original identity and timestamp. A missing native config and an unprotected grading test produced distinct setup errors. The CLIs distinguished a symlinked worker path from a file-mode problem and identified the correct location for an export that overlapped private configuration. The browser reviewer followed the physical-path hint and completed the handoff and release review.

Two operational requirements remain. Run a handoff using the application build that created its descriptor. Retain the private journal for retries and persist accepted start receipts with jobs that need to survive a process restart. The tests exercised local application tools and PostgreSQL. Paid provider behavior and production rollout were outside this verification.

For an existing app, start with the [SDK walkthrough](../getting-started.md). For a PR failure, use the [CI recovery guide](../../examples/ci/README.md). For policy enforcement and rollback, see [evaluator operations](../evaluator-operations.md#policy-receipts).

## Findings that prompted the fixes

### 1. Make it clear what code a result represents

The strongest failure was in a long-running Node evaluator. The developer edited a declared grader dependency to always return 0.25 and called the public loader again in the same process. The grader revision changed. A real Rust/PostgreSQL comparison then recorded 0 and 1, the old grader’s scores, under that new revision. A fresh process using the same files and revision scored 0.25 on both arms. Start a fresh isolated loader when declared executable inputs change, or stop before execution and tell the operator to restart the worker. [Node module loading and hashing](../../packages/sdk/src/evaluation/app-cli.ts)

A Python adapter imported a search function from `engine.py`. The first named comparison scored 1.0. After an edit that broke the search, the descriptor stayed byte-for-byte identical. Reusing the name returned the same request, comparison and 1.0 score, with the agent call count still at two. Giving the run a new name executed the edited code and scored 0.0. Adding `engine.py` to `revision_files` made a subsequent edit change the descriptor. The guide explains this requirement. The CLI gives no indication that the imported implementation is outside the default fingerprint. [Getting started](../getting-started.md) · [Python identity construction](../../python/acclimate/evaluation_app.py)

The native reviewer saw the same problem in the packaged recipe. After wiring its callback exports, changing the source so that its original test failed and changing the model setting both left the public descriptor identical. Binding the frozen source digest and model in the adapter changed the descriptor as expected. The CI reviewer encountered the other half of this problem. With a correctly changed evaluator identity, retrying a terminal failed PR in the same state directory returned `request.intent_mismatch` and advised `fix_config`. A fresh output directory succeeded with the original config. [Native integration](../../examples/native-repository/README.md) · [CI request identity](../../examples/ci/ci.py)

On a repeat invocation, show whether any work ran, which revision was graded, and which files or build identity it covers. Give developers an explicit way to start a fresh attempt on a finished comparison, retaining the protection against repeating uncertain work.

### 2. Tell developers why an eval failed where they run it

A first-hour developer raised a `KeyError` in one callback. The CLI returned exit 2, one of two comparable pairs, and an empty `scores.cases` array. The terminal showed an unknown score and the private journal omitted the exception. In a separate Python app, returning a `datetime` at `output.seenAt` marked both arms as execution failures after both agent calls had completed. The SDK could identify the field and suggest a serializable representation. [Python runner](../../python/acclimate/evaluation.py) · [Result formatting](../../python/acclimate/evaluation_cli.py)

The eval reviewer exercised the public Python commands with a local service transport double. A genuine regression and a grader failure both exited 2 from `compare --policy`. On the same incomplete comparison, `check` exited 3. In a separate complete comparison a critical case fell from 1.0 to 0.0. Missing cost made the top-level verdict indeterminate even though a quality threshold had conclusively failed. The detailed checks retained both facts. In the real Git/Rust/PostgreSQL CI run, the wrapper distinguished `execution_failed` from `quality_failed`, but the PR summary omitted the score drop and three failed checks that were available on stderr. [Policy decision](../../python/acclimate/evaluation_policy.py) · [CI summary](../../examples/ci/ci.py)

Return case, repetition, arm and failing stage in the machine result. Keep exception details on the worker. Carry known policy violations and missing measurements separately into the PR summary.

### 3. Put the decision where the reviewer looks

In the console reviewer’s browser session, both versions scored 0.5 with 2/2 comparable pairs. The copied Python check returned `policy.fail` and exit 2 for that comparison. The console still offered **Review release with this evidence** and asked the developer to share the verdict. The reviewer did not promote the candidate. A separate run with four missing grades correctly showed partial evidence and disabled evidence-based release. Surface a verdict bound to the comparison and policy revision in the review itself, including failed checks and any explicit override. [Console release review](../../apps/console/src/components/improvement-workspace.tsx)

The production reviewer triggered a real automatic rollback in a disposable service. Fresh requests resolved to the restored version. The field job that triggered rollback showed `failed` and no corrections, without the field verdict or rollback. The ticket that introduced the withdrawn version still showed **Rolled out**. Show both what happened to the version and what is serving now, with a link to the rollback evidence. [Outcome lookup](../../src/connected_learning/incident.rs) · [Console labels](../../apps/console/src/components/outcome-lookup.tsx)

## Other places reviewers lost time

| Developer task | What happened |
| --- | --- |
| Load an existing TypeScript or Python application | A strict NodeNext adapter passed `tsc --noEmit`, then `describe` failed to resolve its emitted-file import paths from source. Running from the compiled directory worked. A Python adapter with a package-relative `from .rubric import evaluate` imported normally through Python and failed through the SDK. Both CLI errors pointed generically at dependencies. [Node loader](../../packages/sdk/src/evaluation/app-cli.ts) · [Python loader](../../python/acclimate/evaluation_app.py) |
| Follow up on a headless comparison | `compare --name read-category` worked, then `export --name read-category` returned `config.schema`. Export succeeded after the developer found the generated request under the private journal. A byte-identical scalar export verified in the Node worker, then failed verification in a clean reviewer directory because the CLI demanded a local application. Read-only Python `status` also failed from the project root or with a missing agent dependency before it made a service request. [CLI dispatch](../../python/acclimate/evaluation_cli.py) |
| Start from the console | The console gave an adapter-free application a `describe` command without linking to the three-export contract. Reloading a completed Python comparison switched the displayed check command back to Node. [Setup panel](../../apps/console/src/components/evaluation-setup.tsx) |
| Write the first quality policy | A file containing only `minimumMeanImprovement` returned `policy.invalid` and `fix_config`. The schema requires eight fields. Provide a minimal editable policy beside the command and name missing fields in the diagnostic. [Policy validation](../../python/acclimate/evaluation_policy.py) |
| Wire up a native coding agent | The guide exported a `callbacks` object. The loaded adapter needed named `execute` and `grade` exports. The installation check also passed after omitting optional dependencies, while constructing Codex failed locally because its CLI binaries were missing. [Native guide](../../examples/native-repository/README.md) · [Installation check](../../examples/native-repository/verify-install.mjs) |
| Audit a production job | `prepared.reportStarted()` flushed successfully but returned no receipt to attach to the outcome. Calling the advanced receipt API then created a second start event for that job. A learning-worker module with the wrong export reported `service.unavailable` before making a network call. [Prepared delivery](../../packages/sdk/src/prepare.ts) · [Learning CLI](../../packages/sdk/src/learning/serve-cli.ts) |

## What worked

A clean installed application ran both pinned versions and scored its own outputs. Repeating the same comparison with unchanged inputs avoided additional agent calls. Equal weighting kept three repetitions of an easy task from hiding a regression in a critical case. CI selected the committed bundle even with a dirty checkout. The console displayed completed evidence without a reload, and automatic rollback restored fresh traffic while preserving existing job pins.

The browser retest used the packaged SDK and local application with a temporary correction to the test driver. The checked-in browser step calls the packaging helper without its now-required language argument and otherwise stops before it reaches the product. [Browser step](../../features/steps/console.py) · [Packaging helper](../../scripts/packaging/fixture_application.py)
