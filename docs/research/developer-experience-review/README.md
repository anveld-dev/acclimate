# Acclimate developer experience review

Reviewed 2026-11-16 by seven independent agents role-playing different agent developers. This is a simulated, source-based critique, not interviews, measured usability research, or live product qualification. Findings use the current implementation and documentation. Product source was not changed.

The strongest theme is the discontinuity between **delivering content**, **running an existing agent with that content**, and **evaluating a change to it**. Acclimate has substantial machinery for trustworthy versioning and evidence. An adopter still has to assemble too much of the path to a first meaningful custom evaluation, including some recovery behavior implemented only in repository examples.

## Perspectives

| Persona | Job reviewed | Individual report |
| --- | --- | --- |
| First-time adopter | Bring an existing small agent and reach a useful first comparison | [Review](first-time-adopter.md) |
| TypeScript integrator | Install packages and wire execution/grading callbacks into an existing app | [Review](typescript-integrator.md) |
| Python integrator | Deliver content and run behavioral evals from a Python agent | [Review](python-integrator.md) |
| Evaluation researcher | Define reproducible cases, grade paired runs, and interpret evidence | [Review](evaluation-researcher.md) |
| CI/release engineer | Run evals headlessly, gate regressions, review, promote, and roll back | [Review](ci-release-engineer.md) |
| Platform engineer | Provision teams and identities, diagnose execution, and recover failures | [Review](platform-engineer.md) |
| Coding-agent plugin author | Integrate native harnesses into real repositories and verify consumption | [Review](plugin-author.md) |

These are deliberately different adoption scenarios. A platform operator can absorb setup work that would stop an individual developer; a researcher can accept custom analysis that a CI owner needs encoded into a repeatable command. Priorities below reflect the impact on those journeys, not vote counts or measured completion rates.

## Prioritized improvements

### 1. High — make the custom evaluator a supported installed-app integration

The SDK exports `compare`, `submitComparison`, types, and raw lifecycle methods. The durable `runEvaluation` implementation and `InstalledAdapter` contract live under `examples/evaluation`, with journal support outside the public package. The included CLI permits only three built-in adapters. Meanwhile the console's custom flow asks developers for the descriptor their installed evaluator describes.

Evidence: [SDK exports](../../../packages/sdk/src/index.ts), [adapter contract](../../../examples/evaluation/adapter.ts), [durable runner](../../../examples/evaluation/runner.ts), [CLI allowlist](../../../scripts/evaluate-app.ts), [custom configuration form](../../../apps/console/src/components/improvement-workspace.tsx).

**Developer consequence:** implementing a task and grader does not complete the integration. External app developers must also source or implement durable attempts, request matching, exact submission, and recovery. Those are consequential protocol details to ask every adopter to own.

**Recommendation:** ship a supported evaluator entry point or companion package, with an installed-app starter containing a task, execution callback, grader, descriptor export, and handoff consumer. Keep adapter selection local to the app. A request must continue to supply identity and configuration rather than executable code or a remote script URL.

**Acceptance:** a clean external TypeScript app installs release artifacts, supplies its own callbacks, generates public configuration, executes a console-created request, and recovers a lost submission response without importing repository-private source or editing the stock CLI.

### 2. High — connect onboarding into one first-comparison journey

The README leads with repository builds and operating requirements. App setup has a useful model-free delivery check, but its main recipe reads files and cleans up; native agent wiring lives elsewhere. Evaluation later introduces a dedicated read/write evaluator principal that Connections' delivery credentials cannot replace. Those machine grants are loaded into memory at service startup, so provisioning or rotating them currently requires an operator configuration change and restart. The eval form initially selects the payment simulator, whose score depends on `payment-policy.json`, even for an ordinary instruction/skill bundle. The UI accurately labels this simulator, but the initial selection still directs an untouched first attempt toward it.

