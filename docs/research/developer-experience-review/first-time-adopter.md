# First-time adopter review

This is a simulated, source-based persona review, not user research. Reviewed 2026-11-16. Findings describe the current checkout; no live product session or production setup was exercised.

## Persona and job

I maintain a small existing agent application, know my model SDK, and have a handful of failing tasks. I want to keep my agent loop, version its instructions, compare a proposed change against those tasks, and decide whether to release it. I expect one clearly marked path from installation to a meaningful before/after result. I can accept application-owned execution and separate production credentials if the product helps me connect the pieces.

## Journey

1. **Understand the promise.** The README explains that my application retains its SDK, tools, credentials and loop. This fits my need. The next material is repository architecture, cutover records and build/test commands, rather than a user task ([README.md](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/README.md:3)).
2. **Try the product.** The setup guide requires PostgreSQL, Keycloak, HTTPS, machine grants and membership. The deployment guide asks for domains, DNS and explicit private configuration. I must either operate the stack or find an administrator before seeing a first comparison ([development.md](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/docs/development.md:7), [deployment guide](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/deploy/README.md:9)).
3. **Install in my app.** The console asks me to obtain or build a tarball/wheel and configure five variables. The selection IDs are embedded in the copyable recipe, which is helpful ([App setup](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/sdk-setup.tsx:69)).
4. **Verify delivery.** I run a model-free check that reads every prepared file and prints version, digest and count. This proves delivery and cleanup, but my real agent still needs to consume those files ([delivery recipe](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/sdk-setup-recipes.ts:17)).
5. **Request an eval.** The console clearly says configure → run in your app → review evidence. However, its initial selection is the payment simulator; my own evaluator requires public JSON that an as-yet unwritten app adapter must describe ([evaluation form](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/improvement-workspace.tsx:846)).
6. **Execute and assess.** The request copies public intent, not a runnable evaluator. The included runner needs a checkout, another credential, a private journal and a matching installed adapter. I can eventually run its examples, but turning my existing tests into this contract is the largest adoption gap ([eval setup](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/examples/evaluation/README.md:5)).

## Findings

### 1. High — first value is behind production setup, without a clearly separated adopter path

**Observed:** The README's first command block builds/tests the repository; runtime instructions then direct the reader to PostgreSQL, OIDC and public HTTPS. The development guide uses the production identity path even during development. The deployment guide adds DNS, Caddy and private operator configuration ([README.md](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/README.md:16), [development.md](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/docs/development.md:7), [deployment guide](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/deploy/README.md:9)). A deterministic comparison example exists, but is introduced much farther down the development guide ([comparison introduction](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/docs/development.md:65)).

**Persona impact, inferred:** A developer trying to evaluate the concept is presented with platform operations before seeing how Acclimate improves their workflow. A developer with an already deployed service must still navigate operator material to discover their smaller task.

**Recommendation:** Make the README route explicitly to “connect to an existing workspace,” “try an offline paired comparison,” and “operate a deployment.” Move the existing model-free comparison example onto the first-value path. Keep production authentication requirements intact.

**Acceptance criterion:** From the README, an existing-workspace adopter can identify the package, credentials and first command without reading deployment or cutover history; a deployment-free trial prints an explicitly simulated parent/candidate report.

### 2. High — the successful delivery check does not show the next step in my real agent

**Observed:** The primary App setup recipe stages generic files, reads them and cleans up; its expected outcome is pinned version/digest/file count ([basic recipe](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/sdk-setup-recipes.ts:17), [success copy](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/sdk-setup.tsx:224)). Native preparation is mentioned inside the cache/offline disclosure. The more concrete integration guidance lives in a separate document describing fresh sessions and explicit memory context ([App setup detail](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/sdk-setup.tsx:294), [native integration](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/examples/native-integration.md:7)). The optional reporting recipe says to replace a fake child with the app, but does not show a real SDK integration ([reporting instructions](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/sdk-setup.tsx:264)).

**Persona impact, inferred:** I achieve a green file-delivery check and still have to discover which prepared object belongs in my current SDK and when cleanup is safe. This is a missing teaching step, not evidence that the SDK cannot integrate.

**Recommendation:** Follow delivery success with “connect your agent,” a runtime selector, and a minimal installed-package example showing prepare → native session/context → wait → cleanup. Link explicitly to supported generic custom-loop consumption and memory handling.

**Acceptance criterion:** A first-time adopter can adapt one adjacent example to an existing supported agent and explain which content it consumed and why the workspace remains alive until completion.

### 3. High — “my app's installed evaluator” assumes the integration I came to learn

**Observed:** Choosing the custom evaluator presents an initially empty JSON textarea and asks for datasetRevision, graderRevision, runtime config identity and expectedCases ([custom form](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/improvement-workspace.tsx:873)). Documentation describes an InstalledAdapter and runEvaluation extension, while that interface and runner are located under examples; the package index exposes compare/submitComparison and public types, not those runner helpers ([adapter contract](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/examples/evaluation/adapter.ts:5), [eval docs](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/examples/evaluation/README.md:46), [SDK exports](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/packages/sdk/src/index.ts:11)). The included CLI accepts three hardcoded adapter names ([CLI allowlist](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/scripts/evaluate-app.ts:25)).

**Persona impact, inferred:** My existing saved tests are not enough to get started. I must infer how to describe them, claim/finish a request, run both versions, grade outputs and submit evidence. The generic SDK supports building this; the reviewed onboarding does not provide the bridging recipe.

