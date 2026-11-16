# Information architecture review — round 3

## Scope and observed baseline

Inspected all eight desktop and eight 390px mobile captures under `artifacts/layout2-capture-final-2/screenshots`, plus selected evidence and both final release dialogs. Read `ImprovementWorkspace`, `SdkSetup`, the evaluation configuration/handoff helpers, and round 2's workflow review. This is an independent product-flow review; it is not a request to redesign already usable editor chrome.

The current shell and directory pages are coherent. Workspace navigation, bundle/channel scope, Content/Changes/Releases/App setup, file selection and bundle-wide saved generation are distinguishable. Sparse library, member and connection views reflect sparse fixtures. Their whitespace is acceptable. The editor is already a useful working surface and should not lose width or source visibility to a permanent instructional sidebar.

## Material remaining issue

The first evaluation request currently defaults to the checkout's Payment retry simulator for every bundle. Its prerequisite (`payment-policy.json` data) and limited meaning appear *after* the Create evaluation request button. An unfamiliar user can freeze a valid request without seeing that their chosen evaluator is only an example, requires specific content, and does not test their native agent's quality. This is an information-order issue in the decision itself; more compact borders do not resolve it.

Move the selected evaluator's truthful purpose, prerequisites and execution boundary before request creation. An explicit choice between the app's installed evaluator and named checkout examples is preferable to an unexplained example default. Do not invent installation/compatibility detection, mark an app ready without evidence, or silently run a model. Preserve the existing public descriptor validation and exact frozen configuration.

The request handoff must read as a concrete next task. For a requested evaluation, the user needs request ID + public configuration + the fact that their installed app executes it. An included checkout command needs its real separate evaluator credential/setup boundary adjacent to it. Content-read delivery credentials cannot run evaluation. Never route a user to ordinary delivery credentials as if those satisfy evaluation access.

## Refinement, not a blocker by itself

The saved-review header uses the same generic sentence before request creation, while waiting/running, and after completed results. A concise state-dependent next action would make the page easier to scan. Prefer showing the existing next operation near the current request, not adding a decorative progress component. Completed comparisons still require deliberate Inspect evidence selection: the console must not pick an arbitrary result or treat completion as endorsement. When evidence is selected, the current full-width evidence-before-history order is correct.

App setup's install → configure access → run delivery check sequence is already understandable. Its useful improvement would be stating what the delivery check does and what follows it: it resolves/prepares the bundle for the app; the app owns runtime integration and evaluation. Copying a recipe must never become a connected/success indicator. The code already exposes package-source instructions, scoped delivery credentials, private settings, real recipes and optional reporting. Preserve those boundaries.

## Acceptance criteria

- Before creating a request, users can identify whether they chose their installed evaluator or a checkout example, read the relevant prerequisites, and understand that creation makes no evaluation/model call.
- Requested/running/completed/interrupted states expose the next honest action without implying hosted execution or live execution knowledge.
- Exact frozen configuration and request identity remain available; a completed result still names its comparison and requires inspection.
- Evidence remains candidate/parent bound. Missing grades, incomplete inventory, unknown cost, stale parents, incompatibility and pending-operation recovery remain visible/actionable where relevant.
- Manual publication remains separate, reason-required, and clearly unsupported by evaluation. Both final dialogs retain bundle/channel/revision, candidate/generation, parent and exact selected support.
- Setup retains real TypeScript/Python commands and private environment requirements, and distinguishes delivery-check success from actual agent behavior.
- Desktop/phone/200% renders must be inspected after implementation. This review will not approve a design from imagegen concepts alone.

## Status

Baseline review complete. The selected-evaluator decision order is the material issue to resolve. Six fresh concepts, peer debate and actual implementation review are pending.

## Initial peer debate

Workflow agrees the selected evaluator's purpose/prerequisites must precede Create. Their challenge is that requiring a new explicit-selection state would broaden behavior unnecessarily. Accepted: preserving the existing default is reasonable if its visible Example label and truthful prerequisites/scope appear immediately after selection and before creation. No automatic capability checks or changed evaluator semantics are necessary.

Developer identified a sharper SDK discovery issue than general collapsed content: the install command for an admin-supplied package is hidden under **Install from this checkout**. That trigger does not promise the instructions a package recipient needs. Prefer **Install the SDK package**, with checkout build details secondary inside, or expose the concise real package installation command. The install/access/check sequence itself remains correct.

Accessibility agrees that content below the fold alone is not a failure. Native 200% is useful comparison evidence for reduced framing, but consequential pre-action context outranks any arbitrary y-position target. Named independent disclosures remain safer than an exclusive/mandatory wizard for people returning to copy, compare or recover work.

Skeptic initially proposed always making change review the first instruction. I challenged that for returning/completed-result users: a universal review-first sentence can be just as stale as today's universal create-request sentence. Resolved in favor of state-aware instruction and a collapsed diff. A concise changed-entry count would be useful, but is optional and must share `ContentDiff`'s exact per-path JSON-entry comparison (including kind); renames remain removal + addition under the existing semantics. The baseline is the published parent, not the last browser save.

## Six fresh concepts inspected directly