Evidence: [README](../../../README.md), [development setup](../../development.md), [App setup](../../../apps/console/src/components/sdk-setup.tsx), [generated delivery recipes](../../../apps/console/src/components/sdk-setup-recipes.ts), [startup grants](../../../src/main.rs), [eval initialization and prerequisites](../../../apps/console/src/components/improvement-workspace.tsx), [payment adapter](https://github.com/anveld-dev/acclimate/blob/8297b9ca2c241703c8961ad1ac49ce728b64b333/examples/evaluation/payment.ts).

**Developer consequence:** success at one stage leaves another integration and access prerequisite to discover. A developer may complete delivery, create a request, and only then learn that an operator and a custom runner are needed before it can run.

**Recommendation:** put an adopter path beside the operator path: obtain a versioned release → verify delivery → connect the actual agent → implement one saved task and grader → preflight evaluator permissions/configuration → run both versions → review evidence. Offer a clearly simulated offline trial for evaluating the concept. Require an explicit evaluator choice, remember app-owned configuration, and keep checkout examples contextual. Surface required access before request creation; preserve separate delivery and evaluation credentials.

**Acceptance:** the README and console take an existing-workspace adopter to one meaningful paired task with documented packages and prerequisites, without deployment archaeology. A generic bundle does not acquire a payment-policy eval through an untouched default.

### 3. High for Python adoption — offer orchestration above raw HTTP methods

Python supports delivery and exposes evaluation lifecycle and comparison endpoints. It lacks the higher-level paired comparison and durable runner available in TypeScript source. Its newer evaluation methods also omit the annotations present on older client methods, leaving more wire-schema discovery to the user.

Evidence: [Python guide](../../../python/README.md), [Python client](../../../python/acclimate/client.py), [TypeScript comparison helper](../../../packages/sdk/src/compare.ts), [example request runner](../../../examples/evaluation/runner.ts).

**Developer consequence:** a Python-first team must reproduce orchestration rules or introduce a TypeScript process to use the most complete example path. Endpoint availability alone does not provide the same developer experience.

**Recommendation:** provide a Python task/execute/grade recipe and paired comparison helper, typed request/result shapes, and a documented durable lifecycle. If full orchestration is intentionally TypeScript-only, state that capability boundary early and provide an explicit interoperability recipe.

**Acceptance:** an installed-wheel consumer runs one Python-owned deterministic paired eval, submits bound evidence, and follows documented failure/recovery behavior without porting a TypeScript example by inspection.

### 4. High for CI adoption — distinguish execution status from quality policy

The eval CLI prints a returned request and exits successfully when its promise resolves, including when the returned status is `failed`; only rejected promises set a nonzero exit code. Separately, `completed` legitimately includes fully graded candidates that lose to the parent. The operator CLI provides JSON review and explicit promotion, but no bundled regression policy command.

Evidence: [eval CLI result handling](../../../scripts/evaluate-app.ts), [runner terminal-state handling](../../../examples/evaluation/runner.ts), [operator commands](../../../tools/operator/README.md), [operator implementation](../../../tools/operator/cli.ts).

**Developer consequence:** a CI job that relies on process success can treat a returned failed execution as success. Merely checking `completed` still cannot decide whether a candidate satisfies the team's quality policy.

**Recommendation:** document and test exit semantics for failed/interrupted execution, and provide a separate policy-check command or recipe consuming the exact comparison. Keep quality thresholds explicit: evidence completeness, allowed regressions, required cases, reward changes, and known/unknown cost. Preserve human-controlled or separately authorized promotion.

**Acceptance:** CI examples distinguish transport/protocol failure, failed evaluation, completed losing candidate, and completed policy-passing candidate. The policy step exits predictably and never silently promotes a version.

### 5. Medium — make failures diagnosable and evidence portable

Descriptor mismatch yields a generic message rather than the differing fields. The CLI intentionally redacts errors, but also collapses safe service codes and correlation IDs into a generic failure. A running request exposes no case progress/heartbeat; the console directs the user to app logs. The stock runner stores outputs in a private journal and replaces output references with local `file:` URLs; the console displays those as text. Recovery correctly refuses replay after an execution marker without a complete report, and journals are intentionally bound to their original location.

Evidence: [descriptor matching](../../../examples/evaluation/adapter.ts), [CLI error handling](../../../scripts/evaluate-app.ts), [evaluation lifecycle representation](../../../src/evaluations.rs), [runner persistence and output references](../../../examples/evaluation/runner.ts), [case detail rendering](../../../apps/console/src/components/evaluation-pair-row.tsx), [recovery instructions](../../../examples/evaluation/README.md).

**Developer consequence:** debugging depends on the original evaluator machine and its operator. A teammate or ephemeral CI worker cannot inspect the same private output merely by opening the comparison. Safe refusal to rerun is necessary, but expensive work may require a new request after a crash.

**Recommendation:** expose redacted mismatch paths and stable error/correlation codes; add evaluator-reported progress and last-contact information with honest stale/unknown states; document an authorized artifact export/import or app-owned evidence-store convention. Give CI a durable-volume and retention recipe. Consider checkpointed outcomes as a separately designed feature, retaining unknown execution states rather than claiming exactly-once recovery.

**Acceptance:** an integrator distinguishes wrong credentials, missing resources, descriptor drift, and an uncertain execution without exposing secrets. A second authorized reviewer can inspect an intentionally shared failed-case artifact with its version/case binding. Recovery instructions identify when retry is safe and when interruption/new work is necessary.

### 6. Medium — show native preparation inside an actual repository workflow

Native plugins prepare private temporary working directories containing mapped bundle resources. Native integration instructions use that directory as the session working directory; cleanup removes it. Generic preparation exists, but there is no adjacent end-to-end recipe for composing native resources with an existing coding repository, its pre-existing instructions, and durable outputs.

Evidence: [native integration guide](../../../examples/native-integration.md), [Codex preparation API](../../../packages/codex-plugin/src/index.ts), [shared native file staging](../../../packages/sdk/src/native-files.ts).

**Developer consequence:** the resource-only smoke path is clearer than the common job of modifying an existing codebase. Developers must decide repository staging, instruction precedence, output retention, and cleanup themselves. The documented cleanup lifetime is intentional; this review does not establish a data-loss bug.

**Recommendation:** publish an installed-package repository-task recipe that shows safe composition, conflict handling, app-owned runtime settings, explicit memory context, result extraction, and cleanup after the session ends. Make support/qualification status easy to find for each harness. Example Luna restrictions are not restrictions on arbitrary application-owned runtimes.

**Acceptance:** a developer can run a task against a disposable existing repository with its tools and content intact, identify the pinned bundle used, retain the result, and explain instruction precedence and cleanup ownership.

## Deeper evaluation needs

The researcher did not establish a scoring correctness bug. The console uses paired gradeable outcomes, shows the denominator and missingness, and distinguishes complete evidence from a win or release approval. Preserve those semantics.

The next research-oriented improvements are an explicit metric name/unit/direction, optional component scores and weighting policy, a paired uncertainty/minimum-effect analysis recipe, and a revision-generation convention binding dataset/grader/runtime labels to actual artifacts. Today those remain application responsibilities. They matter for stochastic evals, but should not displace the first custom-eval integration work. See the [researcher report](evaluation-researcher.md).

Other smaller adoption fixes include obtainable versioned SDK/plugin artifacts, declaring the `tsx` dependency used by copied commands, documenting synchronous Python calls in async applications, and separating read-authorized delivery observations from admin-only Connections management. The individual reports provide evidence and acceptance criteria for these items.

## Suggested implementation sequence

1. Ship the installed-app custom evaluator starter and supported orchestration surface; make the README and console lead into it.
2. Add access/configuration preflight, explicit evaluator selection, redacted diagnostics, and CI exit/policy recipes.
3. Bring the Python path to a clearly documented capability level; add real-repository native recipes and artifact sharing/retention guidance.
4. Extend research analysis and longer-running execution visibility after the basic adoption path works.

A useful success test is to give a developer with an existing app one saved failing task and ask them to produce reviewable parent/candidate evidence using the documented release. Observe whether they need repository-internal imports, an undocumented operator intervention, or help interpreting process success. This review predicts those friction points; it does not claim to have measured them.

## Verification and limits

Reviewers inspected current docs, public package surfaces, console source, CLI behavior, and service contracts. The Python reviewer ran 12 model-free tests successfully under Python 3.11.7, using local fixtures; detailed results are in its report. Targeted TypeScript tests and examples could not execute in this worktree because dependencies/`tsx` were absent; no dependency installation was performed for this review. Static findings about CLI behavior were checked against source, not reproduced against a running service.

No browser, paid model, production deployment, external service mutation, promotion, or rollback was exercised. Native runtime consumption, live OIDC/TLS behavior, visual usability, and actual developer completion times remain unverified. The role-play findings are hypotheses backed by implementation evidence; user observation should validate the prioritization.
