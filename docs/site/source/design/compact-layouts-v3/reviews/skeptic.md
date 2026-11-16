# Skeptical newcomer review

Reviewer: independent product simplification / first use reviewer.

## Baseline and scope

Reviewed the real `layout2-capture-final-2` desktop draft, content, saved review, selected evidence, SDK setup, library and connections captures, plus the 390 px draft/SDK captures and their corresponding component source. This is an initial review; concept debate and final implementation review remain pending.

The baseline is already substantially compact. The editor begins at 156 px on desktop and 333 px on phone, keeps a useful file rail, and makes unsaved changes explicit. Library rows and the three SDK setup steps are comprehensible. Neither empty space in a sparse library nor a desire for another visual style establishes a product problem. Preserve this baseline unless the new concepts solve a concrete task failure.

## Material findings

### S1 — Review instructions must identify the current next action

Evidence: `desktop-evaluation.png` and `improvement-workspace.tsx` around the saved review summary. The universal instruction “Create a request, run it in your app, then inspect the reported evidence” remains visible after a completed result exists. It promotes new request creation even when the correct next action is to inspect the already reported result; it also fails to distinguish an existing pending request from a new setup.

Small remedy: use truthful state-aware copy: no request → review the saved file changes, then create a request; requested/running without evidence → run/check the existing request in the app; reported result → inspect its evidence. Do not invent running progress or imply that the console executes anything. Keep the current action surfaces and saved generation identity.

Acceptance: the initial no-request view, existing ready-to-run request view and completed-result view each name the available next action accurately. A completed result does not instruct the reviewer to create another request.

### S2 — Evaluation prerequisites must precede request creation

Independently verified peer finding: `improvement-workspace.tsx` places the configuration-specific explanatory paragraph after “Create evaluation request.” For the default payment retry simulator, the required `payment-policy.json` content and orchestration-only purpose can be missed until after mutation. Native evaluator setup/model-call boundaries have the same ordering problem.

Small remedy: move the existing accurate, selected-configuration-specific explanation immediately before the mutation. Preserve configuration choice, app-owned execution, request freeze, and recovery behavior. No inferred installed checks or default changes.

Acceptance: before creating a request, the user can see the selected example's actual prerequisite and limited purpose; changing configuration updates this text before the button.

## Direct peer debate

Workflow and IA challenged the initial proposal to always lead with “review file changes.” Accepted: a returning reviewer with completed evidence should be led toward that existing result. A closed diff is a defensible space-saving choice; it is not a standalone material failure. A factual changed-entry count remains optional, using the same exact-payload semantics as the existing diff and treating a rename consistently as remove/add.

Developer identified an additional small first-use issue: an admin-supplied SDK install command is hidden in a disclosure labelled “Install from this checkout.” A truthful disclosure label covering both package installation and optional checkout build is sufficient; a setup wizard is unwarranted.

## Optional improvements

### O1 — Surface the delivery check success criterion

Step 3 in `sdk-setup.tsx` visibly explains how to run the check and that it makes no model calls. Its useful success criterion—printing version, digest and observed start—is inside “View recipe.” Move or repeat that existing factual sentence into the step introduction so a newcomer knows what to look for. This is a small copy improvement, not grounds for a new integration wizard or a blocker by itself.

### O2 — Saved diff summary is an optional discoverability gain

A factual changed-entry count in “Review file changes” would help orient reviewers. Use the exact saved parent and candidate payloads and the existing diff semantics, without introducing speculative summaries. Leave large diffs expandable so reported evidence remains reachable.

### O3 — SDK installation label should cover supplied packages

Rename the existing disclosure so a user with an admin-supplied archive can find its install command. Keep checkout build instructions as a secondary path within it. This is a focused copy fix.

### O4 — Empty state and library are sufficient

The source already explains bundles in plain language, gives a single “Create your first bundle” action, and distinguishes reader access. Populated library rows expose names and channels. Do not add fabricated readiness labels, recent activity, setup completion, evaluation scores, token counts or analytics just to fill space. Adding summaries here needs actual user value and available truthful data.

## Rejected scope

- Do not replace app-owned execution with a console “Run” action, inferred health status, or a fake progress step.
- Do not rename immutable saved generations merely to avoid all domain terms. The generation number distinguishes saved content from unsaved browser edits and makes recovery precise.
- Do not remove evidence provenance, completeness/missingness, manual release reasons, pinned release review identity, or unresolved-operation recovery. These are meaningful decision boundaries, not clutter.
- Do not expand every disclosure. Essential decision content should be visible; raw JSON, IDs, offline/cache mechanics and recovery details can remain expandable.
- Do not compress below 14 px or reduce phone targets below 44 px to win screenshots.
- Do not rebuild navigation, add dashboards, or create a new backend solely to make another concept feel different.

## Final review criteria