**Recommendation:** Provide a small installed-app evaluator starter with one saved task and two callbacks, a command that prints its public descriptor, and a command that consumes a handoff. Either publish the durable runner helper or explicitly document the low-level request lifecycle needed outside this checkout. Preserve the installed-adapter execution boundary.

**Acceptance criterion:** An external app can implement one task and grader, copy a generated descriptor into the console, execute its resulting request and inspect paired evidence without importing repository-private files or editing the included CLI allowlist.

### 4. High — delivery setup reaches an unexpected second credential gate at evaluation

**Observed:** App setup directs admins to Connections for content-read credentials ([credential guidance](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/sdk-setup.tsx:125)). The evaluator's setup disclosure subsequently explains that those credentials cannot read unpublished candidates or run evaluations; it instructs the developer to ask a service operator for a dedicated machine principal with read/write access ([evaluator credential requirement](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/improvement-workspace.tsx:1362)). The evaluator file also needs that principal ID, token and private journal root ([private config](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/examples/evaluation/README.md:7)).

**Persona impact, inferred:** Having completed “App setup,” I reasonably expect to evaluate this same integration. Instead, I discover a dependency on another person and credential channel after creating the request. In a small team I may be both roles, but still need to work out their distinction.

**Recommendation:** Expose the capability checklist before request creation: delivery access, evaluator access, native runtime access and durable private journal. Offer a precise operator handoff with selected project and required permissions, and link to the actual provisioning steps. Retain least privilege and separate credentials.

**Acceptance criterion:** Before creating my first evaluation request, I can identify the needed evaluator principal and who provisions it. A delivery token is clearly marked insufficient at that stage, without needing to inspect a request disclosure.

### 5. Medium — the default evaluation can be irrelevant to the content being improved

**Observed:** Evaluation state initializes to payment-retry ([initial state](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/improvement-workspace.tsx:171)). Its prerequisite copy correctly says it needs payment-policy.json and checks orchestration, not native agent quality ([form explanation](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/improvement-workspace.tsx:890)). The adapter gives missing/invalid policy zero and changing instruction text alone does not improve its score ([simulator semantics](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/examples/evaluation/README.md:28)). Request creation is enabled based on valid configuration/current base and editing state; this block does not check that the candidate contains that policy file ([create button](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/improvement-workspace.tsx:904)).

**Persona impact, inferred:** A developer can choose the initial default for an ordinary instruction/skill edit and receive an unhelpful zero. The labels reduce the risk of mistaking it for agent quality, but the default still directs the first attempt toward the wrong experiment.

**Recommendation:** Start with an evaluator choice rather than a preselected unrelated simulator. Put checkout examples in an explicit example flow; show known prerequisites and warn when the policy resource is absent. Avoid claiming the service has verified that a custom adapter is installed.

**Acceptance criterion:** A generic instruction bundle cannot accidentally create a payment-policy evaluation through an untouched default; intentionally choosing that example explains which file is needed and which claim its score supports.

### 6. Medium — package acquisition is manual before the copyable setup can work

**Observed:** The console install command contains a placeholder absolute tarball/wheel path and tells the user to obtain the artifact from an admin or build from source ([install flow](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/sdk-setup.tsx:35), [artifact requirement](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/apps/console/src/components/sdk-setup.tsx:69)). The developer guide explains building/packing separate SDK and plugin tarballs and states that no registry publication occurs ([package distribution](/Users/benjaminarmstrong/.t3/worktrees/acclimate/t3-3ec8892b-92c7b0add4ebb142/docs/development.md:53)).

**Persona impact, inferred:** The first copied command is intentionally not executable until I find a package. Combining SDK/plugin versions and matching the source used for eval examples becomes a manual coordination task.

**Recommendation:** Provide an administrator-issued versioned artifact bundle or release download with exact SDK/plugin install commands, checksums and compatible runtime versions. A registry is an option, not a prerequisite for fixing this journey.

**Acceptance criterion:** A workspace's setup handoff identifies an obtainable release and exact matching package filenames; the adopter does not need to learn workspace packaging just to install in an existing app.

## Strengths to retain

- The ownership boundary is clear: my application keeps execution, tools and model credentials.
- App setup has a copyable, selection-specific, model-free delivery check with explicit expected output and cleanup.
- Simulator, file-presence and native evidence are differentiated in the UI and docs. No model-quality claim is implied by the simulator.
- Explicit immutable versions, pinning and independent grading make the comparison model understandable once the integration is complete.
- The request handoff excludes secrets, and recovery guidance explicitly discourages accidental repeat execution.

## Top three changes

1. Add a “first comparison with your existing agent” starter that bridges a native execution callback, saved task, grader, descriptor and request lifecycle.
2. Front-load prerequisites and credential ownership, and separate adopter instructions from platform deployment.
3. Replace the irrelevant initial eval default with an explicit evaluator choice and contextual prerequisites.

## Verification and unknowns

Read the current implementation and its documentation; no applicable AGENTS.md was returned by the repository search. Attempted the offline `example:compare` only behind a `test -d node_modules` guard; dependencies were absent, so the guard exited and the example did not run. No tests, model calls, deployments or browser sessions ran. Findings about likely confusion and abandonment are hypotheses for usability testing. Actual time to deploy, native runtime behavior, displayed visual hierarchy and whether a separate release channel already distributes artifacts remain unverified.