Review ranking: **A > C > B**. Setup ranking: **F > E > D**. All six PNGs and their exact prompts have been read; rankings do not approve generated text or code.

- **A:** strongest next-action position and compact utility area. Remove the green success check and success-looking row treatment: an app-reported completion is not verified quality, complete inventory or release approval. Keep the existing real manual reason inside its disclosure; the mockup's floating input is not a new interaction requirement.
- **B:** request master/detail repeats generation, parent, completion, timestamp and request identity across too many surfaces before Inspect evidence. It solves no current information problem and introduces another selection axis. Reject the permanent list/detail split.
- **C:** clearer conceptual grouping than B, but three equal lanes overpromote the manual release path and cost reading order on phone/zoom. There is no single global completed pipeline stage when several requests coexist. Keep only its distinction between saved content, app-reported evidence and human release decision.
- **D:** recipe-first layout puts optional source ahead of install/access prerequisites in reading order and leaves a narrow column holding essential settings. Its generated recipe does not match the actual SDK; no generated code may ship.
- **E:** visible install command is useful, but three columns become a long stack on narrow widths and repeat the step framing. Its `ACCLIMATE_SCOPE` description incorrectly calls a stable identity a directory. The actual SDK's identity and directory constraints must prevail.
- **F:** best coherent install → private settings → model-free check document. Retain the actual replaceable artifact install command and factual expected output. Reject the generated claim that the script verifies SDK/app setup end to end; a delivery check and observed model-free child start do not prove actual agent consumption/behavior. Full environment definitions need not all be permanently expanded if a concise, visible summary names the five required settings and exact definitions stay independently reachable.

Accessibility and I agree on the F hybrid: visible concise required-setting summary, full details independently expandable, real install command, and delivery check output before the long readonly recipe. Maintain the same reading order at desktop, phone and native 200%. No generated code, fake readiness state, forced wizard or hidden actual runtime prerequisites.

Visual independently ranks A>C>B and F>E>D, and accepts the concise five-setting summary over a permanently expanded full table. We agree that A's duplicate utility label + trigger columns add no information; preserve the simpler existing named disclosure rhythm. A's task-first order earns adoption; its decorative success treatment does not.

State-aware review guidance should derive from selected comparison or actual `comparisonId` availability, not `completed` status alone. A completed request with no comparison points to its details/app logs. A selected comparison may still be mismatched/incomplete; instructions must not imply release eligibility until the existing checks establish it. Older reported evidence and active requests can coexist, so all request rows remain reachable.

## Implementation review pending

Recommend A's next-action column and F's concise document structure using existing shared shadcn controls. Await actual implementation and renders, including first-request setup (pre-action prerequisites), requested handoff, reported result, selected evidence, both release dialogs and setup at phone/zoom. No final approval yet.

## Actual implementation review — capture 1

Inspected actual desktop/390px first request, custom configuration, requested/running handoffs, completed evaluation and setup; setup at native 200%; selected evidence; both final release dialogs; TypeScript and Python install states; and the delivery-output section. Read current `SdkSetup`, `ImprovementWorkspace`, `reviewNextStep`, and the successful 55-state capture summary (no failures/browser errors; no paid model calls; publication unchanged).

The material evaluator decision issue is resolved: the selected Example label and exact `payment-policy.json` prerequisite/purpose are visibly before Create on desktop and phone. Custom config explains app-owned execution before creation. The state-aware helper uses actual comparison availability and last-reported state without fabricating eligibility. Inspect evidence is visibly primary on a reported result. The selected evidence remains distinct from final release approval; both final dialogs preserve exact support and target identity.

Setup now exposes the real replaceable package installation command outside checkout build details, a concise and accurate five-setting summary, and factual pinned version/digest/observed child output before the readonly recipe. Phone and zoom keep the correct install → access → check reading order. The longer page is an acceptable consequence of surfacing actual required instructions, not a reason to shrink text or invent readiness.

One remaining copy contradiction was sent to the parent: the running request says **Check your app for current execution status**, immediately followed by **Run in your app with the request ID and frozen public configuration**. The latter can invite a restart despite recorded running work. Prefer it only for requested status; running keeps the existing check-status sentence, while terminal states without evidence keep app-log guidance. Awaiting this narrow refinement/final render before final approval.

## Final information architecture verdict — capture 2

**Approved. No remaining material information architecture objections.**

Inspected the corrected desktop/phone running handoff: it now directs users to check the app, without the contradictory run-again instruction. Inspected completed-result review at desktop/phone/native 200%, first-request setup again, and expanded private-directory details at phone/native 200%. Existing results now precede the named saved-change disclosures, bringing Inspect evidence into the initial zoom viewport while retaining all-file review and immutable snapshot details. First-request setup still keeps review context and evaluator prerequisites before creation.

The successful capture-2 summary records 58 states, no failures/browser errors, zero paid model calls and unchanged publication. The parent reports typecheck, 140 console tests and build passing. Capture 3 is repeating the same UI after an accessibility focus refinement; that remaining focus verification belongs to the accessibility/parent validation, not an unresolved IA objection.

This approval is based on the real implementation and captures, not the six generated concepts. It does not authorize publication or claim that reported completion proves agent quality or release efficacy.