1. Initial saved review names the current next action accurately; selected evaluation prerequisites precede request creation.
2. First-use SDK setup retains real install/access/run instructions and app ownership, with no invented success claim.
3. Mobile keeps the saved versus unsaved distinction and an identifiable next action without simultaneous duplicate controls.
4. Broad visual changes must solve an observed failure; unchanged working screens are a valid result.
5. Final screenshots and implementation—not generated concepts—must satisfy these criteria. Existing passing behavior checks are useful regression evidence but do not alone settle discoverability.

## Concept debate

All six actual image renders reviewed (`images/a.png` through `images/f.png`). Generated visuals are design evidence, never implementation source.

| Concept | Skeptical verdict |
| --- | --- |
| A: next decision first | Best review principle: state-aware opening and directly reachable evidence. Reject the olive checkmark and tinted result band: an app-reported completion is not validation. Do not expose a disconnected reason field while manual release remains collapsed. |
| B: request and details | Reject structure. Repeats saved generation/parent/request identity across several regions and consumes considerably more height for one request. Fixed reason select is an invented change to required manual justification. |
| C: task lanes | Reject structure. Equal lanes give manual release competing prominence and force narrow bodies. It retains the incorrect universal create-request opener. No demonstrated benefit over the compact existing review. |
| D: recipe and prerequisites | Reject structure. Essential prerequisites become a side column next to a distracting long recipe. Generated recipe includes fabricated API usage; none may be copied into implementation. |
| E: compact step columns | Reject structure. Narrow columns make real settings and source harder to read; combines optional details into a broad bucket. It incorrectly describes scope as a private directory and contains fabricated recipe methods. |
| F: one useful document | Best setup principle: install/access/check in useful reading order, with required settings visible and long recipe expandable. Keep the real source, exact private-directory rules, explicit replaceable package path, and existing three sections; extra numbered run mini-steps are unnecessary. |

Visual peer independently agrees A/F is the useful direction and flags A’s duplicate utility labels alongside the actual triggers. Accepted: the existing named controls already identify their function; adding a label grid adds repetition. Accessibility/workflow prefer a concise five-variable name/purpose summary with independent full definitions over F’s full default-open table at phone/200%. Accepted: preserve actual setup prerequisites without delaying the recipe behind avoidable prose.

A/F provide modest hierarchy guidance. The result should be a focused refinement of the existing implementation, not wholesale adoption of either rendering.

## Final real implementation review

Current source inspected after implementation: `review-next-step.ts`, review summary, selected evaluator prerequisites and `SdkSetup`. S1/S2 are resolved at source level. Guidance checks actual comparison availability, preserves app-reported status, handles completed/no-comparison and paginated history, and does not claim approval. Selected evaluator prerequisites precede Create and describe the mutation through `aria-describedby`.

SDK keeps the existing three-section document and real recipes. It exposes supplied-package installation with a replaceable absolute path, accurate five-variable prerequisites, independent detailed directory instructions, and expected check output. App ownership and optional reporting/IDs/cache remain intact. No source-level material objection remains. Actual responsive captures remain required before final approval; in particular, verify the visible environment summary has useful phone wrapping without burying the check beneath needless duplication.


### First real capture pass

Inspected actual `artifacts/layout3-capture-1/screenshots` desktop SDK/review, first-request/custom setup, requested/running handoff, selected evidence and both release dialogs; 390 px SDK/review and scrolled expected-output setup; native 200% SDK/review. SDK installation is genuinely actionable before disclosure; private configuration, expected output and real recipes remain clear. Initial/custom evaluator prerequisites are visibly before Create. Selected evidence and final release identities/manual reason remain intact. The unchanged library/editor are justified.

One remaining focused objection in the running handoff: “Check your app for current execution status” is immediately followed by “Run in your app with the request ID and frozen public configuration.” For `running`, this invites a restart while the next action is to check external execution. Use running-specific reference/recovery wording or omit the generic Run instruction; retain Run for `requested`. This issue is confined to copy and needs no new workflow.

### Final real-render verdict

**Approved: no remaining material product-simplification or newcomer-flow objections.**

Directly inspected capture 2's corrected desktop and 390 px running handoffs: they now consistently instruct the user to check the app, with request/configuration references still available and no instruction to restart running work. The reported-results order puts the actual request and Inspect evidence in native 200% view; saved file review/details remain separately named immediately below results. First-request review still precedes setup, with the exact selected example's prerequisite before creation. Visible private-setting definitions remain readable on phone, and the more detailed private-directory requirements remain in the independent disclosure.

Together with capture 1's first/custom setup, requested handoff, selected evidence, both final release dialogs and TypeScript/Python setup views, this resolves S1/S2 and the discovered running-copy issue. The result improves actual next-action discovery without redesigning the accepted editor, library or shell, adding fake status, changing app ownership, or weakening immutable evidence/manual-reason/recovery boundaries. Optional changed-entry count was correctly left out of scope.

The parent's final keyboard focus check is appropriate regression verification after request creation; it is not an unresolved product-design objection from this reviewer. No app edits made by this reviewer.
